// ipc.js - Inter-process communication handlers
// Groups and registers IPC handlers for electron main process

const {
  app,
  ipcMain,
  shell,
  clipboard,
  BrowserWindow,
  Notification,
  Menu,
  dialog,
  nativeTheme,
} = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsPromises = require("fs").promises;
const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { getLogger } = require("./logger");
const { getKonamiLogger } = require("./konami-logger");
const {
  unlockKonamiModelWithServiceAuth,
} = require("./konami-model-unlock");
const { getPrereqLogPath } = require("./prereq-logger");
const { getOAuthLogPath, logOAuth } = require("./oauth-logger");
const { formatOAuthCorrelation } = require("./oauth-correlation");
const {
  checkPersistedOAuthTokens,
  clearLegacyOAuthFiles,
  clearPersistedOAuthTokens,
  persistOAuthRecord,
} = require("./oauth-token-storage");
const {
  serverSupportsOAuth,
} = require("./guided-setup/server-requirements");
const { schedulePostToggleHealthSync } = require("./toggle-health-sync");
const { scheduleBulkToggleHealthSync } = require("./toggle-health-sync");
const { runToggleLifecycle } = require("./toggle-lifecycle-runner");
const { detectToggleLifecycleNoop } = require("./toggle-lifecycle-noop");
const { persistMcpToggleState } = require("./mcp-toggle-persistence");
const {
  buildSavedSecretUnavailableIssue,
  detectToggleEnablePreflightIssue,
  isConfigurationRequiredPreflightIssue,
  isSavedSecretUnavailableIssue,
} = require("./toggle-lifecycle-fast-fail");
const {
  invalidateMcpAggregatorCaches,
  refreshMcpControlPlane,
  regenerateMcpInfrastructure,
} = require("./mcp-infra-regeneration");
const {
  defaultMcpOperationManager,
} = require("./mcp-operation-manager");

// Some mutation-lease holders are legitimate transients that callers should
// absorb instead of failing busy. Two known windows:
// - Guided-setup finalize runs immediately after the last single-server stop,
//   whose lease can still be mid-release (a docker compose down holds it for
//   a few seconds).
// - Single-server start/stop can race the post-OAuth recovery restart
//   (api.js restartServerAndWaitReady, source "oauth-complete-recovery"),
//   which holds the lease across a docker restart plus a readiness wait
//   bounded by TOOL_READY_TIMEOUT_MS (30s) -- hit when a user authorizes
//   several OAuth servers back-to-back.
// Instead of failing on those transients, wait once -- event-driven, with a
// single one-shot leaf timeout per the ATLAS.md performance rules -- and
// retry the acquire exactly once. A second busy failure propagates exactly
// as before. The wait is a ceiling only: whenMutationIdle() resolves the
// instant the holder releases.
const GUIDED_SETUP_FINALIZE_LEASE_WAIT_MS = 10_000;
const SINGLE_SERVER_LEASE_WAIT_MS = 35_000;

// PORTICO-373: how long the debug collector waits for the container engine to answer
// before collecting a Docker-free bundle, and how long a collection may be
// in-flight before a fresh attempt is allowed to assume the previous one is stuck.
const DEBUG_DOCKER_PREFLIGHT_TIMEOUT_MS = 10_000;
const DEBUG_COLLECT_STUCK_AFTER_MS = 5 * 60_000;

async function acquireMcpMutationLeaseWithWait(details, { waitMs } = {}) {
  try {
    return defaultMcpOperationManager.acquireMutationLease(details);
  } catch (error) {
    if (error?.code !== "MCP_OPERATION_BUSY") throw error;
    console.warn(
      `[IPC] ${details.kind}: MCP mutation lease busy; waiting up to ${waitMs}ms for release`,
    );
    let timer = null;
    await Promise.race([
      defaultMcpOperationManager.whenMutationIdle(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return defaultMcpOperationManager.acquireMutationLease(details);
  }
}

async function acquireGuidedSetupFinalizeLease(details) {
  return acquireMcpMutationLeaseWithWait(details, {
    waitMs: GUIDED_SETUP_FINALIZE_LEASE_WAIT_MS,
  });
}
const {
  McpOperationCoordinator,
} = require("./mcp-operation-coordinator");
const {
  resolveMcpServerDisplayName,
} = require("./mcp-server-display-name");
const {
  registerMcpOperationCoordinator,
} = require("./mcp-operation-service");
const {
  McpReadinessScheduler,
  humanizeStartupFailureDetail,
  operationWaitTimeoutMs,
} = require("./mcp-readiness-scheduler");
const { ensureMcpOrcGeneratorCommand } = require("./mcp-orc-cli");
const {
  buildAggregatorInvalidationScope,
  groupDockerRuntimeTargets,
  normalizeServerIds,
} = require("./mcp-runtime-targets");
const {
  buildStartupFailureResult,
  ensureBulkResultsForRequested,
  extractAttributedServerFailure,
  normalizeErrorText,
} = require("./mcp-bulk-toggle-results");
const {
  clearStartupFailure,
  clearStartupFailures,
  overlayStartupFailures,
  recordStartupFailure,
} = require("./mcp-startup-failures");
const {
  buildForceRemoveContainerCommand,
  classifyDockerComposeFailure,
  probeDockerComposeFrontend,
  waitForDockerComposeFrontendReady,
} = require("./docker-compose-command");
const { createEnhancedEnv } = require("./env-paths");
const { createRuntimeShellEnv } = require("./runtime-shell-env");
const {
  restartHostMcpoWithFreshConfig,
} = require("./host-mcp-lifecycle");
const {
  loadCurrentSetupRequirement,
  markSetupRequirementCompleted,
  validateSetupCompletionPrerequisites,
} = require("./setup-completion");
const {
  readGuidedSetupPreferences,
  saveGuidedSetupPreferences,
} = require("./guided-setup-preferences");
const {
  writeProtectedRepositoryEnvAtomic,
} = require("./protected-operator-env");
const {
  buildUserQuestionSubmittedResult,
  buildUserQuestionDismissedResult,
  buildUserQuestionErrorResult,
} = require("./user-question-flows");
const {
  buildSensitiveInfoSubmittedResult,
  buildSensitiveInfoDismissedResult,
  buildSensitiveInfoErrorResult,
} = require("./sensitive-info-flows");
const {
  buildGuidedSetupCompletionResult,
} = require("./guided-setup-outcome");
const {
  readOwuiSidebarPreferences,
  saveOwuiSidebarPreferences,
} = require("./owui-sidebar-preferences");
const {
  getOwuiUiCalloutImpressions,
  incrementOwuiUiCalloutCounter,
} = require("./owui-ui-callouts");
const {
  resolveMarketplaceAutoApprove,
  saveMarketplaceAutoApprovePreferences,
} = require("./marketplace-auto-approve");
const { formatHostLogEntries, getMcpServerLogs } = require("./mcp-server-logs");
const { classifyStartupLogText } = require("./mcp-startup-classifier");
const { deleteUserMcpServer } = require("./mcp-server-delete");
const { isServerEffectivelyEnabled } = require("./readiness-policy");
const {
  CANONICAL_SINGLE_STACK_CALLBACK_PORT,
  selectSingleServerCallbackPort,
} = require("./single-server-port-policy");
const {
  COMPONENT_BRIDGE,
  COMPONENT_HOST_MCPO,
  buildKnownProcessGroups,
  classifyCallbackPortOwners,
  ensureReservedCallbackPortAvailable,
  formatCallbackPortOwners,
  inspectCallbackPortOwners,
} = require("./single-server-callback-port");
const {
  waitForSingleServerListeners,
} = require("./single-server-startup");
const {
  cleanupOrphanedSingleServerStack,
} = require("./single-server-stack-lifecycle");
const currentUser = require("./current-user");
const {
  writeCanonicalIdentityEnv,
} = require("./identity-env");
const gitlabMarketplaceAuth = require("./gitlab-marketplace-auth");
const marketplaceService = require("./marketplace-service");
const agentSkillUsageGuard = require("./agent-skill-usage-guard");

// One opportunistic seedMigrations agent-relink sweep per launch, armed by
// the first successful agent-inventory read (the subagents server is only up
// once the MCP stack is healthy — startup itself is too early). Fire-and-
// forget, no timers; a sweep that could not reach the inventory re-arms so a
// later cycle retries.
let startupAgentRelinkSweepDone = false;
let startupAgentRelinkSweepRunning = false;
function maybeRunStartupAgentRelinkSweep() {
  if (startupAgentRelinkSweepDone || startupAgentRelinkSweepRunning) return;
  startupAgentRelinkSweepRunning = true;
  void require("./agent-skill-relink")
    .runAgentSkillRelinkSweep({
      projectRoot: bootstrap.PROJECT_ROOT,
      logger: console,
    })
    .then((summary) => {
      if (summary?.flagsReconciled) {
        startupAgentRelinkSweepDone = true;
      }
    })
    .catch((error) => {
      console.warn(
        `[AgentRelink] Startup sweep failed; will retry on a later cycle: ${error.message}`,
      );
    })
    .finally(() => {
      startupAgentRelinkSweepRunning = false;
    });
}

// Agent-link adoption sweep (State & Persistence): restores LOST sidecar
// links for installed foreign-owned agents (2026-08-08 access-flap incident).
// No timers — piggybacked once per launch on the first agent-inventory-shaped
// IPC, and re-armed (force) when an access repair actually restores grants,
// i.e. the exact moment previously invisible agents reappear.
let agentAdoptionSweepDone = false;
let agentAdoptionSweepRunning = false;
function maybeRunAgentLinkAdoptionSweep({ force = false } = {}) {
  if (agentAdoptionSweepRunning || (agentAdoptionSweepDone && !force)) return;
  agentAdoptionSweepRunning = true;
  void require("./ai-marketplace-agent-adoption")
    .runAgentLinkAdoptionSweep()
    .then((summary) => {
      if (summary?.completed) {
        agentAdoptionSweepDone = true;
      }
    })
    .catch((error) => {
      console.warn(
        `[Marketplace][links] adoption sweep failed; will retry on a later cycle: ${error.message}`,
      );
    })
    .finally(() => {
      agentAdoptionSweepRunning = false;
    });
}
const {
  formatSkillDisplayName,
  parseSkillDirectoryMetadata,
} = require("./skill-frontmatter");
const userSkillService = require("./user-skill-service");
const userSkillReconciliation = require("./user-skill-reconciliation");
const setupAuth = require("./setup-auth");
const {
  buildWorkspaceFileUrl,
  collapseHomePath,
  ensureChatWorkspaceDirectories,
  getChatWorkspaceSelection,
  moveChatWorkspaceSelection,
  resolveCanonicalChatWorkspacePath,
  resolveChatWorkspaceEntryPath,
} = require("./chat-workspaces");
const {
  applyChatWorkspaceSelection,
  validateAndApplyChatWorkspaceSelection,
} = require("./chat-workspace-application");
const {
  buildChatWorkspaceConsentAppliedResult,
  buildChatWorkspaceConsentDismissedResult,
  buildChatWorkspaceConsentErrorResult,
} = require("./chat-workspace-consent-flows");
const {
  buildMarketplacePublishApprovedResult,
  buildMarketplacePublishDeniedResult,
  buildMarketplacePublishErrorResult,
  buildMarketplacePublishFailedResult,
  buildMarketplacePublishPublishedResult,
  marketplacePublishDecisionFromResult,
} = require("./marketplace-publish-confirm-flows");
const {
  findOwuiViewForChatId,
} = require("./chat-modal-routing");
const {
  ensureBundledMarketplaceDefaults,
} = require("./marketplace-ootb");
const {
  reconcileChatAgentVmWorkspaceBinds,
  validateWorkspaceBind,
} = require("./agent-vm-workspace-rebind");
const {
  getKonamiFlagPath,
  getManagedKonamiMirrorPath,
  readKonamiUnlocked,
  persistKonamiUnlocked,
  clearKonamiUnlocked,
  syncKonamiManagedMirror,
} = require("./konami-unlock");
const { parseHostModeValue, readHostModeFile } = require("./host-mode-state");
const {
  buildRuntimeDiagnosticsText,
} = require("./app-runtime-diagnostics");
const {
  openHttpExternalUrl,
  openLocalPath,
  validateProbeUrl,
} = require("./shell-open");
const {
  publishArtifactToPrototypes,
} = require("./artifact-publisher");
const {
  configureMcpClients,
  detectMcpClients,
  DEFAULT_BRIDGE_URL,
  removeMcpClientConfigs,
  revealMcpClientConfig,
  sanitizeConfigError,
} = require("./host-mcp-bridge-auto-config");
const {
  getBridgeAuthRedactedStatus,
} = require("./host-mcp-bridge-auth");
const {
  buildBridgeErrorTelemetry,
  classifyBridgeError,
  emitBridgeClientResultEvents,
  emitBridgeLogRepoEvent,
  summarizeBridgeClientInventory,
  summarizeBridgeClientResults,
} = require("./host-mcp-bridge-telemetry");

function logHostMcpBridgeConfigError(stage, error, requestId) {
  const safeError = sanitizeConfigError(error);
  const errorCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
    ? error.code
    : null;
  console.error("[Host MCP Bridge Config] operation failed", JSON.stringify({
    stage,
    requestId,
    errorCategory: classifyBridgeError(safeError),
    errorCode,
    error: safeError,
  }));
  return safeError;
}

// Import shared state
const state = require("./shared-state");
const { configData, dismissedOAuthFlows } = state;

// Import bootstrap utilities
const bootstrap = require("./bootstrap");
const {
  getConfigPath,
  getLogPaths,
  execPromise,
  clearWebviewCache,
  sendInitLog,
  getThemeIcon,
  updateWindowMenu,
} = bootstrap;

// PROJECT_ROOT and SCRIPTS_DIR are accessed dynamically via bootstrap.*
// because they're initialized after module load

function createMcpRuntimeEnv(overrides = {}) {
  return createRuntimeShellEnv({
    baseEnv: process.env,
    overrides: {
      PROJECT_ROOT: bootstrap.PROJECT_ROOT,
      ...overrides,
    },
    isPackagedApp: app.isPackaged === true,
    resourcesPath: process.resourcesPath,
  });
}

function recordOAuthCorrelation(payload) {
  try {
    const message = formatOAuthCorrelation(payload);
    logOAuth("Electron", "INFO", message);
    console.log(`[OAuth Correlation] ${message}`);
    return true;
  } catch (error) {
    console.warn(
      `[OAuth Correlation] Rejected invalid correlation event: ${error.message}`,
    );
    return false;
  }
}

function currentAppVersion() {
  try {
    return typeof app.getVersion === "function" ? app.getVersion() : "";
  } catch (_) {
    return "";
  }
}

function bridgeUiTelemetryFields(extra = {}) {
  return {
    event_scope: "summary",
    request_source: "portico_ui",
    caller: "portico_ui",
    app_version: currentAppVersion(),
    bridge_port: state.hostMcpBridge.port,
    ...extra,
  };
}

// Import docker-mcp functions
const dockerMcp = require("./docker-mcp");
// PORTICO-443: renders the address-space snapshot into the debug bundle.
const { formatAddressSpaceReport } = require("./address-space-telemetry");
const {
  parseYaml,
  checkServerConfigured,
  startContinuousHealthChecks,
  stopContinuousHealthChecks,
  getLastHealthStatus,
  getHealthSyncState,
  checkDockerStatus,
  startHostMcpo,
  stopHostMcpo,
  startHostMcpBridge,
  ensureHostMcpBridgeReady,
  stopHostMcpBridge,
  readHostMcpBridgePreferences,
  setHostMcpBridgeDesiredEnabled,
  checkSingleServerHealth,
  isHostDeployedServer,
  isCoreServer,
  isKnownMcpServerId,
  runMcpInitialization,
  runHealthCheckAndBroadcast,
  queueFullHealthCheck,
  computeEffectiveMcpToggles,
  normalizeAndPersistMcpToggles,
  loadRawMcpToggles,
  mutateMcpToggles,
  setMcpToggles,
  restartMcpoServer,
  restartMcpoServers,
} = dockerMcp;

function recordAndPublishStartupFailure(failure, options = {}) {
  const recorded = recordStartupFailure(bootstrap.PROJECT_ROOT, failure, {
    logger: options.logger || console,
  });
  if (typeof dockerMcp.publishStartupFailureState === "function") {
    dockerMcp.publishStartupFailureState(recorded, {
      reason: options.reason || `startup-failure:${recorded.serverId}`,
    });
  }
  return recorded;
}

// Import diagnostic collector
const { collectDiagnosticSnapshot } = require('./diagnostic-collector');
const { safeWebContentsSend } = require('./webcontents-safe');

// Import diagnostic store and ID generator
const { saveDiagnosticReport, getDiagnosticsDir } = require('./diagnostic-store');
const { generateReferenceId } = require('./diagnostic-id');

// Import windows functions
const windows = require("./windows");
const {
  resetConfigData,
  createConversationWindow,
  focusConversationWindowIfOpen,
  setDetachedConversationWindowTitle,
  closeMainWindow,
  showMcpTooltip,
  hideMcpTooltip,
  showUpdatePrepTooltip,
  hideUpdatePrepTooltip,
  showArtifactVersionMenu,
  hideArtifactVersionMenu,
  syncArtifactDividerOverlay,
  hideArtifactDividerOverlay,
  forwardArtifactDividerOverlayHover,
  beginArtifactDividerDrag,
  updateArtifactDividerDrag,
  finishArtifactDividerDrag,
  syncLocalFindOverlay,
  hideLocalFindOverlay,
  getLocalFindOverlayOwnerWindow,
} = windows;
const artifactViews = require("./artifact-views");
const owuiViews = require("./owui-views");

function broadcastNativeInputPresentationSnapshot(ownerWindowId) {
  if (!Number.isFinite(Number(ownerWindowId))) {
    return;
  }
  owuiViews.broadcastToOwnerViews(
    Number(ownerWindowId),
    "owui-native-input-presentation-snapshot",
    state.buildNativeInputPresentationSnapshot(Number(ownerWindowId)),
  );
}

function notifyNativeInputTerminal(ownerWindowId, kind, flowId, status) {
  if (!Number.isFinite(Number(ownerWindowId))) {
    return;
  }
  const ownerWindow = BrowserWindow.fromId(Number(ownerWindowId));
  if (!ownerWindow || ownerWindow.isDestroyed()) {
    return;
  }
  ownerWindow.webContents.send("native-input-terminal", {
    kind,
    flow_id: flowId,
    status: typeof status === "string" && status.trim() ? status.trim() : "completed",
  });
}

function getUsableBrowserWindow(windowRef) {
  return windowRef && !windowRef.isDestroyed() ? windowRef : null;
}

function revealBrowserWindow(windowRef) {
  const targetWindow = getUsableBrowserWindow(windowRef);
  if (!targetWindow) {
    return false;
  }
  try {
    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.show();
    app.focus?.({ steal: true });
    targetWindow.focus();
    return true;
  } catch (error) {
    console.warn("[Chat Navigation] Failed to reveal chat window:", error.message);
    return false;
  }
}

function activateChatConversation({
  chatId,
  messageId = null,
  title = "Chat",
  preferredWindow = null,
} = {}) {
  const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
  if (!normalizedChatId) {
    return { found: false, error: "Missing chat ID" };
  }

  const tabs = owuiViews.getOpenConversationTabs();
  const match = (tabs || []).find(
    (tab) => tab.conversationId === normalizedChatId,
  );
  if (!match) {
    const mainWindow = getUsableBrowserWindow(state.windows.main);
    const targetWindow = getUsableBrowserWindow(preferredWindow) || mainWindow;
    if (!targetWindow) {
      return { found: false };
    }

    const targetUrl = new URL(
      `/c/${encodeURIComponent(normalizedChatId)}`,
      owuiViews.OPEN_WEBUI_HOME_URL,
    );
    const normalizedMessageId =
      typeof messageId === "string" ? messageId.trim() : "";
    if (normalizedMessageId) {
      targetUrl.searchParams.set("portico-target-message", normalizedMessageId);
    }

    revealBrowserWindow(targetWindow);
    targetWindow.webContents.send(
      "open-conversation-tab",
      targetUrl.toString(),
      normalizedChatId,
      {
        title:
          typeof title === "string" && title.trim() ? title.trim() : "Chat",
        type: "chat",
        pendingMessageId: normalizedMessageId || null,
      },
    );
    return { found: true, windowId: targetWindow.id, opened: true };
  }

  const targetWindow = getUsableBrowserWindow(
    BrowserWindow.fromId(match.ownerWindowId),
  );
  if (!targetWindow) {
    return { found: false };
  }
  revealBrowserWindow(targetWindow);

  let switchTabName;
  if (!match.viewKey.startsWith("conversation:")) {
    switchTabName = "chat";
  } else {
    const tabId = match.viewKey.slice("conversation:".length);
    switchTabName = `conversation-${tabId}`;
  }
  targetWindow.webContents.send("switch-to-tab", switchTabName);
  owuiViews.sendToView(match.viewKey, "navigate-to-message", {
    chatId: normalizedChatId,
    messageId,
  });
  return { found: true, windowId: match.ownerWindowId };
}

let chatNativeNotificationService = null;

function isChatActiveInFocusedWindow(chatId) {
  const normalizedChatId =
    typeof chatId === "string" ? chatId.trim() : "";
  if (!normalizedChatId) {
    return false;
  }

  for (const tab of owuiViews.getOpenConversationTabs()) {
    if (tab.conversationId !== normalizedChatId) {
      continue;
    }
    const ownerWindow = getUsableBrowserWindow(
      BrowserWindow.fromId(Number(tab.ownerWindowId)),
    );
    const activeViewKey = ownerWindow
      ? owuiViews.getActiveViewKeyForWindow(ownerWindow.id)
      : null;
    if (
      ownerWindow?.isFocused() &&
      (tab.visible !== false || activeViewKey === tab.viewKey)
    ) {
      return true;
    }
  }
  return false;
}

function getChatNativeNotificationService() {
  if (chatNativeNotificationService) {
    return chatNativeNotificationService;
  }
  const notificationModule = require("./chat-native-notifications");
  if (
    typeof notificationModule?.createChatNativeNotificationService !== "function"
  ) {
    // A few isolated IPC unit harnesses intentionally replace unrelated
    // service modules with empty stubs. Keep those harnesses loadable without
    // weakening the real runtime, where this module is always present.
    return {
      show: () => ({ shown: false, error: "Notification service unavailable" }),
    };
  }
  chatNativeNotificationService =
    notificationModule.createChatNativeNotificationService({
      Notification,
      app,
      platform: process.platform,
      navigateToChat: ({ chatId, title }) =>
        activateChatConversation({ chatId, title }),
      resolveMcpServerDisplayName: (serverId) =>
        resolveMcpServerDisplayName(bootstrap.PROJECT_ROOT, serverId),
      isChatActive: (chatId) => isChatActiveInFocusedWindow(chatId),
      logger: console,
    });
  return chatNativeNotificationService;
}

// Import updates functions
const updates = require("./updates");
const { checkForUpdates } = updates;
const cloudsmithConfig = require("../config/cloudsmith-config");
const {
  DEFAULT_MANAGED_ROOT,
  getMcpSensitiveSecretPresence,
  listRuntimeWritableSecretKeys,
  resolveAiMarketplaceApiKey,
  resolveCloudsmithEntitlementToken,
  upsertRuntimeSecret,
} = require("../config/runtime-secrets-config");
const {
  scanOpenWebuiDbCorruption,
  repairOpenWebuiDb,
  rollbackOpenWebuiDbRepair,
} = require("./db-repair");
const {
  restoreOpenWebuiDbFromBackup,
} = require("./owui-data-integrity-guard");
const costReporting = require("./cost-reporting");

// Alias buildInfo from shared state
const buildInfo = state.buildInfo;

// Dependencies injected from main.js
let dependencies = {
  createMainWindow: null,
  createChatWindow: null,
  createLoadingWindow: null,
  createGuidedSetupWindow: null,
  stopStatusMonitoring: null,
  isFirstRun: null,
};

let mcpOperationCoordinator = null;
let unsubscribeMcpOperationBroadcast = null;
let newChatTabRequestSequence = 0;
const pendingNewChatTabRequests = new Map();
const NEW_CHAT_TAB_REQUEST_TIMEOUT_MS = 5000;

function normalizeNewChatTabOptions(options = {}) {
  return {
    modelId: typeof options?.modelId === "string" ? options.modelId.trim() : "",
    prompt: typeof options?.prompt === "string" ? options.prompt.trim() : "",
    title: typeof options?.title === "string" ? options.title.trim() : "",
  };
}

function settleNewChatTabRequest(requestId, result) {
  const pending = pendingNewChatTabRequests.get(requestId);
  if (!pending) {
    return false;
  }
  pendingNewChatTabRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(result);
  return true;
}

const TERMINAL_MCP_OPERATION_STATUSES = new Set([
  "succeeded",
  "attention_required",
  "partial",
  "failed",
  "interrupted",
]);

function operationRows(snapshot) {
  return Array.isArray(snapshot?.rows)
    ? snapshot.rows
    : Array.isArray(snapshot?.servers)
      ? snapshot.servers
      : [];
}

function buildLegacyResultFromOperation(snapshot) {
  const rows = operationRows(snapshot);
  const results = rows.map((row) => {
    const pending = row.terminal !== true;
    const readinessPhase = pending ? "starting" : row.outcome || row.phase;
    return {
      serverId: row.serverId || row.id,
      success:
        pending ||
        row.status === "succeeded" ||
        row.status === "attention_required",
      pending,
      healthy: row.healthy === true,
      readinessPhase,
      readiness_phase: readinessPhase,
      requiresConfiguration:
        row.outcome === "not_configured" || row.requiredAction === "configure",
      requiresAuthentication:
        row.outcome === "needs_oauth" || row.requiredAction === "authenticate",
      requiresSecretReplacement:
        row.requiresSecretReplacement === true ||
        row.requiredAction === "replace_saved_secret",
      configurationIssue: row.configurationIssue || null,
      requiredAction: row.requiredAction || null,
      recoveryPrompt: row.recoveryPrompt || null,
      recoveryLabel: row.recoveryLabel || null,
      uiStatus: readinessPhase,
      errorCode: row.configurationErrorCode || row.error?.code || null,
      error:
        row.error?.message || row.error || row.configurationMessage || null,
    };
  });
  const errors = results
    .filter((entry) => entry.success === false)
    .map((entry) => `${entry.serverId}: ${entry.error || "Operation failed"}`);
  return {
    success: ["succeeded", "attention_required"].includes(snapshot?.status),
    operationId: snapshot?.operationId || null,
    operation: snapshot,
    results,
    errors,
    error: errors[0] || null,
  };
}

function waitForMcpOperation(operationId, timeoutMs = null) {
  const current = defaultMcpOperationManager.getMcpOperation(operationId);
  if (!current) {
    return Promise.reject(new Error(`MCP operation ${operationId} was not found`));
  }
  if (
    TERMINAL_MCP_OPERATION_STATUSES.has(current.status) &&
    current.effectsFinalized !== false
  ) {
    return Promise.resolve(current);
  }
  const resolvedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, timeoutMs)
    : operationWaitTimeoutMs(current);
  return new Promise((resolve, reject) => {
    let timer = null;
    const unsubscribe = defaultMcpOperationManager.onMcpOperationUpdated(
      (snapshot) => {
        if (
          snapshot?.operationId !== operationId ||
          !TERMINAL_MCP_OPERATION_STATUSES.has(snapshot.status) ||
          snapshot.effectsFinalized === false
        ) {
          return;
        }
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(snapshot);
      },
    );
    timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for MCP operation ${operationId}`));
    }, resolvedTimeoutMs);
  });
}

async function startAndWaitForMcpOperation(request) {
  if (!mcpOperationCoordinator) {
    throw new Error("MCP operation coordinator is not initialized");
  }
  const started = mcpOperationCoordinator.start(request);
  return buildLegacyResultFromOperation(
    await waitForMcpOperation(started.operationId),
  );
}

function createDebouncedReadyInvalidator(invalidate, options = {}) {
  if (typeof invalidate !== "function") {
    throw new TypeError("invalidate must be a function");
  }
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 250;
  const logger = options.logger || console;
  const pendingServerIds = new Set();
  let timer = null;
  let inFlight = Promise.resolve();

  const drain = () => {
    if (pendingServerIds.size === 0) return inFlight;
    const serverIds = [...pendingServerIds];
    pendingServerIds.clear();
    inFlight = inFlight
      .then(() => invalidate(serverIds))
      .catch((error) => {
        logger.warn?.(
          `[MCP Operation] Ready-cache invalidation degraded: ${error.message}`,
        );
      });
    return inFlight;
  };

  return {
    enqueue(serverIds) {
      for (const serverId of serverIds || []) {
        if (serverId) pendingServerIds.add(serverId);
      }
      if (pendingServerIds.size > 0 && !timer) {
        timer = setTimeout(() => {
          timer = null;
          void drain();
        }, delayMs);
      }
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await drain();
      await inFlight;
    },
  };
}

const DETACHED_CONVERSATION_ATTACH_TIMEOUT_MS = 8000;
const localFindOverlayFallbackState = new Map();
const OWUI_LOCAL_FIND_HISTORY_REQUEST_EVENT = 'portico-local-find-history-request';
const OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT = 'portico-local-find-history-response';
let localFindOverlayHistoryRequestSequence = 0;

// Track the active single-server stack ports (dynamic to avoid conflicts)
let singleServerStackPorts = {
  hostPort: 8770,
  callbackPort: 3836,
};
let singleServerSession = null;
// Tracks the active single-server OAuth *bootstrap* session. In bootstrap mode
// the single-server stack runs without the OAuth access-token broker so a
// not-yet-authorized server can complete a first-time/interactive handshake;
// the captured record is then exported (guarded by exportToken) and imported
// into host safeStorage. The single-server stack is a singleton (fixed compose
// project / nginx), so only one bootstrap session is valid at a time.
let singleServerBootstrap = null;
let singleServerComposeRecoveryAttempted = false;
let globalOwuiDebugModeEnabled = false;
const KONAMI_UNLOCK_MODEL_ID = "GPT-5.6 Sol Pro";
const KONAMI_RECONCILE_MAX_ATTEMPTS = 20;
const KONAMI_RECONCILE_RETRY_DELAY_MS = 100;
const TERMINAL_RECOVERY_COMMAND_MAX_BYTES = 64 * 1024;
const TERMINAL_RECOVERY_DONE_MESSAGE = "All done. You may now close this terminal window.";
const MACOS_TERMINAL_APP_PATHS = [
  "/System/Applications/Utilities/Terminal.app",
  "/Applications/Utilities/Terminal.app",
];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildTerminalRecoveryRunnerScript(commandText, tempDir, doneMessagePath) {
  return [
    "#!/bin/bash",
    "set -e",
    `DONE_MESSAGE_FILE=${shellQuote(doneMessagePath)}`,
    `RECOVERY_TMP_DIR=${shellQuote(tempDir)}`,
    "cleanup() {",
    "  rm -rf \"$RECOVERY_TMP_DIR\" 2>/dev/null || true",
    "}",
    "trap cleanup EXIT",
    "",
    commandText,
    "",
    "printf '\\n'",
    "cat \"$DONE_MESSAGE_FILE\"",
    "printf '\\n'",
    "",
  ].join("\n");
}

async function cleanupTerminalRecoveryRunner(runner) {
  if (!runner?.tempDir) {
    return;
  }
  try {
    await fsPromises.rm(runner.tempDir, { recursive: true, force: true });
  } catch (_error) {
    // Best-effort cleanup only; a copied fallback command may still need the temp files.
  }
}

async function createTerminalRecoveryRunner(commandText, options = {}) {
  const tempRoot = options.tempRoot || os.tmpdir();
  const tempDir = await fsPromises.mkdtemp(path.join(tempRoot, "portico-setup-"));
  const runScriptPath = path.join(tempDir, "run.command");
  const doneMessagePath = path.join(tempDir, "done.txt");

  try {
    await fsPromises.writeFile(doneMessagePath, `${TERMINAL_RECOVERY_DONE_MESSAGE}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsPromises.writeFile(
      runScriptPath,
      buildTerminalRecoveryRunnerScript(commandText, tempDir, doneMessagePath),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );
  } catch (error) {
    await cleanupTerminalRecoveryRunner({ tempDir });
    throw error;
  }

  return {
    tempDir,
    runScriptPath,
    doneMessagePath,
    terminalCommand: `/bin/bash ${shellQuote(runScriptPath)}`,
  };
}

function getSafeTerminalRecoveryErrorCode(error) {
  const errorCode = typeof error?.code === "string" ? error.code : "";
  return /^[A-Za-z0-9_-]{1,32}$/.test(errorCode) ? errorCode : null;
}

function runTerminalCommandFile(runScriptPath, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const openPath = options.openPath || "/usr/bin/open";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawnImpl(openPath, ["-b", "com.apple.Terminal", runScriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const errorCode = getSafeTerminalRecoveryErrorCode(error);
      finish({
        success: false,
        error: errorCode
          ? `Terminal command launcher failed (${errorCode}).`
          : "Terminal command launcher failed.",
        reason: errorCode ? `spawn_${errorCode.toLowerCase()}` : "spawn_failed",
      });
      return;
    }

    if (!child || typeof child.on !== "function") {
      finish({
        success: false,
        error: "Terminal command launcher could not be started.",
        reason: "spawn_unavailable",
      });
      return;
    }

    child.on("error", (error) => {
      const errorCode = getSafeTerminalRecoveryErrorCode(error);
      finish({
        success: false,
        error: errorCode
          ? `Terminal command launcher failed (${errorCode}).`
          : "Terminal command launcher failed.",
        reason: errorCode ? `spawn_${errorCode.toLowerCase()}` : "spawn_failed",
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ success: true });
        return;
      }

      const safeExitCode = Number.isInteger(code) ? code : "unknown";
      finish({
        success: false,
        error: `Terminal command launcher exited with code ${safeExitCode}.`,
        reason: `exit_${safeExitCode}`,
      });
    });
  });
}

function logTerminalRecoveryLaunch(method, result, reason = "") {
  const reasonSuffix = reason ? ` reason=${reason}` : "";
  const message = `[TerminalRecovery] method=${method} result=${result}${reasonSuffix}`;
  if (result === "accepted") {
    console.info(message);
  } else {
    console.warn(message);
  }
}

async function openTerminalWithCopiedCommand(command, options = {}) {
  const commandText = typeof command === "string" ? command : "";
  if (!commandText.trim()) {
    return { success: false, error: "Missing Terminal command." };
  }

  if (Buffer.byteLength(commandText, "utf8") > TERMINAL_RECOVERY_COMMAND_MAX_BYTES) {
    return { success: false, error: "Terminal command is too large to copy safely." };
  }

  const clipboardApi = options.clipboard || clipboard;
  const shellApi = options.shell || shell;
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;

  if (platform !== "darwin") {
    try {
      clipboardApi.writeText(commandText);
    } catch (error) {
      return { success: false, error: `Failed to copy Terminal command: ${error.message}` };
    }
    return {
      success: false,
      copied: true,
      terminalOpened: false,
      error: "Opening Terminal is only supported on macOS.",
    };
  }

  let runner;
  try {
    runner = await createTerminalRecoveryRunner(commandText, options);
  } catch (error) {
    return { success: false, error: `Failed to prepare Terminal command: ${error.message}` };
  }

  try {
    clipboardApi.writeText(runner.terminalCommand);
  } catch (error) {
    await cleanupTerminalRecoveryRunner(runner);
    return { success: false, error: `Failed to copy Terminal command: ${error.message}` };
  }

  let lastOpenError = "";
  let lastFailureReason = "";
  const commandFileResult = await runTerminalCommandFile(runner.runScriptPath, options);
  if (commandFileResult.success) {
    logTerminalRecoveryLaunch("launchservices-command-file", "accepted");
    return {
      success: true,
      copied: true,
      terminalOpened: true,
      commandStarted: true,
    };
  }
  lastOpenError = commandFileResult.error || "Terminal command launcher failed.";
  lastFailureReason = commandFileResult.reason || "command_file_launch_failed";
  logTerminalRecoveryLaunch(
    "launchservices-command-file",
    "failed",
    lastFailureReason,
  );

  if (typeof shellApi.openPath === "function") {
    for (const terminalPath of MACOS_TERMINAL_APP_PATHS) {
      if (!existsSync(terminalPath)) {
        continue;
      }

      try {
        const openError = await shellApi.openPath(terminalPath);
        if (!openError) {
          logTerminalRecoveryLaunch(
            "terminal-app-fallback",
            "accepted",
            lastFailureReason,
          );
          return {
            success: true,
            copied: true,
            terminalOpened: true,
            commandStarted: false,
            terminalPath,
            fallbackReason: lastOpenError || undefined,
          };
        }
        lastOpenError = "Terminal.app could not be opened.";
        lastFailureReason = "terminal_app_open_failed";
      } catch (error) {
        lastOpenError = "Terminal.app could not be opened.";
        const errorCode = getSafeTerminalRecoveryErrorCode(error);
        lastFailureReason = errorCode
          ? `terminal_app_${errorCode.toLowerCase()}`
          : "terminal_app_open_failed";
      }
    }
  }

  if (typeof shellApi.openExternal === "function") {
    try {
      await shellApi.openExternal("file:///System/Applications/Utilities/Terminal.app");
      logTerminalRecoveryLaunch(
        "terminal-app-url-fallback",
        "accepted",
        lastFailureReason,
      );
      return {
        success: true,
        copied: true,
        terminalOpened: true,
        commandStarted: false,
        terminalPath: "/System/Applications/Utilities/Terminal.app",
        fallbackReason: lastOpenError || undefined,
      };
    } catch (error) {
      lastOpenError = "Terminal.app could not be opened.";
      const errorCode = getSafeTerminalRecoveryErrorCode(error);
      lastFailureReason = errorCode
        ? `terminal_app_${errorCode.toLowerCase()}`
        : "terminal_app_open_failed";
    }
  }

  logTerminalRecoveryLaunch(
    "terminal-app-fallback",
    "failed",
    lastFailureReason || "terminal_app_not_found",
  );

  return {
    success: false,
    copied: true,
    terminalOpened: false,
    commandStarted: false,
    error: lastOpenError
      ? `Copied command, but failed to open Terminal: ${lastOpenError}`
      : "Copied command, but Terminal.app was not found.",
  };
}

function normalizeKonamiError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "object") {
    return error;
  }

  return { message: String(error) };
}

function createKonamiReconcileError(result = {}, fallbackMessage = "Konami unlock failed") {
  const error = new Error(result?.error || fallbackMessage);
  const code =
    typeof result?.code === "string" && result.code.trim() !== ""
      ? result.code.trim()
      : null;
  const status =
    Number.isFinite(Number(result?.status)) ? Number(result.status) : null;

  if (code) {
    error.konamiCode = code;
  }
  if (status !== null) {
    error.konamiStatus = status;
  }

  return error;
}

function getKonamiFailureInfo(error) {
  const message =
    typeof error?.message === "string" && error.message.trim() !== ""
      ? error.message
      : error == null
        ? ""
        : String(error);
  const codeCandidate = error?.konamiCode ?? error?.code ?? null;
  const code =
    typeof codeCandidate === "string" && codeCandidate.trim() !== ""
      ? codeCandidate.trim()
      : null;
  const statusCandidate = error?.konamiStatus ?? error?.status ?? null;
  const status =
    statusCandidate !== null &&
    statusCandidate !== undefined &&
    Number.isFinite(Number(statusCandidate))
      ? Number(statusCandidate)
      : null;

  return {
    message,
    code,
    status,
  };
}

function isKonamiStartupTransientFailure(error) {
  const { message, code, status } = getKonamiFailureInfo(error);

  return (
    code === "missing-token" ||
    code === "missing-bridge-secret" ||
    code === "missing-service-token" ||
    code === "owui-unavailable" ||
    (code === "service-token-failed" && [401, 503].includes(status)) ||
    message === "No OWUI view available for Konami unlock" ||
    message.startsWith("Unknown OWUI view:")
  );
}

function resolveKonamiStartupHydrationFailure(error) {
  const failure = getKonamiFailureInfo(error);
  const transient = isKonamiStartupTransientFailure(failure);

  return {
    ...failure,
    transient,
    surfacedError: transient ? null : failure.message || null,
  };
}

function logKonamiMain(layer, level, message, meta = {}) {
  const normalizedMessage =
    typeof message === "string"
      ? message.replace(/^\[Konami:[^\]]+\]\s*/, "")
      : String(message || "");
  const logger = getKonamiLogger();
  if (logger && typeof logger.log === "function") {
    logger.log(layer, level, normalizedMessage, meta);
  }

  const formatted = meta && Object.keys(meta).length > 0
    ? `${normalizedMessage} ${JSON.stringify(meta)}`
    : normalizedMessage;

  if (level === "error") {
    console.error(`[Konami:${layer}] ${formatted}`);
  } else if (level === "warn") {
    console.warn(`[Konami:${layer}] ${formatted}`);
  } else {
    console.info(`[Konami:${layer}] ${formatted}`);
  }
}

function getKonamiPathMetadata(context = {}) {
  const flagPath = getKonamiFlagPath(context.userDataPath);
  const mirrorPath = context.projectRoot
    ? getManagedKonamiMirrorPath(context.projectRoot)
    : null;

  return {
    flagPath,
    mirrorPath,
    flagExists: fs.existsSync(flagPath),
    mirrorExists: mirrorPath ? fs.existsSync(mirrorPath) : false,
  };
}

function resolveOwuiOwnerWindowIdFromSender(sender) {
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    return ownerWindow.id;
  }

  const viewKey = owuiViews.getViewKeyForContents(sender);
  if (!viewKey) {
    return null;
  }

  const viewState = owuiViews.getViewState(viewKey);
  return viewState?.ownerWindowId ?? null;
}

function getLocalFindOverlayFallbackSession(ownerWindowId) {
  const normalizedWindowId = Number(ownerWindowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return null;
  }

  if (!localFindOverlayFallbackState.has(normalizedWindowId)) {
    localFindOverlayFallbackState.set(normalizedWindowId, {
      query: '',
      caseSensitive: false,
    });
  }

  return localFindOverlayFallbackState.get(normalizedWindowId);
}

function clearLocalFindOverlayFallbackSession(ownerWindowId) {
  const normalizedWindowId = Number(ownerWindowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return;
  }
  localFindOverlayFallbackState.delete(normalizedWindowId);
}

async function requestLocalFindOverlayHistoryExpansion(
  ownerWindowId,
  query,
  caseSensitive,
  direction,
) {
  const normalizedWindowId = Number(ownerWindowId);
  if (!Number.isFinite(normalizedWindowId) || !query) {
    return false;
  }

  const viewKey = owuiViews.getActiveViewKeyForWindow(normalizedWindowId);
  if (!viewKey) {
    return false;
  }

  localFindOverlayHistoryRequestSequence += 1;
  const detail = {
    requestId: `ipc-local-find-${Date.now()}-${localFindOverlayHistoryRequestSequence}`,
    query,
    caseSensitive: caseSensitive === true,
    direction: direction === 'backward' ? 'backward' : 'forward',
  };

  const script = `(() => new Promise((resolve) => {
    const detail = ${JSON.stringify(detail)};
    let settled = false;
    let safetyTimer = null;

    const cleanup = () => {
      if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
      window.removeEventListener(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT)}, onResponse);
    };

    const onResponse = (event) => {
      if ((event?.detail?.requestId || '') !== detail.requestId) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Boolean(event?.detail?.expanded));
    };

    window.addEventListener(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT)}, onResponse);
    window.dispatchEvent(
      new CustomEvent(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_REQUEST_EVENT)}, {
        detail,
      }),
    );

    if (!settled) {
      safetyTimer = setTimeout(() => {
        safetyTimer = null;
        if (settled) { return; }
        cleanup();
        resolve(false);
      }, 5000);
    }
  }))()`;

  try {
    const expanded = await owuiViews.executeJavaScript(viewKey, script);
    return expanded === true;
  } catch (_error) {
    return false;
  }
}

async function expandAndFindInPage(ownerWindowId, query, caseSensitive, direction, findOptions) {
  await requestLocalFindOverlayHistoryExpansion(
    ownerWindowId,
    query,
    caseSensitive,
    direction,
  );
  owuiViews.findInPage(query, findOptions, ownerWindowId);
}

function handleLocalFindOverlayFallbackEvent(ownerWindow, payload = {}) {
  if (!ownerWindow || ownerWindow.isDestroyed()) {
    return;
  }

  const ownerWindowId = Number(ownerWindow.id);
  if (!Number.isFinite(ownerWindowId)) {
    return;
  }

  const type = payload?.type;
  if (!type) {
    return;
  }

  const session = getLocalFindOverlayFallbackSession(ownerWindowId);
  if (!session) {
    return;
  }

  if (type === 'query-change') {
    session.query = typeof payload.query === 'string' ? payload.query : '';
    if (!session.query) {
      owuiViews.stopFindInPage('clearSelection', ownerWindowId);
      return;
    }
    void expandAndFindInPage(
      ownerWindowId,
      session.query,
      session.caseSensitive,
      'forward',
      { matchCase: session.caseSensitive, findNext: true },
    );
    return;
  }

  if (type === 'toggle-case') {
    session.caseSensitive = !session.caseSensitive;
    if (session.query) {
      void expandAndFindInPage(
        ownerWindowId,
        session.query,
        session.caseSensitive,
        'forward',
        { matchCase: session.caseSensitive, findNext: true },
      );
    }
    return;
  }

  if (type === 'next' || type === 'prev') {
    if (!session.query) {
      return;
    }
    const forward = type === 'next';
    void expandAndFindInPage(
      ownerWindowId,
      session.query,
      session.caseSensitive,
      forward ? 'forward' : 'backward',
      { matchCase: session.caseSensitive, findNext: false, forward },
    );
    return;
  }

  if (type === 'close') {
    owuiViews.stopFindInPage('clearSelection', ownerWindowId);
    hideLocalFindOverlay({
      ownerWindowId,
      destroy: true,
      notifyOwner: false,
      reason: payload?.reason || 'dismiss',
    });
    clearLocalFindOverlayFallbackSession(ownerWindowId);
    return;
  }

  if (type === 'release-focus') {
    // PORTICO PATCH: only treat overlay blur as a dismissal when the focus
    // moved to something inside our own app (browser-like contract: clicking
    // chat content closes the find bar). When focus left to ANOTHER app
    // entirely (Cmd+Tab, click on another window), destroying the overlay
    // here competes with macOS's focus transfer and ends up swallowing the
    // user's keypress / click — the bar closes but the OS-level switch
    // doesn't take effect on the first try. In that case, only notify the
    // find-bar (which will _setRetainFocus(false) and stay visible).
    const ownerStillFocused =
      ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isFocused();
    if (!ownerStillFocused) {
      // Bare-bones notify: skip the destroy + stopFindInPage path entirely.
      // The find-bar already gets the 'release-focus' event via
      // sendLocalFindOverlayOwnerEvent below the switch — we don't need to
      // do anything else here.
      return;
    }
    owuiViews.stopFindInPage('clearSelection', ownerWindowId);
    hideLocalFindOverlay({
      ownerWindowId,
      destroy: true,
      notifyOwner: false,
      reason: payload?.reason || 'overlay-blur',
    });
    clearLocalFindOverlayFallbackSession(ownerWindowId);
  }
}

function broadcastOwuiDebugModeChanged(enabled) {
  const payload = { enabled: Boolean(enabled) };

  try {
    owuiViews.broadcastToViews("owui-debug-mode-changed", payload);
  } catch (error) {
    console.warn("[OWUI] Failed to broadcast debug mode to OWUI views:", error);
  }

  for (const windowRef of BrowserWindow.getAllWindows()) {
    try {
      if (!windowRef?.isDestroyed() && !windowRef.webContents?.isDestroyed()) {
        windowRef.webContents.send("owui-debug-mode-changed", payload);
      }
    } catch (error) {
      console.warn("[OWUI] Failed to broadcast debug mode to renderer window:", error);
    }
  }
}

function getKonamiRuntimeContext() {
  return {
    userDataPath: app.getPath("userData"),
    projectRoot: state.PROJECT_ROOT || bootstrap.PROJECT_ROOT || null,
  };
}

function syncAndReadKonamiUnlocked() {
  const context = getKonamiRuntimeContext();
  const beforePaths = getKonamiPathMetadata(context);
  const unlocked = readKonamiUnlocked(context);
  syncKonamiManagedMirror(context);
  state.appState.konamiUnlocked = unlocked;
  const afterPaths = getKonamiPathMetadata(context);

  logKonamiMain("Main", "info", "Synced persisted Konami state", {
    phase: "persisted-state-sync",
    unlocked,
    userDataPath: context.userDataPath,
    projectRoot: context.projectRoot,
    flagPath: beforePaths.flagPath,
    mirrorPath: beforePaths.mirrorPath,
    flagExistsBefore: beforePaths.flagExists,
    mirrorExistsBefore: beforePaths.mirrorExists,
    flagExistsAfter: afterPaths.flagExists,
    mirrorExistsAfter: afterPaths.mirrorExists,
  });

  return {
    ...context,
    unlocked,
    flagPath: beforePaths.flagPath,
    mirrorPath: beforePaths.mirrorPath,
  };
}

function persistKonamiDesiredState(context) {
  const flagPath = persistKonamiUnlocked(context);
  try {
    const mirrorPath = syncKonamiManagedMirror(context);
    if (!readKonamiUnlocked(context)) {
      throw new Error("Konami flag disappeared before model reconcile");
    }
    return { flagPath, mirrorPath };
  } catch (error) {
    let rollbackError = null;
    try {
      clearKonamiUnlocked(context);
      syncKonamiManagedMirror(context);
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      error.rollbackError = normalizeKonamiError(rollbackError);
    }
    throw error;
  }
}

function broadcastKonamiUnlockChanged(unlocked) {
  const payload = {
    unlocked: Boolean(unlocked),
    modelId: KONAMI_UNLOCK_MODEL_ID,
  };
  let owuiBroadcasted = false;
  const rendererWindowIds = [];

  try {
    owuiViews.broadcastToViews("owui-konami-unlock-changed", payload);
    owuiBroadcasted = true;
  } catch (error) {
    console.warn("[OWUI] Failed to broadcast Konami unlock to OWUI views:", error);
    logKonamiMain("Main", "warn", "Failed to broadcast Konami unlock to OWUI views", {
      phase: "broadcast",
      payload,
      error: normalizeKonamiError(error),
    });
  }

  for (const windowRef of BrowserWindow.getAllWindows()) {
    try {
      if (!windowRef?.isDestroyed() && !windowRef.webContents?.isDestroyed()) {
        windowRef.webContents.send("konami-unlock-changed", payload);
        rendererWindowIds.push(windowRef.id);
      }
    } catch (error) {
      console.warn("[OWUI] Failed to broadcast Konami unlock to renderer window:", error);
      logKonamiMain("Main", "warn", "Failed to broadcast Konami unlock to renderer window", {
        phase: "broadcast",
        payload,
        windowId: windowRef?.id ?? null,
        error: normalizeKonamiError(error),
      });
    }
  }

  logKonamiMain("Main", "info", "Broadcasted Konami unlock change", {
    phase: "broadcast",
    payload,
    owuiBroadcasted,
    rendererWindowIds,
  });
}

function buildKonamiUnlockViewCandidates({ ownerWindowId = null, preferredViewKey = null } = {}) {
  const candidates = [];
  const seen = new Set();

  const push = (candidate) => {
    if (typeof candidate !== "string" || candidate.trim() === "" || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  push(preferredViewKey);

  let views = [];
  try {
    views = owuiViews.listViews();
  } catch (_error) {
    views = [];
  }

  for (const view of views) {
    if (ownerWindowId != null && view?.ownerWindowId !== ownerWindowId) {
      continue;
    }
    push(view?.viewKey);
  }

  push("main");
  return candidates;
}

function buildKonamiOwuiUnlockScript() {
  const serializedModelId = JSON.stringify(KONAMI_UNLOCK_MODEL_ID);

  return `
    (async () => {
      const TARGET_MODEL_ID = ${serializedModelId};

      const unwrapModels = (payload) => {
        if (Array.isArray(payload)) {
          return payload;
        }
        if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
          return payload.data;
        }
        return [];
      };

      const parseResponseBody = async (response) => {
        const text = await response.text();
        if (!text) {
          return null;
        }
        try {
          return JSON.parse(text);
        } catch (_error) {
          return text;
        }
      };

      try {
        const token = window.localStorage?.getItem('token');
        if (!token) {
          return {
            success: false,
            code: 'missing-token',
            error: 'Missing OWUI token',
          };
        }

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${token}\`,
        };

        const candidateIds = [];
        const pushCandidate = (value) => {
          const normalized = typeof value === 'string' ? value.trim() : '';
          if (!normalized || candidateIds.includes(normalized)) {
            return;
          }
          candidateIds.push(normalized);
        };

        pushCandidate(TARGET_MODEL_ID);
        try {
          const listResponse = await fetch('/api/models', {
            method: 'GET',
            headers,
            credentials: 'include',
          });
          if (listResponse.ok) {
            const payload = await parseResponseBody(listResponse);
            const match = unwrapModels(payload).find((model) => {
              const baseModelId =
                model?.base_model_id ??
                model?.info?.base_model_id ??
                model?.baseModelId ??
                model?.info?.baseModelId ??
                null;
              return [model?.id, model?.name, baseModelId].some((candidate) => {
                return typeof candidate === 'string' && candidate.trim() === TARGET_MODEL_ID;
              });
            });
            pushCandidate(match?.id);
          }
        } catch (_error) {
          // Keep going; the direct model fetch below is the authoritative path.
        }

        let targetModel = null;
        let targetModelId = '';
        let lastFetchStatus = null;
        for (const candidateId of candidateIds) {
          const url = new URL('/api/v1/models/model', window.location.origin);
          url.searchParams.set('id', candidateId);
          const response = await fetch(url.toString(), {
            method: 'GET',
            headers,
            credentials: 'include',
          });

          if (response.status === 404) {
            lastFetchStatus = 404;
            continue;
          }
          if (!response.ok) {
            const body = await parseResponseBody(response);
            return {
              success: false,
              code: 'fetch-model-failed',
              error: \`Failed to fetch model (HTTP \${response.status})\`,
              status: response.status,
              body,
            };
          }

          const data = await parseResponseBody(response);
          if (data && typeof data === 'object') {
            targetModel = data;
            targetModelId = candidateId;
            break;
          }
        }

        if (!targetModel || !targetModelId) {
          return {
            success: false,
            code: lastFetchStatus === 404 ? 'model-not-found' : 'model-resolution-failed',
            error: lastFetchStatus === 404 ? 'Model not found' : 'Unable to resolve GPT-5.6 Sol Pro model',
            status: lastFetchStatus,
          };
        }

        let userId =
          (typeof targetModel.user_id === 'string' && targetModel.user_id.trim()) ||
          (typeof targetModel.user?.id === 'string' && targetModel.user.id.trim()) ||
          '';

        if (!userId) {
          const authResponse = await fetch('/api/v1/auths/', {
            method: 'GET',
            headers,
            credentials: 'include',
          });
          if (!authResponse.ok) {
            return {
              success: false,
              code: 'resolve-user-id-failed',
              error: \`Failed to resolve Open WebUI user ID (HTTP \${authResponse.status})\`,
              status: authResponse.status,
            };
          }
          const authPayload = await parseResponseBody(authResponse);
          userId = typeof authPayload?.id === 'string' ? authPayload.id.trim() : '';
        }

        if (!userId) {
          return {
            success: false,
            code: 'missing-user-id',
            error: 'Missing Open WebUI user ID',
          };
        }

        const nextModel = {
          ...targetModel,
          user_id: userId,
          meta: {
            ...(targetModel.meta && typeof targetModel.meta === 'object' ? targetModel.meta : {}),
            disabled: false,
          },
        };
        delete nextModel.meta.disabled_reason;
        delete nextModel.user;
        delete nextModel.info;

        const updateUrl = new URL('/api/v1/models/model/update', window.location.origin);
        updateUrl.searchParams.set('id', targetModelId);
        const updateResponse = await fetch(updateUrl.toString(), {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify(nextModel),
        });

        if (!updateResponse.ok) {
          const body = await parseResponseBody(updateResponse);
          return {
            success: false,
            code: 'update-model-failed',
            error: \`Failed to update model (HTTP \${updateResponse.status})\`,
            status: updateResponse.status,
            body,
          };
        }

        return {
          success: true,
          modelId: targetModelId,
        };
      } catch (error) {
        return {
          success: false,
          code: 'unexpected-error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
  `;
}

async function reconcileKonamiOwuiUnlock(
  { ownerWindowId = null, preferredViewKey = null } = {},
  { suppressStartupTransientWarnings = false } = {},
) {
  if (typeof unlockKonamiModelWithServiceAuth === "function") {
    logKonamiMain("Main", "info", "Updating Konami model with service auth", {
      phase: "service-model-update",
      ownerWindowId,
      preferredViewKey,
    });

    try {
      const result = await unlockKonamiModelWithServiceAuth();
      logKonamiMain("Main", "info", "Konami service-auth model update succeeded", {
        phase: "service-model-update",
        ownerWindowId,
        preferredViewKey,
        modelId: result?.modelId || KONAMI_UNLOCK_MODEL_ID,
        alreadyUnlocked: result?.alreadyUnlocked === true,
      });
      return {
        ...result,
        viewKey: preferredViewKey || null,
      };
    } catch (error) {
      const failure = getKonamiFailureInfo(error);
      const logLevel =
        suppressStartupTransientWarnings && isKonamiStartupTransientFailure(error)
          ? "info"
          : "warn";
      logKonamiMain("Main", logLevel, "Konami service-auth model update failed", {
        phase: "service-model-update",
        ownerWindowId,
        preferredViewKey,
        code: failure.code,
        status: failure.status,
        body: error?.body || null,
        error: normalizeKonamiError(error),
      });
      throw error;
    }
  }

  // Compatibility fallback for isolated test harnesses and older bundles that
  // do not provide the main-process service-auth updater.
  const viewCandidates = buildKonamiUnlockViewCandidates({
    ownerWindowId,
    preferredViewKey,
  });

  if (viewCandidates.length === 0) {
    const noViewError = new Error("No OWUI view available for Konami unlock");
    const logLevel =
      suppressStartupTransientWarnings && isKonamiStartupTransientFailure(noViewError)
        ? "info"
        : "warn";
    logKonamiMain("OWUI", logLevel, "No OWUI view available for Konami unlock", {
      phase: "owui-view-candidates",
      ownerWindowId,
      preferredViewKey,
      candidates: viewCandidates,
    });
    throw noViewError;
  }

  logKonamiMain("OWUI", "info", "Resolved OWUI Konami view candidates", {
    phase: "owui-view-candidates",
    ownerWindowId,
    preferredViewKey,
    candidates: viewCandidates,
  });

  const script = buildKonamiOwuiUnlockScript();
  let lastError = null;

  for (const viewKey of viewCandidates) {
    try {
      logKonamiMain("OWUI", "info", "Executing Konami unlock in OWUI view", {
        phase: "owui-execute",
        ownerWindowId,
        preferredViewKey,
        viewKey,
      });
      const result = await owuiViews.executeJavaScript(viewKey, script);
      if (result?.success) {
        logKonamiMain("OWUI", "info", "Konami unlock updated OWUI model successfully", {
          phase: "owui-execute",
          ownerWindowId,
          preferredViewKey,
          viewKey,
          modelId: result?.modelId || null,
        });
        return {
          ...result,
          viewKey,
        };
      }
      const reconcileError = createKonamiReconcileError(
        result,
        `Konami unlock failed in OWUI view ${viewKey}`,
      );
      const logLevel =
        suppressStartupTransientWarnings && isKonamiStartupTransientFailure(reconcileError)
          ? "info"
          : "warn";
      logKonamiMain("OWUI", logLevel, "Konami unlock script returned a non-success result", {
        phase: "owui-execute",
        ownerWindowId,
        preferredViewKey,
        viewKey,
        code: result?.code || null,
        status: result?.status || null,
        error: result?.error || null,
        body: result?.body || null,
      });
      lastError = reconcileError;
    } catch (error) {
      const failure = getKonamiFailureInfo(error);
      const logLevel =
        suppressStartupTransientWarnings && isKonamiStartupTransientFailure(error)
          ? "info"
          : "warn";
      logKonamiMain("OWUI", logLevel, "Konami unlock execution failed in OWUI view", {
        phase: "owui-execute",
        ownerWindowId,
        preferredViewKey,
        viewKey,
        code: failure.code,
        status: failure.status,
        error: normalizeKonamiError(error),
      });
      lastError = error;
    }
  }

  throw lastError || new Error("Konami unlock failed in every OWUI view");
}

async function attemptKonamiOwuiUnlock(
  { ownerWindowId = null, preferredViewKey = null } = {},
  { attempts = KONAMI_RECONCILE_MAX_ATTEMPTS, delayMs = KONAMI_RECONCILE_RETRY_DELAY_MS } = {},
  { suppressStartupTransientWarnings = false } = {},
) {
  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logKonamiMain("OWUI", "info", "Attempting immediate Konami OWUI unlock", {
        phase: "owui-reconcile-attempt",
        ownerWindowId,
        preferredViewKey,
        attempt,
        maxAttempts,
      });
      return await reconcileKonamiOwuiUnlock({
        ownerWindowId,
        preferredViewKey,
      }, {
        suppressStartupTransientWarnings,
      });
    } catch (error) {
      lastError = error;
      const failure = getKonamiFailureInfo(error);
      const transientStartupFailure =
        suppressStartupTransientWarnings && isKonamiStartupTransientFailure(error);
      logKonamiMain(
        "OWUI",
        transientStartupFailure ? "info" : "warn",
        transientStartupFailure
          ? "Immediate Konami OWUI unlock attempt deferred"
          : "Immediate Konami OWUI unlock attempt failed",
        {
          phase: "owui-reconcile-attempt",
          ownerWindowId,
          preferredViewKey,
          attempt,
          maxAttempts,
          delayMs,
          code: failure.code,
          status: failure.status,
          error: normalizeKonamiError(error),
        },
      );

      if (attempt >= maxAttempts) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error("Konami unlock could not be reconciled");
}

function formatProcessFailureDetails(error) {
  const sections = [];
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();

  if (stderr) {
    sections.push(`stderr:\n${stderr}`);
  }
  if (stdout) {
    sections.push(`stdout:\n${stdout}`);
  }

  return sections.join("\n\n");
}

const GUIDED_SETUP_PORTICO_ICON_SHA256 =
  "5e156edc5fe46b26a1f576639edc883d20cb2d689285236c18168ca1d1b6a7ca";

function detectGuidedSetupLogoKind(iconBuffer) {
  if (!iconBuffer || !Buffer.isBuffer(iconBuffer)) {
    return null;
  }

  const digest = crypto
    .createHash("sha256")
    .update(iconBuffer)
    .digest("hex");
  return digest === GUIDED_SETUP_PORTICO_ICON_SHA256 ? "portico" : null;
}

const GUIDED_SETUP_DEBUG_MAX_CHARS = 50000;
const MCP_CONFIG_GENERATION_TIMEOUT_MS = 180000;

function getSingleServerBaseUrl(session = singleServerSession) {
  const hostPort = Number(session?.hostPort) || singleServerStackPorts.hostPort;
  return `http://localhost:${hostPort}`;
}

function getOwnedSingleServerSession(sessionId, serverId = null) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (
    !normalizedSessionId ||
    !singleServerSession ||
    singleServerSession.sessionId !== normalizedSessionId
  ) {
    return null;
  }
  if (serverId && singleServerSession.serverId !== serverId) {
    return null;
  }
  if (singleServerSession.state === "stopping") {
    return null;
  }
  return singleServerSession;
}

function staleSingleServerSessionResult() {
  return {
    success: false,
    state: "stale_session",
    healthy: false,
    tools: [],
    error: "The single-server test session is no longer active",
  };
}

/**
 * Import the OAuth record captured by a single-server *bootstrap* stack into
 * host safeStorage.
 *
 * First-time/interactive OAuth runs in the wizard container (broker off). The
 * callback handler saves the token only inside that (ephemeral, unmounted)
 * container, so we must pull it out before teardown. We fetch it from the
 * container's guarded /oauth/bootstrap-record endpoint using the one-time
 * bearer minted at launch, then persist it via persistOAuthRecord so the
 * broker-mode main stack can vend/refresh it afterwards.
 *
 * Fails closed: callers must treat a non-success result as an OAuth failure
 * and must NOT report success to the user (otherwise the credential is lost).
 * The raw token never leaves the Electron main process.
 */
async function importBootstrapOAuthRecord(serverId, sessionId) {
  const session = singleServerBootstrap;
  const activeSession = getOwnedSingleServerSession(sessionId, serverId);
  if (
    !session ||
    !activeSession ||
    session.serverId !== serverId ||
    session.sessionId !== sessionId ||
    !session.exportToken
  ) {
    return {
      success: false,
      reason: "no_bootstrap_session",
      error: "No active OAuth bootstrap session for this server",
    };
  }

  const baseUrl = getSingleServerBaseUrl(activeSession);
  const url = `${baseUrl}/oauth/bootstrap-record/${encodeURIComponent(serverId)}`;

  // The captured token can lag the "completed" status by a moment; retry 404s.
  const maxAttempts = 5;
  let lastError = "export endpoint did not return a record";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.exportToken}` },
      });
    } catch (error) {
      lastError = `export request failed: ${error.message}`;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }

    if (response.status === 404) {
      lastError = "OAuth record not available yet";
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!response.ok) {
      return {
        success: false,
        reason: "export_failed",
        error: `export endpoint returned HTTP ${response.status}`,
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        success: false,
        reason: "export_parse_failed",
        error: error.message,
      };
    }

    if (payload?.server_id !== serverId) {
      return {
        success: false,
        reason: "server_id_mismatch",
        error: "exported record server_id does not match the requested server",
      };
    }
    if (!payload?.token?.access_token || !payload?.client_info?.client_id) {
      return {
        success: false,
        reason: "incomplete_record",
        error: "exported record is missing token or client metadata",
      };
    }

    try {
      persistOAuthRecord(
        serverId,
        { token: payload.token, client_info: payload.client_info },
        { projectRoot: bootstrap.PROJECT_ROOT },
      );
    } catch (error) {
      return {
        success: false,
        reason: "persist_failed",
        error: error.message,
      };
    }

    // One-shot: drop the export bearer immediately after a successful import.
    singleServerBootstrap = null;
    console.log(
      `[OAuth Single] Imported bootstrap OAuth record for ${serverId} into safeStorage`,
    );
    return { success: true };
  }

  return { success: false, reason: "export_unavailable", error: lastError };
}

function normalizeGuidedSetupLogText(value) {
  if (Array.isArray(value)) {
    return value.join("");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return String(value);
}

async function readGuidedSetupLogTail(filePath, maxChars = GUIDED_SETUP_DEBUG_MAX_CHARS) {
  if (!filePath) return "";
  try {
    const content = await fsPromises.readFile(filePath, "utf8");
    const normalized = normalizeGuidedSetupLogText(content).trim();
    if (!normalized) return "";
    return normalized.length > maxChars
      ? normalized.slice(normalized.length - maxChars)
      : normalized;
  } catch (error) {
    return "";
  }
}

async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once("error", () => resolve(false));
    tester.listen(port, "127.0.0.1", () => {
      tester.close(() => resolve(true));
    });
  });
}

async function findFreePort(options = {}) {
  const { preferred = [], exclude = [] } = options;
  const blocked = new Set(exclude);

  for (const candidate of preferred) {
    if (blocked.has(candidate)) continue;
    if (await isPortAvailable(candidate)) return candidate;
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
    if (candidate && !blocked.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to allocate a free host port");
}

async function allocateSingleServerPorts() {
  const callbackPort = await selectSingleServerCallbackPort(isPortAvailable);
  const hostPort = await findFreePort({
    preferred: [8770, 8771, 8772, 8773, 8774],
    exclude: [callbackPort],
  });
  return { hostPort, callbackPort };
}

async function inspectSingleServerCallbackPortOwners() {
  const rawOwners = await inspectCallbackPortOwners(
    CANONICAL_SINGLE_STACK_CALLBACK_PORT,
    {
      exec: execPromise,
      execOptions: {
        cwd: bootstrap.PROJECT_ROOT,
        env: dockerMcp.createEnhancedEnv(),
        timeout: 5000,
      },
    },
  );
  const knownProcessGroups = buildKnownProcessGroups({
    projectRoot: bootstrap.PROJECT_ROOT,
    bridgePid: state.hostMcpBridge.process?.pid,
    hostMcpoPid: state.hostMcpo.process?.pid,
  });
  return classifyCallbackPortOwners(rawOwners, knownProcessGroups);
}

async function ensureSingleServerCallbackPortAvailable() {
  const port = CANONICAL_SINGLE_STACK_CALLBACK_PORT;
  const result = await ensureReservedCallbackPortAvailable({
    port,
    isPortAvailable,
    inspectOwners: async () => {
      try {
        return await inspectSingleServerCallbackPortOwners();
      } catch (error) {
        console.warn(
          `[OAuth Callback Port] Could not inspect port ${port}: ${error.message}`,
        );
        return [];
      }
    },
    onConflict: (owners) => {
      console.warn(
        `[OAuth Callback Port] Reserved port conflict: ${formatCallbackPortOwners(port, owners)}`,
      );
    },
    recoverComponent: async (component) => {
      if (component === COMPONENT_HOST_MCPO) {
        console.warn(
          `[OAuth Callback Port] Restarting app-owned Host MCP runtime that incorrectly claimed reserved port ${port}`,
        );
        await stopHostMcpo();
        const startResult = await startHostMcpo();
        return startResult?.success
          ? { success: true }
          : {
              success: false,
              error: `Could not restart the Host MCP runtime while releasing OAuth callback port ${port}: ${startResult?.error || "unknown error"}`,
            };
      }

      if (component === COMPONENT_BRIDGE) {
        console.warn(
          `[OAuth Callback Port] Restarting app-owned Host MCP Bridge that incorrectly claimed reserved port ${port}`,
        );
        await stopHostMcpBridge();
        const bridgeReady = await ensureHostMcpBridgeReady();
        return bridgeReady.ready
          ? { success: true }
          : { success: false, error: bridgeReady.error };
      }

      return { success: false, error: `Unknown app-owned process: ${component}` };
    },
  });
  if (result.recovered) {
    console.log(
      `[OAuth Callback Port] Recovered reserved port ${port} from app-owned process`,
    );
  }
  return result;
}

// Shared helpers used across handler groups
async function getDeploymentTypeForServer(serverId) {
  const healthStatusPath = path.join(
    bootstrap.PROJECT_ROOT,
    "health-status",
    "health_status.json",
  );

  try {
    if (fs.existsSync(healthStatusPath)) {
      const healthContent = fs.readFileSync(healthStatusPath, "utf8");
      const healthStatus = JSON.parse(healthContent);
      const deployment = healthStatus?.servers?.[serverId]?.deployment;
      if (deployment) {
        return deployment;
      }
    }
  } catch (error) {
    console.warn(
      `[IPC] Failed to read deployment type from health status for ${serverId}:`,
      error.message,
    );
  }

  try {
    const isHost = await isHostDeployedServer(serverId);
    if (isHost) return "host";
  } catch (error) {
    console.warn(
      `[IPC] Failed to determine host deployment for ${serverId}:`,
      error.message,
    );
  }

  if (isCoreServer(serverId)) {
    return "core";
  }

  return "docker";
}

async function waitForServerHealthy(serverId, options = {}) {
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? options.maxWaitMs
    : 90000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : 2000;
  const startTime = Date.now();

  console.log(
    `[IPC] Waiting for ${serverId} to become healthy (max ${maxWaitMs}ms)...`,
  );

  while (Date.now() - startTime < maxWaitMs) {
    const deploymentType = await getDeploymentTypeForServer(serverId);
    const result = await checkSingleServerHealth(serverId, deploymentType);
    if (result.healthy) {
      console.log(`[IPC] ${serverId} is healthy`);
      return { healthy: true };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.warn(`[IPC] ${serverId} did not become healthy in time`);
  return { healthy: false, error: "timeout" };
}

/**
 * Set dependencies for handlers that need window creation or other main.js functions
 */
function setHandlerDependencies(deps) {
  dependencies = { ...dependencies, ...deps };
  console.log("[IPC] Handler dependencies set");
}

function ensureMainWindowForConversationAttach() {
  let mainWindow = state.windows.main;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (dependencies.createMainWindow) {
      dependencies.createMainWindow();
    }
    mainWindow = state.windows.main;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (typeof mainWindow.show === "function") {
    mainWindow.show();
  }

  return mainWindow;
}

function requestDetachedConversationAttach(mainWindow, attachPayload, options = {}) {
  const focusMainWindow = options.focusMainWindow !== false;

  return new Promise((resolve, reject) => {
    let sendTimer = null;
    let loadListener = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out returning detached window to the main tab strip"));
    }, DETACHED_CONVERSATION_ATTACH_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      if (loadListener) {
        mainWindow.webContents.removeListener("did-finish-load", loadListener);
        loadListener = null;
      }
      ipcMain.removeListener("conversation-attach-complete", handleComplete);
    }

    function handleComplete(_completeEvent, data = {}) {
      if (data.requestId !== attachPayload.requestId) {
        return;
      }

      cleanup();
      resolve(data.result || { success: true });
    }

    function sendAttach() {
      try {
        mainWindow.webContents.send("attach-detached-conversation", attachPayload);
        if (focusMainWindow) {
          mainWindow.focus();
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    ipcMain.on("conversation-attach-complete", handleComplete);
    const queueSendAttach = () => {
      sendTimer = setTimeout(sendAttach, 100);
    };

    if (mainWindow.webContents.isLoading()) {
      loadListener = () => {
        loadListener = null;
        queueSendAttach();
      };
      mainWindow.webContents.once("did-finish-load", loadListener);
    } else {
      queueSendAttach();
    }
  });
}

async function attachConversationToMainWindow(payload = {}, options = {}) {
  const { conversationId, url, title, windowType, viewKey } = payload;
  if (!conversationId || !url) {
    return { success: false, error: "Missing conversationId or url" };
  }

  try {
    const mainWindow = ensureMainWindowForConversationAttach();
    if (!mainWindow) {
      return { success: false, error: "Main window not available" };
    }

    const requestId = `${conversationId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2, 8)}`;
    const attachResult = await requestDetachedConversationAttach(
      mainWindow,
      {
        conversationId,
        url,
        title,
        windowType,
        viewKey,
        requestId,
      },
      { focusMainWindow: true },
    );

    if (!attachResult?.success) {
      return attachResult;
    }

    const senderWindow = options.senderWindow || null;
    if (
      options.closeSender !== false &&
      senderWindow &&
      !senderWindow.isDestroyed() &&
      senderWindow.id !== mainWindow.id
    ) {
      senderWindow.close();
    }

    return { success: true };
  } catch (error) {
    console.error("[CONVERSATION] Failed to attach detached window:", error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// CONFIG / PATH HANDLERS
// ============================================================================

function registerConfigHandlers() {
  // Provide project root to renderer
  ipcMain.handle("get-project-root", () => {
    return bootstrap.PROJECT_ROOT;
  });

  ipcMain.handle("should-skip-prerequisites", async () => {
    try {
      const prerequisitesService = require("./prerequisites-service");
      const projectRoot =
        bootstrap.PROJECT_ROOT ||
        path.join(os.homedir(), "portico", "portico-managed");
      const result = await prerequisitesService.shouldSkipPrerequisites({
        projectRoot,
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        appRoot: path.join(projectRoot, "electron-app"),
      });
      return Boolean(result?.skip);
    } catch (error) {
      console.error("[IPC] should-skip-prerequisites failed:", error);
      return false;
    }
  });

  ipcMain.handle("get-guided-setup-bootstrap-state", async () => {
    try {
      const prerequisitesService = require("./prerequisites-service");
      const projectRoot =
        bootstrap.PROJECT_ROOT ||
        path.join(os.homedir(), "portico", "portico-managed");
      const preferencesResult = readGuidedSetupPreferences({
        userDataPath: app.getPath("userData"),
      });

      const prereqState = await prerequisitesService.shouldSkipPrerequisites({
        projectRoot,
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        appRoot: path.join(projectRoot, "electron-app"),
      });

      let hostModeEnabled = false;
      try {
        const hostModePath = path.join(projectRoot, "HOST_MODE");
        hostModeEnabled = await readHostModeFile(hostModePath);
      } catch (_error) {
        hostModeEnabled = false;
      }

      if (preferencesResult.parseError) {
        console.warn(
          "[IPC] Guided setup preferences were invalid; using defaults:",
          preferencesResult.parseError,
        );
      }

      return {
        success: true,
        launchContext: {
          source: state.guidedSetupLaunchContext.source || "unknown",
          trigger: state.guidedSetupLaunchContext.trigger || "unknown",
          startedAt: state.guidedSetupLaunchContext.startedAt || 0,
          setupMode: state.guidedSetupLaunchContext.setupMode || null,
          setupReason: state.guidedSetupLaunchContext.setupReason || null,
          setupRequirementId:
            state.guidedSetupLaunchContext.setupRequirementId || null,
          safeErrorCode: state.guidedSetupLaunchContext.safeErrorCode || null,
          setupOperationId:
            state.guidedSetupLaunchContext.setupOperationId || null,
          seedDefaults: state.guidedSetupLaunchContext.seedDefaults === true,
        },
        prereqReadiness: {
          readyForAuth: Boolean(prereqState?.skip),
          reason: prereqState?.reason || "unknown",
          missingImages: Array.isArray(prereqState?.missingImages)
            ? prereqState.missingImages
            : [],
        },
        savedOnboardingMode: preferencesResult.data.onboardingMode,
        hostModeEnabled,
      };
    } catch (error) {
      console.error("[IPC] get-guided-setup-bootstrap-state failed:", error);
      return {
        success: false,
        error: error.message,
        launchContext: {
          source: state.guidedSetupLaunchContext.source || "unknown",
          trigger: state.guidedSetupLaunchContext.trigger || "unknown",
          startedAt: state.guidedSetupLaunchContext.startedAt || 0,
          setupMode: state.guidedSetupLaunchContext.setupMode || null,
          setupReason: state.guidedSetupLaunchContext.setupReason || null,
          setupRequirementId:
            state.guidedSetupLaunchContext.setupRequirementId || null,
          safeErrorCode: state.guidedSetupLaunchContext.safeErrorCode || null,
          setupOperationId:
            state.guidedSetupLaunchContext.setupOperationId || null,
          seedDefaults: state.guidedSetupLaunchContext.seedDefaults === true,
        },
        prereqReadiness: {
          readyForAuth: false,
          reason: "bootstrap-error",
          missingImages: [],
        },
        savedOnboardingMode: null,
        hostModeEnabled: false,
      };
    }
  });

  ipcMain.handle("get-setup-launch-decision", async () => {
    try {
      const { identityResultLacksEmail } = require("./setup-decision");
      let decision = windows.getSetupLaunchDecision();
      if (decision.action === "reconcile_identity") {
        const identity = await currentUser.get();
        if (
          identity?.authenticated === true &&
          identity?.success !== false &&
          !identityResultLacksEmail(identity)
        ) {
          decision = windows.getSetupLaunchDecision();
        } else if (!identity?.errorCode || identityResultLacksEmail(identity)) {
          // Unauthenticated without a hard error, OR authenticated with no
          // usable email (PORTICO-414): both need the identity-repair sign-in.
          decision = {
            ...decision,
            action: "identity_login",
            setupMode: "identity_repair",
            safeErrorCode: "SETUP_IDENTITY_LOGIN_REQUIRED",
          };
        }
      }
      return {
        success: true,
        decision,
      };
    } catch (error) {
      console.error("[IPC] get-setup-launch-decision failed:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  });

  ipcMain.handle("save-guided-setup-mode-preference", async (_event, onboardingMode) => {
    try {
      return saveGuidedSetupPreferences({
        userDataPath: app.getPath("userData"),
        onboardingMode,
      });
    } catch (error) {
      console.error("[IPC] Failed to save guided setup mode preference:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-get-sidebar-preference", async () => {
    try {
      const preferencesResult = readOwuiSidebarPreferences({
        userDataPath: app.getPath("userData"),
      });

      if (preferencesResult.parseError) {
        console.warn(
          "[IPC] OWUI sidebar preferences were invalid; using defaults:",
          preferencesResult.parseError,
        );
      }

      return {
        success: true,
        data: {
          normalWindowSidebarOpen:
            preferencesResult.data.normalWindowSidebarOpen,
        },
      };
    } catch (error) {
      console.error("[IPC] Failed to read OWUI sidebar preference:", error);
      return { success: false, error: error.message };
    }
  });

  // OWUI UI callout impression counters (Application Support JSON; reads are
  // graceful — a missing/corrupt file reports zero impressions).
  ipcMain.handle("owui-ui-callout-get", async (_event, key) => {
    try {
      const impressions = getOwuiUiCalloutImpressions({
        userDataPath: app.getPath("userData"),
        key,
      });
      return { success: true, data: { impressions } };
    } catch (error) {
      console.error("[IPC] Failed to read OWUI UI callout state:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-ui-callout-increment", async (_event, key) => {
    try {
      const result = incrementOwuiUiCalloutCounter({
        userDataPath: app.getPath("userData"),
        key,
      });
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, data: { impressions: result.impressions } };
    } catch (error) {
      console.error("[IPC] Failed to increment OWUI UI callout counter:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-save-sidebar-preference", async (_event, open) => {
    try {
      const saveResult = saveOwuiSidebarPreferences({
        userDataPath: app.getPath("userData"),
        normalWindowSidebarOpen: open,
      });

      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        data: {
          normalWindowSidebarOpen:
            saveResult.data.normalWindowSidebarOpen,
        },
      };
    } catch (error) {
      console.error("[IPC] Failed to save OWUI sidebar preference:", error);
      return { success: false, error: error.message };
    }
  });

  // Dev-only marketplace auto-approve toggle. `enabled` is the effective
  // value after the module's dev-build clamps, so a non-dev build always
  // reports (and persists) false regardless of what was asked or stored.
  ipcMain.handle("marketplace-auto-approve-get", async () => {
    try {
      const isDevBuild = state.buildInfo?.buildNumber === "dev-build";
      return {
        success: true,
        enabled: resolveMarketplaceAutoApprove({
          userDataPath: app.getPath("userData"),
          isDevBuild,
        }),
        isDevBuild,
      };
    } catch (error) {
      console.error("[IPC] Failed to read marketplace auto-approve:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("marketplace-auto-approve-set", async (_event, enabled) => {
    try {
      const isDevBuild = state.buildInfo?.buildNumber === "dev-build";
      const saveResult = saveMarketplaceAutoApprovePreferences({
        userDataPath: app.getPath("userData"),
        autoApprove: enabled === true,
        isDevBuild,
      });
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }
      return { success: true, enabled: saveResult.data.autoApprove };
    } catch (error) {
      console.error("[IPC] Failed to save marketplace auto-approve:", error);
      return { success: false, error: error.message };
    }
  });

  // Provide chat webview preload path to renderer
  ipcMain.handle("get-chat-webview-preload-path", () => {
    return path.join(bootstrap.APP_SERVICES, "chat-webview-preload.js");
  });

  // Reset saved project root (for troubleshooting)
  ipcMain.handle("reset-project-root", () => {
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        console.log("Deleted saved project root configuration");
        return {
          success: true,
          message: "Project root configuration reset. Please restart the app.",
        };
      } else {
        return { success: true, message: "No saved configuration to reset." };
      }
    } catch (error) {
      console.error("Failed to reset project root:", error);
      return { success: false, error: error.message };
    }
  });

  // Clear webview cache (can be called manually if needed)
  ipcMain.handle("clear-webview-cache", async () => {
    try {
      await clearWebviewCache();
      return { success: true, message: "Webview cache cleared successfully" };
    } catch (error) {
      console.error("Failed to clear webview cache:", error);
      return { success: false, error: error.message };
    }
  });

  // Send init log from renderer to file (for persisting OAuth logs etc.)
  ipcMain.handle("send-init-log", async (event, message, type) => {
    try {
      sendInitLog(message, type || "info");
      return { success: true };
    } catch (error) {
      console.error("Failed to send init log:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("check-vpn-connectivity", async () => {
    const harborUrl = "https://harbor.example.invalid";
    const cloudsmithUrl = `${cloudsmithConfig.CLOUDSMITH_API_BASE}/packages/${cloudsmithConfig.CLOUDSMITH_OWNER}/${cloudsmithConfig.CLOUDSMITH_REPO}/?page_size=1`;
    const result = {
      success: false,
      harbor: { ok: false, error: null },
      cloudsmith: { ok: false, error: null },
    };

    const extractCurlError = (error) => {
      const detail =
        (error && (error.stderr || error.stdout || error.message)) || "";
      return detail.toString().trim().split("\n")[0] || "Request failed";
    };
    const parseCurlHttpStatus = (value) => {
      const status = Number.parseInt(String(value || "").trim(), 10);
      return Number.isFinite(status) ? status : null;
    };
    const isReachableStatus = (status) =>
      status !== null && status >= 100 && status <= 499;
    const runCurl = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn("curl", args, {
          env: createEnhancedEnv({}),
        });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          reject(error);
        });
        child.on("close", (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error = new Error(`curl exited with code ${code}`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });

    try {
      const { stdout } = await runCurl(["-fsSL", "--max-time", "8", harborUrl]);
      result.harbor.ok = stdout.includes("<harbor-app>");
      if (!result.harbor.ok) {
        result.harbor.error = "Unexpected Harbor response";
      }
    } catch (error) {
      result.harbor.error = extractCurlError(error);
    }

    try {
      const managedRoot =
        process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT;
      const liveReadToken = resolveCloudsmithEntitlementToken({
        env: process.env,
        projectRoot: bootstrap.PROJECT_ROOT,
        resourcesPath: process.resourcesPath,
        managedRoot,
      });
      const readToken =
        liveReadToken ||
        cloudsmithConfig.CLOUDSMITH_READ_TOKEN ||
        cloudsmithConfig.CLOUDSMITH_ENTITLEMENT_TOKEN;
      const curlArgs = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8"];
      if (readToken) {
        curlArgs.push("-H", `X-Api-Key: ${readToken}`);
      }
      curlArgs.push(cloudsmithUrl);
      const { stdout } = await runCurl(curlArgs);
      const httpStatus = parseCurlHttpStatus(stdout);
      result.cloudsmith.ok = isReachableStatus(httpStatus);
      if (!result.cloudsmith.ok) {
        result.cloudsmith.error =
          httpStatus === null ? "Cloudsmith probe returned no status" : `HTTP ${httpStatus}`;
      }
    } catch (error) {
      result.cloudsmith.error = extractCurlError(error);
    }

    result.success = result.harbor.ok && result.cloudsmith.ok;
    return result;
  });

  // Load existing .env file
  ipcMain.handle("load-env", async () => {
    // Reset config data to ensure we load fresh
    resetConfigData();

    try {
      const envPath = path.join(bootstrap.PROJECT_ROOT, ".env");

      console.log("Loading environment from:", envPath);

      // If .env doesn't exist, return empty (will be created by presets)
      if (!fs.existsSync(envPath)) {
        console.log(".env does not exist, returning empty");
        return { success: true, data: {} };
      }

      // Read and parse .env
      const envContent = await fsPromises.readFile(envPath, "utf8");
      const envData = {};

      const lines = envContent.split("\n");
      for (const line of lines) {
        if (line && !line.startsWith("#") && line.includes("=")) {
          const [key, ...valueParts] = line.split("=");
          if (key) {
            const value = valueParts.join("=").trim();
            envData[key.trim()] = value;
          }
        }
      }

      configData.env = envData;
      return { success: true, data: envData };
    } catch (error) {
      console.error("Error loading .env:", error);
      return { success: false, error: error.message };
    }
  });

  // Check HOST_MODE support
  ipcMain.handle("check-host-mode", async () => {
    try {
      const hostModePath = path.join(bootstrap.PROJECT_ROOT, "HOST_MODE");
      const content = await fsPromises.readFile(hostModePath, "utf-8");
      const isSupported = parseHostModeValue(content);
      console.log(
        "HOST_MODE check:",
        content.trim(),
        "-> supported:",
        isSupported,
      );
      return { success: true, supported: isSupported };
    } catch (error) {
      console.log("HOST_MODE file not found or error:", error.message);
      return { success: true, supported: false }; // Default to not supported if file missing
    }
  });

  // Update environment variable
  ipcMain.handle("update-env-var", async (event, varName, value) => {
    if (!configData) resetConfigData();
    configData.env[varName] = value;
    return { success: true };
  });

  // Save configuration
  ipcMain.handle("save-config", async () => {
    if (!configData) resetConfigData();

    try {
      const envPath = path.join(bootstrap.PROJECT_ROOT, ".env");
      const mcpConfigPath = path.join(
        bootstrap.PROJECT_ROOT,
        "mcp_config_advanced.json",
      );

      console.log("Saving configuration to:", envPath);
      console.log("Saving MCP config to:", mcpConfigPath);

      // Add build tracking info to env data
      try {
        const buildTrack = buildInfo.buildNumber || "dev-build";
        configData.env["PORTICO_BUILD_TRACK"] = buildTrack;
        console.log("Added build tracking info to .env:", buildTrack);
      } catch (error) {
        console.log("Could not add build tracking info:", error.message);
        configData.env["PORTICO_BUILD_TRACK"] = "unknown";
      }

      // Build .env content
      let envContent = "";
      for (const [key, value] of Object.entries(configData.env)) {
        envContent += `${key}=${value}\n`;
      }

      await writeProtectedRepositoryEnvAtomic(
        envPath,
        envContent,
      );

      // Build and write mcp_config_advanced.json
      const mcpConfig = {
        mcpServers: configData.mcpServers,
      };
      await fsPromises.writeFile(
        mcpConfigPath,
        JSON.stringify(mcpConfig, null, 2),
        "utf8",
      );

      return { success: true, configurationSaved: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Load MCP toggles
  ipcMain.handle("load-mcp-toggles", async () => {
    try {
      const { toggles, parseError } = normalizeAndPersistMcpToggles({
        persist: false,
        reason: "load-mcp-toggles",
      });
      if (parseError) {
        return {
          success: false,
          error: `mcp_toggles.json parse error: ${parseError}`,
          data: toggles,
        };
      }
      return { success: true, data: toggles };
    } catch (error) {
      console.error("Failed to load MCP toggles:", error);
      return { success: false, error: error.message, data: {} };
    }
  });

  // Load MCP disable modes (PORTICO-410 hard-disable sidecar; fail-open to {})
  ipcMain.handle("load-mcp-disable-modes", async () => {
    try {
      const rawModeState = dockerMcp.loadRawMcpDisableModes({
        includeMeta: true,
      });
      return { success: true, data: rawModeState.modes || {} };
    } catch (error) {
      console.error("Failed to load MCP disable modes:", error);
      return { success: false, error: error.message, data: {} };
    }
  });

  // Switch the disable mode of an already-disabled server (metadata-only;
  // no container lifecycle). mode: "hard" pins it out of the model's world,
  // "soft" restores today's disable semantics.
  ipcMain.handle("set-mcp-disable-mode", async (_event, serverId, mode) => {
    try {
      const normalizedMode = String(mode || "").trim().toLowerCase();
      if (normalizedMode !== "hard" && normalizedMode !== "soft") {
        return {
          success: false,
          errorCode: "INVALID_DISABLE_MODE",
          error: `Unsupported disable mode: ${mode}`,
        };
      }
      if (!dockerMcp.isKnownMcpServerId(serverId)) {
        return {
          success: false,
          errorCode: "MCP_SERVER_NOT_FOUND",
          error: `MCP server is not installed: ${serverId}`,
        };
      }
      if (dockerMcp.isCoreServer(serverId)) {
        return {
          success: false,
          errorCode: "MCP_CORE_TOGGLE_FORBIDDEN",
          error: `Core MCP server toggles are managed by the application: ${serverId}`,
        };
      }
      const activeOperation =
        defaultMcpOperationManager.getActiveMcpOperation();
      if (activeOperation) {
        return {
          success: false,
          errorCode: "MCP_OPERATION_BUSY",
          error: "Another MCP operation is in progress. Try again shortly.",
          activeOperation,
        };
      }
      if (dockerMcp.getMcpTogglesSync()[serverId] === true) {
        return {
          success: false,
          errorCode: "SERVER_NOT_DISABLED",
          error: `Server ${serverId} is enabled; disable it first to change its disable mode.`,
        };
      }

      // Hard mode must always ride on toggles=false: an ABSENT toggle passes
      // the gate above but reads as toggled-ON downstream (unified_context
      // fails open), which would leave a "hard-disabled" server visible in
      // <needs_config>/<needs_auth>. Force the boolean OFF before stamping
      // the mode — PORTICO-410 crash-safe ordering (an interruption leaves a
      // plain soft-disabled server, never a visible-but-hard contradiction).
      if (
        normalizedMode === "hard" &&
        dockerMcp.getMcpTogglesSync()[serverId] !== false
      ) {
        await mutateMcpToggles(
          (draft) => {
            draft[serverId] = false;
          },
          { reason: `set-mcp-disable-mode:${serverId}:force-disable` },
        );
      }

      const mutation = await dockerMcp.mutateMcpDisableModes(
        (draft) => {
          if (normalizedMode === "hard") {
            draft[serverId] = "hard";
          } else {
            delete draft[serverId];
          }
        },
        { reason: `set-mcp-disable-mode:${serverId}:${normalizedMode}` },
      );

      const payload = { server_id: serverId, mode: normalizedMode, modes: mutation.modes };
      BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) {
          window.webContents.send("mcp-disable-modes-changed", payload);
        }
      });

      return { success: true, server_id: serverId, mode: normalizedMode, data: mutation.modes };
    } catch (error) {
      console.error(`Failed to set MCP disable mode for ${serverId}:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("load-guided-setup-mcp-toggles", async () => {
    try {
      const rawToggleState = loadRawMcpToggles({ includeMeta: true });
      if (rawToggleState.parseError) {
        return {
          success: false,
          error: `mcp_toggles.json parse error: ${rawToggleState.parseError.message}`,
          data: rawToggleState.toggles,
          contentHash: rawToggleState.contentHash || null,
          parseError: {
            code: "MCP_TOGGLES_PARSE_ERROR",
            message: rawToggleState.parseError.message,
          },
        };
      }
      return {
        success: true,
        data: rawToggleState.toggles,
        exists: rawToggleState.exists === true,
        contentHash: rawToggleState.contentHash || null,
        parseError: null,
      };
    } catch (error) {
      console.error("Failed to load guided setup MCP toggles:", error);
      return { success: false, error: error.message, data: {} };
    }
  });

  ipcMain.handle("apply-guided-setup-mcp-toggle-changes", async (_event, payload) => {
    let releaseMutation = null;
    try {
      releaseMutation = await acquireGuidedSetupFinalizeLease({
        kind: "guided_setup_toggle_patch",
        source: "guided_setup",
      });
      const changes = payload?.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new TypeError("changes must be an object");
      }
      const entries = Object.entries(changes);
      if (entries.length > 256) {
        throw new TypeError("too many guided setup toggle changes");
      }
      for (const [serverId, enabled] of entries) {
        if (!isKnownMcpServerId(serverId)) {
          throw new TypeError(`unknown MCP server id: ${serverId}`);
        }
        if (isCoreServer(serverId)) {
          throw new TypeError(`core MCP server cannot be changed: ${serverId}`);
        }
        const officialConfigPath = path.join(
          bootstrap.PROJECT_ROOT,
          "mcp-configs",
          serverId,
          `${serverId}.yaml`,
        );
        if (!fs.existsSync(officialConfigPath)) {
          throw new TypeError(
            `guided setup cannot change user-installed MCP server: ${serverId}`,
          );
        }
        const serverDefinition = parseYaml(
          fs.readFileSync(officialConfigPath, "utf8"),
        );
        if (
          serverDefinition?.guided_setup_hidden === true ||
          serverDefinition?.guidedSetupHidden === true ||
          serverDefinition?.hidden === true
        ) {
          throw new TypeError(
            `guided setup cannot change hidden MCP server: ${serverId}`,
          );
        }
        if (typeof enabled !== "boolean") {
          throw new TypeError(`toggle change must be boolean: ${serverId}`);
        }
      }
      if (entries.length === 0) {
        return { success: true, applied: false, changedServerIds: [] };
      }

      const mutation = await mutateMcpToggles(
        async (draft) => {
          const changedServerIds = [];
          const changedToggles = [];
          for (const [serverId, enabled] of entries) {
            if (draft[serverId] !== enabled) {
              changedToggles.push({
                serverId,
                before: draft[serverId] === true,
                after: enabled,
              });
              draft[serverId] = enabled;
              changedServerIds.push(serverId);
            }
          }
          return { changedServerIds, changedToggles };
        },
        {
          reason: "guided-setup-explicit-toggle-changes",
          // PORTICO-364: a malformed mcp_toggles.json during guided setup must
          // self-heal (back up + treat as empty), not dead-end setup.
          recoverFromParseError: true,
        },
      );
      const changedServerIds = mutation.mutationResult?.changedServerIds || [];
      console.info(
        `[Setup Audit] ${JSON.stringify({
          schemaVersion: 1,
          event: "guided_setup_toggle_patch",
          timestamp: new Date().toISOString(),
          setupOperationId: payload?.setupOperationId || null,
          setupMode: payload?.setupMode || null,
          setupReason: payload?.setupReason || null,
          source: "main-process",
          rootClassification: app.isPackaged
            ? "managed-runtime"
            : "repo-checkout",
          channel: bootstrap.getCurrentChannel?.() || "unknown",
          elapsedMs: null,
          safeErrorCode: null,
          changes: mutation.mutationResult?.changedToggles || [],
        })}`,
      );
      return {
        success: true,
        applied: changedServerIds.length > 0,
        changedServerIds,
      };
    } catch (error) {
      console.error("[IPC] Failed to apply guided setup MCP toggle changes:", error);
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "GUIDED_SETUP_TOGGLE_CHANGE_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  // Save MCP toggles
  ipcMain.handle("save-mcp-toggles", async (event, toggles) => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "save_mcp_toggles",
        source: "ipc",
      });
      await setMcpToggles(toggles, { reason: "save-mcp-toggles" });
      console.log("MCP toggles saved successfully");
      return { success: true };
    } catch (error) {
      console.error("Failed to save MCP toggles:", error);
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "SAVE_MCP_TOGGLES_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  // Read setup guide markdown file (for guided-setup)
  ipcMain.handle("read-setup-guide", async (event, guideName) => {
    try {
      const projectRoot = bootstrap.PROJECT_ROOT;
      if (!projectRoot) {
        return { success: false, error: "Project root not initialized" };
      }

      // Validate guideName to prevent path traversal
      if (!guideName || typeof guideName !== "string") {
        return { success: false, error: "Invalid guide name" };
      }

      // Only allow alphanumeric and hyphen characters in guide name
      if (!/^[a-zA-Z0-9-]+$/.test(guideName)) {
        return { success: false, error: "Invalid guide name format" };
      }

      const guidePath = path.join(
        projectRoot,
        "electron-app",
        "setup-guides",
        `${guideName}.md`,
      );

      // Validate path stays within expected directory
      const resolvedPath = path.resolve(guidePath);
      const expectedBase = path.resolve(
        path.join(projectRoot, "electron-app", "setup-guides"),
      );
      if (!resolvedPath.startsWith(expectedBase)) {
        return { success: false, error: "Invalid path" };
      }

      const content = await fsPromises.readFile(guidePath, "utf8");
      return { success: true, content };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { success: false, error: "Guide not found" };
      }
      return { success: false, error: err.message };
    }
  });

  // Read raw .env file content (for guided-setup, with validation)
  ipcMain.handle("read-env-file", async () => {
    try {
      const projectRoot = bootstrap.PROJECT_ROOT;
      if (!projectRoot) {
        return { success: false, error: "Project root not initialized" };
      }

      const envPath = path.join(projectRoot, ".env");

      // Validate path stays within project root (prevent path traversal)
      const resolvedPath = path.resolve(envPath);
      if (!resolvedPath.startsWith(path.resolve(projectRoot))) {
        return { success: false, error: "Invalid path" };
      }

      const content = await fsPromises.readFile(envPath, "utf8");
      return { success: true, content };
    } catch (err) {
      // File not found is not an error for this use case
      if (err.code === "ENOENT") {
        return { success: true, content: "" };
      }
      return { success: false, error: err.message };
    }
  });

  // Write raw .env file content (for guided-setup, with validation)
  ipcMain.handle("write-env-file", async (event, content) => {
    let releaseMutation = null;
    try {
      releaseMutation = await acquireGuidedSetupFinalizeLease({
        kind: "write_env_file",
        source: "guided_setup",
      });
      const projectRoot = bootstrap.PROJECT_ROOT;
      if (!projectRoot) {
        return { success: false, error: "Project root not initialized" };
      }

      // Validate content is a string
      if (typeof content !== "string") {
        return { success: false, error: "Content must be a string" };
      }

      // Prevent excessively large files (max 1MB for .env)
      if (content.length > 1024 * 1024) {
        return { success: false, error: "Content too large" };
      }

      const envPath = path.join(projectRoot, ".env");

      // Validate path stays within project root
      const resolvedPath = path.resolve(envPath);
      if (!resolvedPath.startsWith(path.resolve(projectRoot))) {
        return { success: false, error: "Invalid path" };
      }

      const identityResult = await currentUser.get();
      if (
        identityResult?.success !== true ||
        identityResult?.authenticated !== true ||
        !identityResult?.sessionSummary?.user?.id ||
        !identityResult?.sessionSummary?.user?.name
      ) {
        const error = new Error(
          identityResult?.error ||
            "Authenticated identity is unavailable for the environment update",
        );
        error.code =
          identityResult?.errorCode || "IDENTITY_RECONCILIATION_REQUIRED";
        throw error;
      }

      const user = identityResult.sessionSummary.user;
      const contentToWrite = writeCanonicalIdentityEnv(content, {
        userId: user.id,
        userName: user.name,
      });

      await writeProtectedRepositoryEnvAtomic(envPath, contentToWrite);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        errorCode: err.code || "WRITE_ENV_FILE_FAILED",
        activeOperation: err.activeOperation || null,
        activeMutation: err.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("upsert-runtime-secret", async (_event, key, value) => {
    let releaseMutation = null;
    try {
      releaseMutation = await acquireGuidedSetupFinalizeLease({
        kind: "upsert_runtime_secret",
        source: "guided_setup",
      });
      if (typeof key !== "string" || !key.trim()) {
        return { success: false, error: "Runtime secret key must be a non-empty string" };
      }
      const allowedRuntimeKeys = new Set(
        listRuntimeWritableSecretKeys({ projectRoot: bootstrap.PROJECT_ROOT }),
      );
      if (!allowedRuntimeKeys.has(key)) {
        return { success: false, error: `Runtime secret key is not allowed: ${key}` };
      }
      if (typeof value !== "string" || !value.trim()) {
        return { success: false, error: `Runtime secret value for ${key} is required` };
      }

      const managedRoot = process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT;
      upsertRuntimeSecret(key, value.trim(), {
        managedRoot,
        env: process.env,
        projectRoot: bootstrap.PROJECT_ROOT,
        resourcesPath: process.resourcesPath,
      });
      let regenerationWarning = "";
      try {
        await regenerateMcpInfrastructure(
          execPromise,
          bootstrap.PROJECT_ROOT,
          createMcpRuntimeEnv(),
          {
            isPackagedApp: app.isPackaged,
            resourcesPath: process.resourcesPath,
            timeout: 30000,
          },
        );
        dockerMcp.invalidateHostModeCaches?.();
        queueFullHealthCheck(`runtime-secret-updated:${key}`, {
          immediate: true,
        });
      } catch (error) {
        regenerationWarning = error.message;
        console.warn(
          `[IPC] MCP regeneration after secure secret update failed: ${error.message}`,
        );
      }
      return {
        success: true,
        ...(regenerationWarning ? { warning: regenerationWarning } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "UPSERT_RUNTIME_SECRET_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("get-mcp-sensitive-secret-presence", (_event, serverId) => {
    try {
      return {
        success: true,
        presence: getMcpSensitiveSecretPresence(serverId, {
          env: process.env,
          managedRoot:
            process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
          projectRoot: bootstrap.PROJECT_ROOT,
          resourcesPath: process.resourcesPath,
        }),
      };
    } catch (error) {
      return { success: false, error: error.message, presence: {} };
    }
  });
}

// ============================================================================
// UTILITY HANDLERS
// ============================================================================

function registerUtilityHandlers() {
  // Generic native notification (title + body). In-app DOM toasts are
  // retired: the renderer's global showNotification forwards every message
  // here so marketplace/config feedback stays visible. One-shot Notification,
  // no timers; chat-status notifications keep their own typed path
  // (show-chat-native-notification).
  ipcMain.handle("show-native-notification", (_event, payload = {}) => {
    const title =
      typeof payload?.title === "string" && payload.title.trim()
        ? payload.title.trim().slice(0, 160)
        : "Portico";
    const body =
      typeof payload?.body === "string" ? payload.body.trim().slice(0, 1000) : "";
    if (!body) {
      return { shown: false, error: "Notification body is required" };
    }
    try {
      if (!Notification.isSupported()) {
        return { shown: false, error: "Native notifications are unsupported" };
      }
      new Notification({ title, body }).show();
      return { shown: true };
    } catch (error) {
      console.warn(
        "[Main] Failed to show native notification:",
        error?.message || error,
      );
      return { shown: false, error: error?.message || String(error) };
    }
  });

  // Open URL in browser
  ipcMain.handle("open-url", async (_event, url) => {
    await openHttpExternalUrl(shell, url);
    return { success: true };
  });

  // Open external URL (alias for open-url, used by webview)
  ipcMain.handle("open-external", async (_event, url, context = {}) => {
    if (context?.kind === "oauth") {
      recordOAuthCorrelation({
        event: context.event || "authorization_opened",
        serverId: context.serverId,
        sessionId: context.sessionId,
        authorizationUrl: url,
        callbackReceived: false,
      });
    }
    await openHttpExternalUrl(shell, url);
    return { success: true };
  });

  ipcMain.handle("open-local-path", async (_event, targetPath) => {
    await openLocalPath(shell, targetPath);
    return { success: true };
  });

  ipcMain.handle("probe-url-status", async (_event, url) => {
    const MAX_BODY_BYTES = 2048;
    try {
      const urlObj = validateProbeUrl(url);
      const mod = urlObj.protocol === "https:" ? https : http;
      const { status, body } = await new Promise((resolve, reject) => {
        const req = mod.get(urlObj.toString(), { timeout: 3000 }, (res) => {
          const is4xx = res.statusCode >= 400 && res.statusCode < 500;
          if (!is4xx) {
            res.resume();
            resolve({ status: res.statusCode, body: null });
            return;
          }
          const chunks = [];
          let totalLen = 0;
          res.on("data", (chunk) => {
            if (totalLen < MAX_BODY_BYTES) {
              chunks.push(chunk);
              totalLen += chunk.length;
            }
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString("utf-8").slice(0, MAX_BODY_BYTES),
            });
          });
          res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Probe timed out"));
        });
      });
      return { success: true, status, body };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get username
  ipcMain.handle("get-username", async () => {
    try {
      const { stdout } = await execPromise("whoami");
      return { success: true, username: stdout.trim() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get build info with channel information
  ipcMain.handle("get-build-info", () => {
    console.log("Build info requested, returning:", buildInfo);
    const releaseChannelInfo = bootstrap.getCurrentChannelInfo();
    const releaseChannel = releaseChannelInfo.name;
    const releaseChannelKeyword = releaseChannelInfo.packageName;
    const channel =
      typeof buildInfo.channel === "string" && buildInfo.channel.trim().length > 0
        ? buildInfo.channel.trim()
        : "portico";

    return {
      ...buildInfo,
      channel: channel,
      releaseChannel,
      releaseChannelKeyword,
    };
  });

  ipcMain.handle("mark-setup-requirement-completed", () => {
    const requirement = loadCurrentSetupRequirement({
      resourcesPath: process.resourcesPath,
      appRoot: bootstrap.APP_ROOT,
    });

    if (!requirement.success) {
      return {
        success: false,
        error: `Failed to load setup requirement: ${requirement.error}`,
        path: requirement.path || null,
      };
    }

    const prerequisiteValidation = validateSetupCompletionPrerequisites({
      projectRoot: bootstrap.PROJECT_ROOT,
    });
    if (!prerequisiteValidation.success) {
      console.warn(
        `[IPC] Refusing to record setup completion (${prerequisiteValidation.reason}): ${prerequisiteValidation.error}`,
      );
      return {
        success: false,
        code: "SETUP_PREREQUISITE_INCOMPLETE",
        reason: prerequisiteValidation.reason,
        error: prerequisiteValidation.error,
      };
    }

    const result = markSetupRequirementCompleted({
      userDataPath: app.getPath("userData"),
      setupRequirementId: requirement.data.setupRequirementId,
      buildNumber: buildInfo.buildNumber,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to persist setup completion",
        path: result.path || null,
      };
    }

    return {
      success: true,
      setupRequirementId: requirement.data.setupRequirementId,
      path: result.path,
    };
  });

  // Get log file paths
  ipcMain.handle("get-log-paths", () => {
    const updatePreparation = require("./update-preparation");
    return {
      ...(getLogPaths() || {}),
      updatePrepFile:
        typeof updatePreparation.getActivePreparationLogPath === "function"
          ? updatePreparation.getActivePreparationLogPath()
          : null,
    };
  });

  // Collect diagnostic snapshot — one-shot, called on button press only
  // Returns structured JSON with Docker, MCP, system, and app-log sections
  // IPC/Communication layer → Observability layer
  ipcMain.handle('collect-diagnostic-snapshot', async () => {
    try {
      const data = await collectDiagnosticSnapshot();
      return { success: true, data };
    } catch (err) {
      logger.error('collect-diagnostic-snapshot IPC handler failed', { error: err.message, stack: err.stack });
      return { success: false, error: err.message };
    }
  });

  // Save diagnostic report — one-shot, called on form submit only
  // Generates reference ID server-side (Node crypto), writes JSON to diagnostics dir
  // IPC/Communication layer → State & Persistence layer
  ipcMain.handle('save-diagnostic-report', async (event, { snapshot, userDescription }) => {
    try {
      const referenceId = generateReferenceId();
      const result = await saveDiagnosticReport(referenceId, snapshot, userDescription);
      return { success: true, referenceId: result.referenceId, filePath: result.filePath, dir: getDiagnosticsDir() };
    } catch (err) {
      logger.error('save-diagnostic-report failed', { error: err.message, stack: err.stack });
      return { success: false, error: err.message };
    }
  });

  // Copy text to clipboard
  ipcMain.handle("copy-to-clipboard", async (event, text) => {
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("open-terminal-with-command", async (_event, command) => {
    return openTerminalWithCopiedCommand(command);
  });

  // Write plain text and/or HTML to the system clipboard for OWUI-hosted views.
  ipcMain.handle("clipboard-write", async (_event, payload = {}) => {
    const text =
      typeof payload?.text === "string"
        ? payload.text
        : payload?.text == null
          ? ""
          : String(payload.text);
    const html =
      typeof payload?.html === "string"
        ? payload.html
        : payload?.html == null
          ? ""
          : String(payload.html);

    if (!text && !html) {
      return false;
    }

    if (html) {
      clipboard.write({
        text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        html,
      });
      return true;
    }

    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("clipboard-read-text", async () => {
    return clipboard.readText();
  });

  // Get the authoritative app-wide theme from the main process
  ipcMain.handle("get-theme", () => {
    return state.appState.currentTheme;
  });

  // Set the app-wide theme and broadcast to every open BrowserWindow
  ipcMain.handle("set-theme", (event, theme) => {
    if (theme !== "dark" && theme !== "light") {
      return;
    }
    state.appState.currentTheme = theme;
    if (nativeTheme && typeof nativeTheme === "object") {
      nativeTheme.themeSource = theme;
    }
    const senderContentsId = event.sender.id;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (win.webContents.id === senderContentsId) continue;
      win.webContents.send("theme-changed", theme);
    }
  });
}

function registerSetupAuthHandlers() {
  ipcMain.handle("setup-auth-start", async () => {
    return await setupAuth.startSetupAuth();
  });

  ipcMain.handle("setup-auth-status", async () => {
    return setupAuth.getSetupAuthStatus();
  });

  ipcMain.handle("setup-auth-clear-error", async () => {
    return setupAuth.clearSetupAuthError();
  });

  ipcMain.handle("setup-auth-cached-session", async () => {
    return await setupAuth.getCachedSessionSummary();
  });
}

function registerCurrentUserHandlers() {
  ipcMain.handle("current-user-get", async () => {
    return await currentUser.get();
  });

  ipcMain.handle("current-user-ensure-authenticated", async () => {
    const result = await currentUser.ensureAuthenticated();
    if (result?.authenticated === true) {
      try {
        await userSkillReconciliation.reconcileUserSkills({
          projectRoot: bootstrap.PROJECT_ROOT,
        });
      } catch (error) {
        console.warn("[UserSkills] post-auth reconciliation deferred", {
          code: error?.code || "user_skill_reconciliation_failed",
        });
      }
    }
    return result;
  });

  ipcMain.handle("current-user-status", async () => {
    return currentUser.status();
  });

  ipcMain.handle("current-user-clear-error", async () => {
    return await currentUser.clearError();
  });

  // Silent identity backfill for an authenticated session missing its email
  // (PORTICO-414). Invoke-only; callers decide whether to escalate to an
  // interactive re-auth when this reports the email is unavailable.
  ipcMain.handle("current-user-repair-identity", async () => {
    return await currentUser.repairIdentity();
  });
}

function registerGitLabMarketplaceAuthHandlers() {
  ipcMain.handle("gitlab-marketplace-auth-status", async (event, host) => {
    return gitlabMarketplaceAuth.getStatus(host);
  });

  ipcMain.handle(
    "gitlab-marketplace-auth-ensure-authenticated",
    async (event, host) => {
      const result = await gitlabMarketplaceAuth.ensureAuthenticated(host);
      if (!result?.success) {
        return result;
      }

      return {
        success: true,
        authenticated: true,
        sessionSummary: result.sessionSummary,
        source: result.source,
      };
    },
  );

  ipcMain.handle("gitlab-marketplace-auth-clear-error", async (event, host) => {
    return gitlabMarketplaceAuth.clearError(host);
  });

  ipcMain.handle("gitlab-marketplace-auth-cached-session", async (event, host) => {
    return await gitlabMarketplaceAuth.getCachedSessionSummary(host);
  });
}

// ============================================================================
// OAUTH HANDLERS
// ============================================================================

function registerOAuthHandlers() {
  ipcMain.handle("get-oauth-status", async () => {
    try {
      const response = await fetch("http://localhost:8765/oauth/status");
      return await response.json();
    } catch (error) {
      console.error("Failed to get OAuth status:", error);
      return { error: error.message };
    }
  });

  ipcMain.handle("get-oauth-current", async () => {
    try {
      const response = await fetch("http://localhost:8765/oauth/current");
      return await response.json();
    } catch (error) {
      console.error("Failed to get current OAuth:", error);
      return { error: error.message };
    }
  });

  ipcMain.handle("get-oauth-pending", async () => {
    try {
      const response = await fetch("http://localhost:8765/oauth/pending");
      return await response.json();
    } catch (error) {
      console.error("Failed to get pending OAuth:", error);
      return { error: error.message, pending: [], waiting_callback: [] };
    }
  });

  ipcMain.handle("get-server-metadata", async (event, serverId) => {
    try {
      // Get metadata from MCP Assistant
      // Note: Tool name is prefixed with server ID (mcp_assistant_) after automatic prefixing change
      const mcpAssistantUrl =
        "http://localhost:8766/mcp-assistant/mcp_assistant_list_mcp_servers";
      const response = await fetch(mcpAssistantUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: "all", include_disabled: true }),
      });
      const data = await response.json();

      // Find the specific server
      const server = data.servers.find((s) => s.id === serverId);
      if (!server) {
        throw new Error(`Server not found: ${serverId}`);
      }

      // Load icon based on user_installed flag
      const configBase = server.user_installed
        ? "mcp-configs-user"
        : "mcp-configs";
      const iconPath = path.join(
        bootstrap.PROJECT_ROOT,
        configBase,
        serverId,
        `${serverId}.png`,
      );

      let iconData = null;
      let logoKind = null;
      if (fs.existsSync(iconPath)) {
        const iconBuffer = fs.readFileSync(iconPath);
        iconData = `data:image/png;base64,${iconBuffer.toString("base64")}`;
        logoKind = detectGuidedSetupLogoKind(iconBuffer);
      }

      return {
        ...server,
        icon: iconData,
        logoKind,
      };
    } catch (error) {
      console.error(`Failed to get server metadata for ${serverId}:`, error);
      return { error: error.message };
    }
  });

  ipcMain.handle(
    "poll-oauth-completion",
    async (event, serverId, timeoutMs = 300000) => {
      const startTime = Date.now();
      const pollInterval = 2000; // Poll every 2 seconds

      while (Date.now() - startTime < timeoutMs) {
        try {
          const response = await fetch("http://localhost:8765/oauth/status");
          const status = await response.json();

          // Check if this server is completed
          const completed = status.completed?.find(
            (s) => s.server_name === serverId,
          );
          if (completed) {
            return { success: true, completed: true, server: completed };
          }

          // Check if failed
          const failed = status.failed?.find((s) => s.server_name === serverId);
          if (failed) {
            return { success: false, failed: true, server: failed };
          }

          // Still waiting
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        } catch (error) {
          console.error(`OAuth polling error for ${serverId}:`, error);
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
      }

      return { success: false, timeout: true };
    },
  );

  // Refresh OAuth URL - clears stale state and generates fresh authorization URL
  ipcMain.handle("refresh-oauth-url", async (event, serverId) => {
    console.log(`[OAuth] Refreshing authorization URL for ${serverId}`);
    try {
      const response = await fetch(
        `http://localhost:8765/oauth/refresh/${serverId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const result = await response.json();
      console.log(
        `[OAuth] Refresh result for ${serverId}:`,
        result.success ? "success" : result.error,
      );
      return result;
    } catch (error) {
      console.error(
        `[OAuth] Failed to refresh OAuth URL for ${serverId}:`,
        error,
      );
      return { error: error.message, server_name: serverId };
    }
  });

  ipcMain.handle("clear-oauth-tokens", async (_event, serverId) => {
    try {
      const result = clearPersistedOAuthTokens(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        isCoreServer,
      });
      const tokenFilesCleared = Array.isArray(result.tokenFiles)
        ? result.tokenFiles.length
        : 0;
      const clientFilesCleared = Array.isArray(result.clientFiles)
        ? result.clientFiles.length
        : 0;
      console.log(
        `[OAuth] Cleared cached OAuth state for ${serverId}: cleared=${result.cleared} tokenFiles=${tokenFilesCleared} clientFiles=${clientFilesCleared} scope=${result.storageScope}`,
      );
      return result;
    } catch (error) {
      console.error(`[OAuth] Failed to clear tokens for ${serverId}:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prepare-oauth-start", async (_event, serverId) => {
    try {
      const result = clearLegacyOAuthFiles(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        isCoreServer,
      });
      const tokenFilesCleared = Array.isArray(result.tokenFiles)
        ? result.tokenFiles.length
        : 0;
      const clientFilesCleared = Array.isArray(result.clientFiles)
        ? result.clientFiles.length
        : 0;
      console.log(
        `[OAuth] Prepared fresh OAuth start for ${serverId}: preservedSecureRecord=true cleared=${result.cleared} tokenFiles=${tokenFilesCleared} clientFiles=${clientFilesCleared} scope=${result.storageScope}`,
      );
      return result;
    } catch (error) {
      console.error(`[OAuth] Failed to prepare OAuth start for ${serverId}:`, error);
      return { success: false, error: error.message };
    }
  });

  // Handle OAuth flow dismissal (when user clicks "Skip All")
  ipcMain.on("oauth-flow-dismissed", (event, serverId) => {
    console.log(`[OAuth] User dismissed OAuth flow for ${serverId}`);
    dismissedOAuthFlows.add(serverId);
  });

  ipcMain.on("oauth-flow-server-done", (event, serverId) => {
    console.log(`[OAuth] Wizard reports OAuth tokens persisted for ${serverId}`);
    state.completedOAuthFlows.add(serverId);
  });

  ipcMain.on("oauth-flow-contractor-denied", (event, serverId) => {
    console.log(`[OAuth] Contractor permissions denied for ${serverId} — blocking LLM auto-retries until wizard close`);
    state.contractorDeniedServers.add(serverId);
    dismissedOAuthFlows.add(serverId);
  });

  ipcMain.on("oauth-flow-contractor-acknowledged", (event, serverId) => {
    if (state.contractorDeniedServers.has(serverId)) {
      console.log(`[OAuth] Contractor-denied block cleared for ${serverId} — wizard acknowledged by user`);
      state.contractorDeniedServers.delete(serverId);
    }
  });

  // Handle guided setup completion (from mcp-config-modal)
  ipcMain.on("guided-setup-completed", (_event, payload = {}) => {
    const server_id =
      typeof payload.server_id === "string" ? payload.server_id.trim() : "";
    if (!server_id) {
      console.warn("[Guided Setup] Ignoring completion without server_id");
      return;
    }
    const result = buildGuidedSetupCompletionResult(payload);
    const flow_id = result.flow_id;
    console.log(`[Guided Setup] Setup outcome=${result.outcome} for ${server_id}${flow_id ? ` (flow=${flow_id})` : ''}`);
    const { guidedSetupResults, guidedSetupWaiters } = state;
    const waiter = guidedSetupWaiters.get(server_id);
    if (waiter) {
      if (waiter.flowId && flow_id && waiter.flowId !== flow_id) {
        console.warn(
          `[Guided Setup] Ignoring stale completion for ${server_id}: expected flow ${waiter.flowId}, received ${flow_id}`,
        );
        return;
      }
    }
    guidedSetupResults.set(server_id, result);
    if (waiter) {
      waiter.resolve(result);
      guidedSetupWaiters.delete(server_id);
    }

    // Bring the main window to the foreground — the user may have switched to
    // another app (e.g., browser) to copy a token/API key during setup.
    if (state.windows.main && !state.windows.main.isDestroyed()) {
      state.windows.main.show();
      state.windows.main.focus();
    }
    if (process.platform === "darwin") {
      try { require("electron").app.dock.bounce("informational"); } catch (_) {}
    }
  });

  ipcMain.handle("native-input-set-presentation", (event, payload = {}) => {
    const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
    // Single flow_id or a bounded flow_ids batch (the marketplace approval
    // modal parks/restores its whole batch in ONE call → one snapshot
    // broadcast instead of N).
    const flowIds = (
      Array.isArray(payload?.flow_ids) ? payload.flow_ids : [payload?.flow_id]
    )
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
      .slice(0, 50);
    const presentation =
      typeof payload?.presentation === "string" ? payload.presentation.trim() : "";
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!kind || !flowIds.length || !ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: "Invalid native-input presentation request" };
    }
    let applied = 0;
    for (const flowId of flowIds) {
      const entry = state.setNativeInputFlowPresentation(
        kind,
        flowId,
        presentation,
        ownerWindow.id,
      );
      if (entry) applied += 1;
    }
    if (!applied) {
      return { success: false, error: "Native-input flow is unavailable for this window" };
    }
    const snapshot = state.buildNativeInputPresentationSnapshot(ownerWindow.id);
    broadcastNativeInputPresentationSnapshot(ownerWindow.id);
    return { success: true, data: snapshot };
  });

  ipcMain.on("sensitive-info-completed", (event, payload = {}) => {
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
    if (!flowId) {
      console.warn("[Sensitive Info] Ignoring completion without flow_id");
      return;
    }

    const entry = state.sensitiveInfoFlowResults.get(flowId);
    if (!entry) {
      console.warn(`[Sensitive Info] Ignoring completion for unknown flow ${flowId}`);
      return;
    }
    if (entry.status !== "in_progress") {
      console.warn(
        `[Sensitive Info] Ignoring completion for ${flowId} because the flow is already ${entry.status}`,
      );
      return;
    }
    const completionWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      Number.isFinite(Number(entry.ownerWindowId)) &&
      (!completionWindow || Number(completionWindow.id) !== Number(entry.ownerWindowId))
    ) {
      console.warn(`[Sensitive Info] Ignoring completion for ${flowId} from a non-owning window`);
      return;
    }

    let result;
    try {
      if (payload.action === "submitted") {
        result = buildSensitiveInfoSubmittedResult(entry, payload.sensitive_value);
      } else if (payload.action === "dismissed") {
        result = buildSensitiveInfoDismissedResult(entry);
      } else {
        result = buildSensitiveInfoErrorResult(
          entry,
          payload.error || `Unknown sensitive-info completion action: ${payload.action || "missing"}`,
        );
      }
    } catch (error) {
      console.error(`[Sensitive Info] Failed to process completion for ${flowId}:`, error);
      result = buildSensitiveInfoErrorResult(
        entry,
        error?.message || "Failed to process sensitive information",
      );
    }

    const ownerWindowId = entry.ownerWindowId;
    state.completeSensitiveInfoFlow(flowId, result);
    notifyNativeInputTerminal(
      ownerWindowId,
      state.NATIVE_INPUT_FLOW_KINDS.SENSITIVE_INFO,
      flowId,
      result.status,
    );
    broadcastNativeInputPresentationSnapshot(ownerWindowId);

    if (state.windows.main && !state.windows.main.isDestroyed()) {
      state.windows.main.show();
      state.windows.main.focus();
    }
    if (process.platform === "darwin") {
      try { require("electron").app.dock.bounce("informational"); } catch (_) {}
    }
  });

  ipcMain.handle("chat-workspace-consent-open-path", async (event, payload = {}) => {
    try {
      const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
      if (!flowId) {
        throw new Error("flow_id is required");
      }

      const entry = state.chatWorkspaceConsentFlowResults.get(flowId);
      if (!entry || entry.status !== "in_progress") {
        throw new Error("Chat workspace consent flow is not active");
      }
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (
        Number.isFinite(Number(entry.ownerWindowId)) &&
        (!ownerWindow || Number(ownerWindow.id) !== Number(entry.ownerWindowId))
      ) {
        throw new Error("Chat workspace consent flow is unavailable for this window");
      }

      const openError = await shell.openPath(entry.hostPath);
      if (openError) {
        throw new Error(openError);
      }
      return {
        success: true,
        path: entry.hostPath,
      };
    } catch (error) {
      console.error("[Workspace Consent] Failed to open requested path:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on("chat-workspace-consent-completed", async (event, payload = {}) => {
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
    if (!flowId) {
      console.warn("[Workspace Consent] Ignoring completion without flow_id");
      return;
    }

    const entry = state.chatWorkspaceConsentFlowResults.get(flowId);
    if (!entry) {
      console.warn(`[Workspace Consent] Ignoring completion for unknown flow ${flowId}`);
      return;
    }
    if (entry.status !== "in_progress") {
      console.warn(
        `[Workspace Consent] Ignoring completion for ${flowId} because the flow is already ${entry.status}`,
      );
      return;
    }
    const completionWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      Number.isFinite(Number(entry.ownerWindowId)) &&
      (!completionWindow || Number(completionWindow.id) !== Number(entry.ownerWindowId))
    ) {
      console.warn(`[Workspace Consent] Ignoring completion for ${flowId} from a non-owning window`);
      return;
    }

    let result;
    try {
      if (payload.action === "approved") {
        const applicationResult = await validateAndApplyChatWorkspaceSelection({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId: entry.chatId,
          hostPath: entry.hostPath,
        });
        result = buildChatWorkspaceConsentAppliedResult(entry, applicationResult);
        emitChatWorkspaceSelectionUpdated({
          chatId: entry.chatId,
          flowEntry: entry,
          applicationResult,
          modalTarget: payload.modal_target,
        });
        emitLinkedChatWorkspaceFanOutUpdates(applicationResult?.fanOut);
      } else if (payload.action === "dismissed") {
        result = buildChatWorkspaceConsentDismissedResult(entry);
      } else {
        result = buildChatWorkspaceConsentErrorResult(
          entry,
          payload.error || `Unknown chat-workspace consent completion action: ${payload.action || "missing"}`,
        );
      }
    } catch (error) {
      console.error(`[Workspace Consent] Failed to process completion for ${flowId}:`, error);
      result = buildChatWorkspaceConsentErrorResult(
        entry,
        error?.message || "Failed to apply chat workspace",
      );
    }

    const ownerWindowId = entry.ownerWindowId;
    state.completeChatWorkspaceConsentFlow(flowId, result);
    notifyNativeInputTerminal(
      ownerWindowId,
      state.NATIVE_INPUT_FLOW_KINDS.CHAT_WORKSPACE_CONSENT,
      flowId,
      result.status,
    );
    broadcastNativeInputPresentationSnapshot(ownerWindowId);

    if (state.windows.main && !state.windows.main.isDestroyed()) {
      state.windows.main.show();
      state.windows.main.focus();
    }
    if (process.platform === "darwin") {
      try { require("electron").app.dock.bounce("informational"); } catch (_) {}
    }
  });

  // AI Marketplace publish-confirmation modal completion (round 9). Completes
  // the marketplace_publish flow and resolves the waiter the blocked
  // /api/ai-marketplace/* route is awaiting. Mirrors the workspace-consent
  // completion handler above (flow/owner checks, terminal notify, snapshot).
  ipcMain.on("ai-marketplace-publish-confirm-completed", (event, payload = {}) => {
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
    if (!flowId) {
      console.warn("[Marketplace Publish] Ignoring completion without flow_id");
      return;
    }

    const entry = state.marketplacePublishFlowResults.get(flowId);
    if (!entry) {
      console.warn(`[Marketplace Publish] Ignoring completion for unknown flow ${flowId}`);
      return;
    }
    if (entry.status !== "in_progress") {
      console.warn(
        `[Marketplace Publish] Ignoring completion for ${flowId} because the flow is already ${entry.status}`,
      );
      return;
    }
    const completionWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      Number.isFinite(Number(entry.ownerWindowId)) &&
      (!completionWindow || Number(completionWindow.id) !== Number(entry.ownerWindowId))
    ) {
      console.warn(`[Marketplace Publish] Ignoring completion for ${flowId} from a non-owning window`);
      return;
    }

    // Non-terminal phase marker: the consolidated agent-publish modal starts
    // executing the approved publish in the renderer. Swap the confirm
    // deny-timer for the publish budget (api.js entry.onPublishing) and keep
    // the flow open — no completion, no terminal notify, no snapshot churn.
    if (payload.action === "publishing") {
      if (typeof entry.onPublishing === "function") {
        entry.onPublishing();
      }
      return;
    }

    let result;
    if (payload.action === "approved") {
      result = buildMarketplacePublishApprovedResult(entry);
    } else if (payload.action === "published") {
      result = buildMarketplacePublishPublishedResult(entry, payload);
    } else if (payload.action === "publish_failed") {
      result = buildMarketplacePublishFailedResult(entry, payload);
    } else if (payload.action === "denied" || payload.action === "dismissed") {
      result = buildMarketplacePublishDeniedResult(entry);
    } else {
      result = buildMarketplacePublishErrorResult(
        entry,
        payload.error ||
          `Unknown marketplace publish completion action: ${payload.action || "missing"}`,
        payload.code,
      );
    }

    const ownerWindowId = entry.ownerWindowId;
    state.completeMarketplacePublishFlow(flowId, result);
    notifyNativeInputTerminal(
      ownerWindowId,
      state.NATIVE_INPUT_FLOW_KINDS.MARKETPLACE_PUBLISH,
      flowId,
      result.status,
    );
    broadcastNativeInputPresentationSnapshot(ownerWindowId);
    if (typeof entry.resolveDecision === "function") {
      entry.resolveDecision(marketplacePublishDecisionFromResult(result));
    }
  });

  // Handle OAuth logging from renderer (Frontend)
  ipcMain.handle(
    "log-oauth-event",
    async (event, { layer, level, message }) => {
      try {
        const { logOAuth } = require("./oauth-logger");
        logOAuth(layer || "Frontend", level || "INFO", message || "");
        return { success: true };
      } catch (error) {
        // OAuth logger may not be initialized yet
        console.log(`[OAuth:${layer || "Frontend"}] ${message || ""}`);
        return { success: true, fallback: true };
      }
    },
  );

  // ============================================================================
  // SINGLE-SERVER OAUTH HANDLERS (dynamic host ports)
  // ============================================================================

  // Helper: Fetch JSON with retry (handles nginx startup race condition)
  async function fetchJsonWithRetry(
    url,
    options = {},
    retries = [1000, 2000, 4000, 4000],
  ) {
    let lastError;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      try {
        const response = await fetch(url, options);
        const text = await response.text();

        // Check if response looks like HTML (nginx error page)
        if (text.startsWith("<")) {
          throw new Error(
            `Server returned HTML instead of JSON (likely not ready yet)`,
          );
        }

        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        if (attempt < retries.length) {
          const delay = retries[attempt];
          console.log(
            `[OAuth Single] Fetch failed, retrying in ${delay}ms... (attempt ${attempt + 1}/${retries.length + 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  ipcMain.handle("get-single-mcp-server-base-url", async (_event, options = {}) => {
    const session = getOwnedSingleServerSession(options?.sessionId);
    if (!session) {
      return staleSingleServerSessionResult();
    }
    return {
      success: true,
      state: session.state,
      baseUrl: getSingleServerBaseUrl(session),
      hostPort: session.hostPort,
      callbackPort: session.callbackPort,
      sessionId: session.sessionId,
    };
  });

  // Get OAuth status from single-server stack
  ipcMain.handle("get-oauth-status-single", async (_event, options = {}) => {
    const session = getOwnedSingleServerSession(options?.sessionId);
    if (!session) {
      return staleSingleServerSessionResult();
    }
    const baseUrl = getSingleServerBaseUrl(session);
    try {
      const result = await fetchJsonWithRetry(`${baseUrl}/oauth/status`);
      if (!getOwnedSingleServerSession(options?.sessionId)) {
        return staleSingleServerSessionResult();
      }
      return result;
    } catch (error) {
      console.error("[OAuth Single] Failed to get OAuth status:", error);
      return { error: error.message };
    }
  });

  // Refresh OAuth URL on single-server stack
  ipcMain.handle("refresh-oauth-url-single", async (_event, serverId, options = {}) => {
    const session = getOwnedSingleServerSession(options?.sessionId, serverId);
    if (!session) {
      return staleSingleServerSessionResult();
    }
    console.log(`[OAuth Single] Refreshing authorization URL for ${serverId}`);
    const baseUrl = getSingleServerBaseUrl(session);
    try {
      const result = await fetchJsonWithRetry(
        `${baseUrl}/oauth/refresh/${serverId}`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!getOwnedSingleServerSession(options?.sessionId, serverId)) {
        return staleSingleServerSessionResult();
      }
      console.log(
        `[OAuth Single] Refresh result for ${serverId}:`,
        result.success ? "success" : result.error,
      );
      return result;
    } catch (error) {
      console.error(
        `[OAuth Single] Failed to refresh OAuth URL for ${serverId}:`,
        error,
      );
      return { error: error.message, server_name: serverId };
    }
  });

  // Poll OAuth completion on single-server stack
  ipcMain.handle(
    "poll-oauth-completion-single",
    async (_event, serverId, timeoutMs = 300000, options = {}) => {
      const sessionId = options?.sessionId;
      if (!getOwnedSingleServerSession(sessionId, serverId)) {
        return staleSingleServerSessionResult();
      }
      const startTime = Date.now();
      const pollInterval = 2000; // Poll every 2 seconds
      const baseUrl = getSingleServerBaseUrl(
        getOwnedSingleServerSession(sessionId, serverId),
      );
      let lastProgress = null;

      console.log(
        `[OAuth Single] Starting poll for ${serverId} completion (timeout: ${timeoutMs}ms)`,
      );

      while (Date.now() - startTime < timeoutMs) {
        if (!getOwnedSingleServerSession(sessionId, serverId)) {
          return staleSingleServerSessionResult();
        }
        try {
          const response = await fetch(`${baseUrl}/oauth/status`);
          const text = await response.text();
          if (!getOwnedSingleServerSession(sessionId, serverId)) {
            return staleSingleServerSessionResult();
          }

          // Handle HTML responses (nginx not ready or error page)
          if (text.startsWith("<")) {
            console.log(
              `[OAuth Single] Server returned HTML (not ready), retrying...`,
            );
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            continue;
          }

          const status = JSON.parse(text);

          // Check if this server is completed
          const completed = status.completed?.find(
            (s) => s.server_name === serverId,
          );
          if (completed) {
            console.log(
              `[OAuth Single] ${serverId} completed OAuth successfully`,
            );
            recordOAuthCorrelation({
              event: "callback_received",
              serverId,
              sessionId,
              callbackReceived: true,
            });
            // The bootstrap container holds the freshly captured token only in
            // its own ephemeral storage. Import it into host safeStorage before
            // reporting success, or the credential is lost on teardown. Fail
            // closed if the import does not succeed.
            const imported = await importBootstrapOAuthRecord(
              serverId,
              sessionId,
            );
            if (!imported.success) {
              console.error(
                `[OAuth Single] Failed to import OAuth record for ${serverId}: ${imported.error} (reason=${imported.reason})`,
              );
              return {
                success: false,
                failed: true,
                server: {
                  server_name: serverId,
                  error_message: `OAuth completed but the credential could not be saved: ${imported.error}`,
                },
              };
            }
            return {
              success: true,
              completed: true,
              server: completed,
              imported: true,
            };
          }

          // Check if failed
          const failed = status.failed?.find((s) => s.server_name === serverId);
          if (failed) {
            console.log(
              `[OAuth Single] ${serverId} OAuth failed:`,
              failed.error_message,
            );
            recordOAuthCorrelation({
              event: "authorization_failed",
              serverId,
              sessionId,
              callbackReceived: false,
            });
            return { success: false, failed: true, server: failed };
          }

          // Check if server-side timeout (handshake expired without callback)
          const timedOut = status.timeout?.find((s) => s.server_name === serverId);
          if (timedOut) {
            console.log(
              `[OAuth Single] ${serverId} OAuth server-side timeout:`,
              timedOut.error_message,
            );
            recordOAuthCorrelation({
              event: "callback_timeout",
              serverId,
              sessionId,
              callbackReceived: false,
            });
            return { success: false, failed: true, server: timedOut, serverTimeout: true };
          }

          const checking = status.checking?.find(
            (s) => s.server_name === serverId,
          );
          lastProgress = checking
            ? { checking: true, server: checking }
            : null;

          // Still waiting — caller (renderer outer loop) controls pacing.
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        } catch (error) {
          // Server not ready yet, continue polling
          console.log(
            `[OAuth Single] Polling error (will retry): ${error.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
      }

      console.log(
        `[OAuth Single] ${serverId} OAuth timed out after ${timeoutMs}ms`,
      );
      recordOAuthCorrelation({
        event: "callback_timeout",
        serverId,
        sessionId,
        callbackReceived: false,
      });
      return { success: false, timeout: true, ...(lastProgress || {}) };
    },
  );

  // Check that terminal OAuth success also produced durable token and client files.
  ipcMain.handle("check-oauth-tokens-exist", async (event, serverId) => {
    try {
      const result = checkPersistedOAuthTokens(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        isCoreServer,
      });
      if (result.exists) {
        console.log(
          `[OAuth] Tokens verified for ${serverId}: scope=${result.storageScope}`,
        );
      } else {
        console.log(
          `[OAuth] Token verification incomplete for ${serverId}: reason=${result.reason}, scope=${result.storageScope}`,
        );
      }
      return result;
    } catch (error) {
      console.error(`[OAuth] Error checking tokens for ${serverId}:`, error);
      return { exists: false, reason: "error", error: error.message };
    }
  });
}

// ============================================================================
// HEALTH CHECK HANDLERS
// ============================================================================

function registerHealthHandlers() {
  ipcMain.handle("rerun-health-check", async () => {
    try {
      console.log("[Health] Re-running health check...");
      const healthStatus = await runHealthCheckAndBroadcast({
        mode: "full",
        reason: "manual-rerun",
        waitForLock: true,
      });
      if (!healthStatus) {
        throw new Error("Health check did not produce a status snapshot");
      }

      console.log("[Health] Health check completed successfully");
      return { success: true, output: JSON.stringify(healthStatus) };
    } catch (error) {
      console.error("[Health] Health check failed:", error);
      return {
        success: false,
        error: error.message,
        output: error.stdout || "",
      };
    }
  });

  ipcMain.handle("get-health-status", async () => {
    try {
      const healthStatusFile = path.join(
        bootstrap.PROJECT_ROOT,
        "health-status",
        "health_status.json",
      );
      const runtimeSyncState = getHealthSyncState();

      if (!fs.existsSync(healthStatusFile)) {
        return {
          error: "Health status not available yet",
          sync: runtimeSyncState,
        };
      }

      const rawData = fs.readFileSync(healthStatusFile, "utf8");
      const parsed = overlayStartupFailures(
        JSON.parse(rawData),
        bootstrap.PROJECT_ROOT,
        { logger: console },
      );

      const staleThresholdMs = Math.max(
        1000,
        Number.parseInt(process.env.HEALTH_STATUS_STALE_MS || "120000", 10) ||
          120000,
      );

      let sourceTimestampMs = 0;
      if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
        sourceTimestampMs = Math.round(parsed.timestamp * 1000);
      } else if (typeof parsed.timestamp_iso === "string") {
        const parsedIso = Date.parse(parsed.timestamp_iso);
        if (Number.isFinite(parsedIso)) {
          sourceTimestampMs = parsedIso;
        }
      }

      if (!sourceTimestampMs) {
        return {
          ...parsed,
          sync: runtimeSyncState,
          stale: true,
          staleReason: "missing_timestamp",
          sourceTimestamp: null,
        };
      }

      const ageMs = Date.now() - sourceTimestampMs;
      const stale = ageMs > staleThresholdMs;

      return {
        ...parsed,
        sync: {
          ...(parsed.sync || {}),
          ...runtimeSyncState,
        },
        stale,
        staleReason: stale ? `age_exceeded_${staleThresholdMs}ms` : null,
        sourceTimestamp: new Date(sourceTimestampMs).toISOString(),
      };
    } catch (error) {
      console.error("[Health] Failed to read health status:", error);
      return { error: error.message };
    }
  });

  ipcMain.handle("check-open-webui-ready", async () => {
    const url = "http://localhost:3789/";
    const timeoutMs = 2000;

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
          const statusCode = res.statusCode || 0;
          res.resume();
          res.on("end", () => resolve({ statusCode }));
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });

      const ready = result.statusCode >= 200 && result.statusCode < 300;

      if (ready) {
        void scanOpenWebuiDbCorruption({
          reason: "check-open-webui-ready",
          forceScan: false,
          forceBroadcast: false,
        }).catch((scanError) => {
          console.warn(
            `[Health] Open WebUI corruption scan failed: ${scanError.message}`,
          );
        });
      }

      return { ready, statusCode: result.statusCode };
    } catch (error) {
      return { ready: false, error: error.message };
    }
  });

  ipcMain.handle("detect-open-webui-db-corruption", async (event, options = {}) => {
    try {
      return await scanOpenWebuiDbCorruption({
        reason: options.reason || "manual",
        forceScan: options.forceScan === true,
        forceBroadcast: options.forceBroadcast === true,
        lines: options.lines,
      });
    } catch (error) {
      return { success: false, detected: false, error: error.message };
    }
  });

  ipcMain.handle("repair-open-webui-db", async (event, options = {}) => {
    try {
      return await repairOpenWebuiDb(options || {});
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "restore-open-webui-db-from-backup",
    async (event, options = {}) => {
      try {
        return restoreOpenWebuiDbFromBackup({
          projectRoot: bootstrap.PROJECT_ROOT,
          candidateId: options?.candidateId,
          backupPath: options?.backupPath,
          buildNumber: buildInfo.buildNumber || null,
        });
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle(
    "rollback-open-webui-db-repair",
    async (event, options = {}) => {
      try {
        return await rollbackOpenWebuiDbRepair(options || {});
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("start-health-monitoring", async () => {
    startContinuousHealthChecks();
    return { success: true };
  });

  ipcMain.handle("stop-health-monitoring", async () => {
    stopContinuousHealthChecks();
    return { success: true };
  });

  ipcMain.handle("get-last-health-status", async () => {
    const lastStatus = getLastHealthStatus();
    return lastStatus || { error: "No health status available" };
  });

  // Main-process API handlers keep privileged operations independent of renderer
  // origin/CORS behavior.
  ipcMain.handle("api-restart-mcp", async () => {
    console.log("[IPC] api-restart-mcp called");
    try {
      sendInitLog("[API-IPC] Starting MCP restart via IPC...\n", "info");

      if (mcpOperationCoordinator) {
        const rawToggleState = loadRawMcpToggles({ includeMeta: true });
        if (rawToggleState.parseError) {
          return {
            success: false,
            errorCode: "MCP_TOGGLES_PARSE_ERROR",
            error: rawToggleState.parseError.message,
          };
        }
        const enabledServerIds = Object.entries(
          computeEffectiveMcpToggles(rawToggleState.toggles || {}),
        )
          .filter(([, enabled]) => enabled === true)
          .map(([serverId]) => serverId)
          .filter((serverId) => isKnownMcpServerId(serverId));
        if (enabledServerIds.length === 0) {
          return {
            success: true,
            message: "No enabled MCP servers require restart",
            results: [],
            errors: [],
          };
        }
        const operationResult = await startAndWaitForMcpOperation({
          clientRequestId: crypto.randomUUID(),
          kind: "restart",
          serverIds: enabledServerIds,
        });
        return {
          ...operationResult,
          message: operationResult.success
            ? "MCP servers restarted successfully"
            : operationResult.error || "MCP server restart failed",
        };
      }

      // Selective test harnesses may register this handler without the MCP
      // operation coordinator. Production registration always uses the path
      // above.
      const result = await runMcpInitialization();

      if (result.success) {
        sendInitLog(
          "[API-IPC] MCP restart completed successfully\n",
          "success",
        );
        queueFullHealthCheck("mcp-restart", { immediate: true });
        console.log("[IPC] MCP restart completed successfully");
        return { success: true, message: "MCP servers restarted successfully" };
      } else {
        sendInitLog(`[API-IPC] MCP restart failed: ${result.error}\n`, "error");
        queueFullHealthCheck("mcp-restart-failed", { immediate: true });
        console.error("[IPC] MCP restart failed:", result.error);
        return { success: false, error: result.error, logs: result.logs };
      }
    } catch (error) {
      sendInitLog(`[API-IPC] MCP restart error: ${error.message}\n`, "error");
      console.error("[IPC] api-restart-mcp error:", error);
      return {
        success: false,
        errorCode: error.code || "MCP_OPERATION_FAILED",
        error: error.message,
        operationId: error.activeOperation?.operationId || null,
        activeOperation: error.activeOperation || null,
      };
    }
  });

  ipcMain.handle("api-health-check", async () => {
    console.log("[IPC] api-health-check called - bypassing HTTP API");
    try {
      // Run health check and get results
      const healthStatus = await runHealthCheckAndBroadcast({
        mode: "light",
        reason: "manual-refresh",
        waitForLock: false,
      });
      return { success: true, status: "ok", data: healthStatus };
    } catch (error) {
      console.error("[IPC] api-health-check error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "wait-post-oauth-server-recovery",
    async (event, serverId, options = {}) => {
      console.log(`[IPC] wait-post-oauth-server-recovery called for ${serverId}`);
      try {
        const { waitForPostOauthServerRecovery } = require("./api");
        const result = await waitForPostOauthServerRecovery(serverId, options);
        queueFullHealthCheck(`oauth-complete:${serverId}`, { immediate: true });
        return { success: true, ...result };
      } catch (error) {
        console.error(
          `[IPC] wait-post-oauth-server-recovery error for ${serverId}:`,
          error,
        );
        return { success: false, healthy: false, error: error.message };
      }
    },
  );

  // Restart multiple specific MCP servers (for targeted restart after OAuth)
  ipcMain.handle(
    "api-restart-mcp-servers",
    async (event, serverIds, options = {}) => {
      console.log(
        `[IPC] api-restart-mcp-servers called for ${serverIds.length} server(s): ${serverIds.join(", ")}`,
      );
      try {
        if (mcpOperationCoordinator) {
          return await startAndWaitForMcpOperation({
            clientRequestId: options.clientRequestId || crypto.randomUUID(),
            kind: "restart",
            serverIds,
          });
        }
        const { restartMcpoServers } = require("./docker-mcp");
        const result = await restartMcpoServers(serverIds);

        const waitForHealth = options.waitForHealth === true;

        if (!result.success) {
          console.error("[IPC] MCP servers restart had errors:", result.errors);
          queueFullHealthCheck("mcp-servers-restart", { immediate: true });
          return {
            success: false,
            results: result.results,
            errors: result.errors,
            error: result.errors?.[0] || "MCP server restart failed",
          };
        }

        let healthResults = [];
        if (waitForHealth) {
          const waitOptions = {
            maxWaitMs: options.maxWaitMs,
            pollIntervalMs: options.pollIntervalMs,
          };
          const targets = result.results
            .filter((r) => r.success)
            .map((r) => r.serverId);
          for (const serverId of targets) {
            const waitResult = await waitForServerHealthy(
              serverId,
              waitOptions,
            );
            healthResults.push({ serverId, ...waitResult });
            if (!waitResult.healthy) {
              console.error(`[IPC] ${serverId} did not become healthy`);
              queueFullHealthCheck("mcp-servers-restart", { immediate: true });
              return {
                success: false,
                results: result.results,
                errors: [`${serverId}: health check timeout`],
                error: `${serverId}: health check timeout`,
                health: healthResults,
              };
            }
          }

          await runHealthCheckAndBroadcast({
            mode: "full",
            reason: "mcp-servers-restart",
            waitForLock: true,
          });
        } else {
          queueFullHealthCheck("mcp-servers-restart", { immediate: true });
        }

        console.log(
          `[IPC] MCP servers restart completed: ${result.results.filter((r) => r.success).length} succeeded`,
        );
        return {
          success: true,
          results: result.results,
          health: healthResults,
        };
      } catch (error) {
        console.error("[IPC] api-restart-mcp-servers error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Restart all MCP server containers (MCP-only, not full infrastructure)
  ipcMain.handle("api-restart-all-mcp-servers", async () => {
    console.log("[IPC] api-restart-all-mcp-servers called");
    try {
      if (mcpOperationCoordinator) {
        const rawToggleState = loadRawMcpToggles({ includeMeta: true });
        if (rawToggleState.parseError) {
          return {
            success: false,
            errorCode: "MCP_TOGGLES_PARSE_ERROR",
            error: rawToggleState.parseError.message,
          };
        }
        const enabledServerIds = Object.entries(
          computeEffectiveMcpToggles(rawToggleState.toggles || {}),
        )
          .filter(([, enabled]) => enabled === true)
          .map(([serverId]) => serverId)
          .filter((serverId) => isKnownMcpServerId(serverId));
        if (enabledServerIds.length === 0) {
          return { success: true, restarted: [], results: [], errors: [] };
        }
        const operationResult = await startAndWaitForMcpOperation({
          clientRequestId: crypto.randomUUID(),
          kind: "restart",
          serverIds: enabledServerIds,
        });
        return {
          ...operationResult,
          restarted: operationResult.results
            .filter((entry) => entry.success)
            .map((entry) => entry.serverId),
        };
      }
      const { restartAllMcpoServers } = require("./docker-mcp");
      const result = await restartAllMcpoServers();

      // Run health check after restart
      queueFullHealthCheck("mcp-restart-all", { immediate: true });

      if (result.success) {
        console.log(
          `[IPC] All MCP servers restart completed: ${result.restarted.length} containers`,
        );
        return { success: true, restarted: result.restarted };
      } else {
        console.error(
          "[IPC] All MCP servers restart had errors:",
          result.errors,
        );
        return {
          success: false,
          restarted: result.restarted,
          errors: result.errors,
        };
      }
    } catch (error) {
      console.error("[IPC] api-restart-all-mcp-servers error:", error);
      return { success: false, error: error.message };
    }
  });
}

// ============================================================================
// UPDATE CHECK HANDLERS
// ============================================================================

function registerUpdateCheckHandlers() {
  // Check for updates
  ipcMain.handle("check-for-updates", async () => {
    try {
      console.log("Checking for updates using Cloudsmith");
      const updateInfo = await checkForUpdates();
      if (updateInfo?.error) {
        return {
          ...updateInfo,
          success: false,
          updateSource: "cloudsmith",
        };
      }
      return { success: true, updateSource: "cloudsmith", ...updateInfo };
    } catch (error) {
      console.error("Update check failed:", error);
      return { success: false, error: error.message, updateSource: "cloudsmith" };
    }
  });
}

// ============================================================================
// MCP SERVER MANAGEMENT HANDLERS
// ============================================================================

/**
 * Helper function to scan a single MCP configs directory
 */
async function scanMcpConfigDirectory(configPath, isUserInstalled = false) {
  const servers = [];

  // Check if directory exists
  if (!fs.existsSync(configPath)) {
    console.log(`Directory not found: ${configPath}`);
    return servers;
  }

  console.log(
    `Scanning MCP servers from: ${configPath} (user_installed: ${isUserInstalled})`,
  );

  // Clean up known deprecated/renamed server directories
  // These are servers that were renamed or removed in newer versions
  const DEPRECATED_SERVERS = ["run-sub-agent"]; // Renamed to 'subagents'
  for (const deprecatedServer of DEPRECATED_SERVERS) {
    const deprecatedPath = path.join(configPath, deprecatedServer);
    if (fs.existsSync(deprecatedPath)) {
      console.log(`  [CLEANUP] Cleaning up deprecated server: ${deprecatedServer}`);
      try {
        fs.rmSync(deprecatedPath, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `  [WARN] Could not clean up ${deprecatedServer}:`,
          err.message,
        );
      }
    }
  }

  // Read all subdirectories
  const subdirs = await fsPromises.readdir(configPath, { withFileTypes: true });

  for (const dirent of subdirs) {
    if (dirent.isDirectory() && !dirent.name.startsWith(".")) {
      const serverDir = dirent.name;
      const serverPath = path.join(configPath, serverDir);
      const yamlPath = path.join(configPath, serverDir, `${serverDir}.yaml`);
      const mdPath = path.join(configPath, serverDir, `${serverDir}.md`);
      const fragmentPath = path.join(
        configPath,
        serverDir,
        `${serverDir}.fragment`,
      );
      const iconPath = path.join(configPath, serverDir, `${serverDir}.png`);

      // Skip directories without valid YAML config (orphaned directories)
      if (!fs.existsSync(yamlPath)) {
        console.log(`  [SKIP] Skipping ${serverDir}: no YAML config found`);
        continue;
      }

      try {
        // Read YAML file to get server metadata
        const yamlContent = await fsPromises.readFile(yamlPath, "utf8");
        const serverData = parseYaml(yamlContent);
        const serverId = serverData.id || serverDir;

        // Ensure configData is initialized
        if (!configData) resetConfigData();

        // Check if server is configured. User-installed servers use the same
        // required_env_vars check as bundled servers (PORTICO-224): servers with
        // no required vars stay "configured"; declared vars gate on stored
        // values so the Configure flow surfaces.
        const isConfigured = checkServerConfigured(serverData, configData.env);
        const runtimeTarget =
          (serverData.deployment_type || "docker") === "host"
            ? null
            : dockerMcp.getConfiguredMcpoRuntimeTarget(serverId);
        let hasOAuthTokens = false;
        if (serverSupportsOAuth(serverData)) {
          try {
            hasOAuthTokens =
              checkPersistedOAuthTokens(serverId, {
                projectRoot: bootstrap.PROJECT_ROOT,
                isCoreServer,
              }).exists === true;
          } catch (tokenError) {
            console.warn(
              `Could not verify OAuth tokens for ${serverId}: ${tokenError.message}`,
            );
          }
        }

        // Check if icon exists and read it as base64
        let iconData = null;
        let logoKind = null;
        try {
          if (fs.existsSync(iconPath)) {
            const iconBuffer = await fsPromises.readFile(iconPath);
            iconData = `data:image/png;base64,${iconBuffer.toString("base64")}`;
            logoKind = detectGuidedSetupLogoKind(iconBuffer);
          }
        } catch (iconErr) {
          console.log(`No icon found for ${serverDir}`);
        }

        servers.push({
          id: serverId,
          folderId: serverDir,
          server_path: serverPath,
          name: serverData.display_name || serverData.name || serverDir,
          description: serverData.description || "",
          experimental: serverData.experimental || false,
          deprecated: serverData.deprecated === true,
          deploymentType: serverData.deployment_type || "docker",
          isCore: serverData.is_core === true,
          userInstalled: serverData.user_installed === true || isUserInstalled,
          useCases: serverData.use_cases || [],
          // Normalize bare-string entries (hand-edited yaml) to the object
          // form every consumer (config modal, requirements) expects.
          requiredVars: (serverData.required_env_vars || []).map((entry) =>
            typeof entry === "string" ? { name: entry } : entry,
          ),
          presetVars: serverData.preset_env_vars || [],
          approvalNote: serverData.approval_note || "",
          approvalWarning: serverData.approval_warning || false,
          isConfigured: isConfigured,
          setupMarkdown: await fsPromises
            .readFile(mdPath, "utf8")
            .catch(() => ""),
          fragment: await fsPromises
            .readFile(fragmentPath, "utf8")
            .catch(() => "{}"),
          icon: iconData, // Add icon data as base64
          logoKind,
          oauth: serverData.oauth || null, // OAuth configuration from YAML
          hasOAuthTokens,
          guidedSetupDescription: serverData.guided_setup_description || "",
          runtimeContainerName: runtimeTarget?.containerName || null,
          runtimeComposeService: runtimeTarget?.composeService || null,
          runtimeGroupId: runtimeTarget?.groupId || null,
        });

        console.log(
          `  [OK] Loaded ${isUserInstalled ? "user-installed" : "system"} server: ${serverDir}`,
        );
      } catch (err) {
        console.error(`Error loading server ${serverDir}:`, err);
      }
    }
  }

  return servers;
}

function registerMcpServerHandlers() {
  // Load MCP server configurations from both system and user directories
  ipcMain.handle("load-mcp-servers", async () => {
    try {
      const systemConfigsPath = path.join(
        bootstrap.PROJECT_ROOT,
        "mcp-configs",
      );
      const userConfigsPath = path.join(
        bootstrap.PROJECT_ROOT,
        "mcp-configs-user",
      );

      console.log("Loading MCP servers from system and user directories...");

      // Scan both directories
      const systemServers = await scanMcpConfigDirectory(
        systemConfigsPath,
        false,
      );
      const userServers = await scanMcpConfigDirectory(userConfigsPath, true);

      // Merge with precedence: system-delivered servers always win on ID collision.
      const allServers = [...systemServers];
      const systemServerIds = new Set();
      try {
        const systemEntries = await fsPromises.readdir(systemConfigsPath, {
          withFileTypes: true,
        });
        for (const entry of systemEntries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            systemServerIds.add(entry.name);
          }
        }
      } catch (_) {
        // Missing system config roots are handled by the scanner above.
      }
      const ignoredUserCollisions = [];

      for (const userServer of userServers) {
        const userServerKey = userServer.folderId || userServer.id;
        if (systemServerIds.has(userServerKey)) {
          ignoredUserCollisions.push(userServerKey);
          console.warn(
            `[MCP] Ignoring user-installed server '${userServerKey}' due to ID collision with system-delivered server`,
          );
          continue;
        }
        allServers.push(userServer);
      }

      console.log(
        `Total servers loaded: ${allServers.length} (${systemServers.length} system, ${userServers.length} user, ${ignoredUserCollisions.length} user collisions ignored)`,
      );

      return {
        success: true,
        data: allServers,
        ignoredUserCollisions,
      };
    } catch (error) {
      console.error("Error loading MCP servers:", error);
      return { success: false, error: error.message };
    }
  });

  // Add server to MCP config
  ipcMain.handle("add-mcp-server", async (event, serverId, fragment) => {
    if (!configData) resetConfigData();

    try {
      const fragmentData = JSON.parse(fragment);
      configData.mcpServers[serverId] = fragmentData;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Remove server from MCP config
  ipcMain.handle("remove-mcp-server", async (event, serverId) => {
    if (!configData) resetConfigData();

    delete configData.mcpServers[serverId];
    return { success: true };
  });
}

// ============================================================================
// DOCKER HANDLERS
// ============================================================================

function registerDockerHandlers() {
  // Docker start - shows loading window
  ipcMain.handle("docker-start", async () => {
    console.log("Docker start requested from control panel");

    try {
      state.appState.mcpRuntimeMutationRelease =
        defaultMcpOperationManager.acquireMutationLease({
          kind: "docker_start",
          source: "control_plane",
        });
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "DOCKER_START_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    }

    // Close main window
    closeMainWindow({ force: true });

    // Stop monitoring
    if (dependencies.stopStatusMonitoring) {
      dependencies.stopStatusMonitoring();
    }

    // Close existing loading window
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.close();
      state.windows.loading = null;
    }

    // Reset initialization flag
    state.appState.isInitializing = false;

    // Small delay then create loading window
    setTimeout(() => {
      if (dependencies.createLoadingWindow) {
        dependencies.createLoadingWindow();
      } else {
        // No loading window means nothing will ever reach start-initialization,
        // so the lease taken above would be orphaned for the life of the app.
        state.releasePendingMcpRuntimeMutation(
          "docker-start-loading-window-unavailable",
        );
      }
    }, 200);

    return { success: true, message: "Starting services with loading screen" };
  });

  // Docker stop
  ipcMain.handle("docker-stop", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "docker_stop",
        source: "control_plane",
      });
      await stopHostMcpBridge();
      await stopHostMcpo();
      const { stdout } = await execPromise(
        `bash "${path.join(bootstrap.SCRIPTS_DIR, "docker-compose.sh")}" stop`,
        { cwd: bootstrap.PROJECT_ROOT },
      );
      return { success: true, output: stdout };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "DOCKER_STOP_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
        details: error.stderr || error.stdout,
      };
    } finally {
      releaseMutation?.();
    }
  });

  // Docker restart - shows loading window
  ipcMain.handle("docker-restart", async () => {
    console.log("Docker restart requested from control panel");

    try {
      state.appState.mcpRuntimeMutationRelease =
        defaultMcpOperationManager.acquireMutationLease({
          kind: "docker_restart",
          source: "control_plane",
        });
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "DOCKER_RESTART_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    }

    // Close main window
    closeMainWindow({ force: true });

    // Stop monitoring
    if (dependencies.stopStatusMonitoring) {
      dependencies.stopStatusMonitoring();
    }

    // Close existing loading window
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.close();
      state.windows.loading = null;
    }

    // Reset initialization flag
    state.appState.isInitializing = false;

    // Small delay then create loading window with forceRestart=true
    // This bypasses the smart startup check and ensures services always restart
    setTimeout(() => {
      if (dependencies.createLoadingWindow) {
        dependencies.createLoadingWindow(false, null, true); // forceRestart=true
      } else {
        // See docker-start: without a loading window the lease is orphaned.
        state.releasePendingMcpRuntimeMutation(
          "docker-restart-loading-window-unavailable",
        );
      }
    }, 200);

    return {
      success: true,
      message: "Restarting services with loading screen",
    };
  });

  // Docker status
  ipcMain.handle("docker-status", async () => {
    return state.dockerStatus;
  });

  // Docker logs
  ipcMain.handle("docker-logs", async (event, container, lines = 100) => {
    const mergeLogsOutput = (stdout, stderr) =>
      [stdout, stderr]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("");
    const dockerLogsTargets = {
      mcpo: {
        compose: "mcpo",
        containers: ["mcpo"],
      },
      "mcpo-core": {
        compose: "mcpo",
        containers: ["mcpo"],
      },
      "mcpo-openapi-aggregator": {
        compose: "mcpo",
        containers: ["mcpo"],
      },
      "mcpo-core-openapi-aggregator": {
        compose: "mcpo",
        containers: ["mcpo"],
      },
      "portico-open-webui": {
        compose: "open-webui",
        containers: ["portico-open-webui", "open-webui"],
      },
      "open-webui": {
        compose: "open-webui",
        containers: ["open-webui", "portico-open-webui"],
      },
      "open-webui-health-check": {
        compose: "health-check",
        containers: ["open-webui-health-check", "health-check"],
      },
      "health-check": {
        compose: "health-check",
        containers: ["health-check", "open-webui-health-check"],
      },
    };

    const { compose, containers } = dockerLogsTargets[container] || {
      compose: container,
      containers: [container],
    };

    let lastError = null;
    for (const candidate of containers) {
      try {
        const { stdout, stderr } = await execPromise(
          `docker logs ${candidate} --tail ${lines}`,
          { cwd: bootstrap.PROJECT_ROOT },
        );
        const logsOutput = mergeLogsOutput(stdout, stderr);
        return { success: true, logs: logsOutput };
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }

    const normalizedCandidates = [container, ...containers].filter(Boolean);
    let searchTerm = null;
    if (
      normalizedCandidates.some((name) =>
        name.toLowerCase().includes("open-webui"),
      )
    ) {
      searchTerm = "open-webui";
    } else if (
      normalizedCandidates.some((name) =>
        name.toLowerCase().includes("health-check"),
      )
    ) {
      searchTerm = "health-check";
    }

    if (searchTerm) {
      try {
        const { stdout: psOutput } = await execPromise(
          `docker ps -a --filter "name=${searchTerm}" --format "{{.Names}}"`,
          { cwd: bootstrap.PROJECT_ROOT },
        );
        const resolvedName = psOutput
          .split("\n")
          .map((name) => name.trim())
          .find(Boolean);
        if (resolvedName) {
          const { stdout: resolvedLogs, stderr: resolvedErrorLogs } =
            await execPromise(
              `docker logs ${resolvedName} --tail ${lines}`,
              { cwd: bootstrap.PROJECT_ROOT },
            );
          const logsOutput = mergeLogsOutput(resolvedLogs, resolvedErrorLogs);
          return { success: true, logs: logsOutput };
        }
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }

    try {
      const { stdout, stderr } = await execPromise(
        `bash "${path.join(bootstrap.SCRIPTS_DIR, "docker-compose.sh")}" logs ${compose} ${lines}`,
        { cwd: bootstrap.PROJECT_ROOT },
      );
      const logsOutput = mergeLogsOutput(stdout, stderr);
      return { success: true, logs: logsOutput };
    } catch (error) {
      lastError = error;
      return {
        success: false,
        error: lastError.message,
        details: lastError.stderr || lastError.stdout,
      };
    }
  });
}

// ============================================================================
// HOST MCPO HANDLERS
// ============================================================================

function registerHostMcpoHandlers() {
  ipcMain.handle("host-mcpo-status", async () => {
    try {
      const hostMcpoProcess = state.hostMcpo.process;
      const isRunning = hostMcpoProcess !== null && !hostMcpoProcess.killed;
      const pid = isRunning ? hostMcpoProcess.pid : null;
      const startup = state.hostMcpo.startup || {};

      return {
        success: true,
        running: isRunning,
        starting: startup.phase === "starting",
        startupPhase: startup.phase || "idle",
        pid: pid,
        port: state.hostMcpo.port,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("host-mcpo-restart", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "host_mcpo_restart",
        source: "control_plane",
      });
      // Stop existing process (now async with proper cleanup)
      await stopHostMcpo();

      // Wait a bit for cleanup
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Start new process
      const result = await startHostMcpo();

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "HOST_MCPO_RESTART_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("host-mcpo-logs", async (event, lines = 100) => {
    try {
      // Return the most recent logs
      const recentLogs = formatHostLogEntries(state.hostMcpo.logs.slice(-lines));
      return { success: true, logs: recentLogs };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-host-mcpo", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "stop_host_mcpo",
        source: "control_plane",
      });
      await stopHostMcpo(); // Now async with proper process group + port cleanup
      return { success: true, message: "Host MCPO stopped" };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "STOP_HOST_MCPO_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("host-mcp-bridge-status", async () => {
    try {
      await checkDockerStatus();
      const hostMcpBridgeProcess = state.hostMcpBridge.process;
      const bridgeStatus = state.dockerStatus.containers?.["host-mcp-bridge"];
      const bridgePid = state.dockerStatus.containers?.["host-mcp-bridge-pid"] || null;
      const isProcessRunning =
        hostMcpBridgeProcess !== null && !hostMcpBridgeProcess.killed;
      const isRunning = isProcessRunning || bridgeStatus === "running";
      const pid = isProcessRunning ? hostMcpBridgeProcess.pid : bridgePid;
      const startup = state.hostMcpBridge.startup || {};
      const isStarting =
        startup.phase === "starting" || bridgeStatus === "starting";
      const bridgePreferences = readHostMcpBridgePreferences({
        userDataPath: app.getPath("userData"),
      });

      return {
        success: true,
        running: isRunning,
        starting: isStarting,
        bridgeEnabled: bridgePreferences.data.enabled !== false,
        startupPhase: startup.phase || "idle",
        pid,
        port: state.hostMcpBridge.port,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("start-host-mcp-bridge", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "start_host_mcp_bridge",
        source: "control_plane",
      });
      setHostMcpBridgeDesiredEnabled(true, {
        userDataPath: app.getPath("userData"),
        source: "ipc_start",
        reason: "manual_start",
      });
      const result = await startHostMcpBridge();
      await checkDockerStatus();
      return {
        success: result?.success !== false,
        message: result?.alreadyRunning
          ? "Host MCP Bridge already running"
          : "Host MCP Bridge starting",
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "START_HOST_MCP_BRIDGE_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("host-mcp-bridge-restart", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "host_mcp_bridge_restart",
        source: "control_plane",
      });
      setHostMcpBridgeDesiredEnabled(true, {
        userDataPath: app.getPath("userData"),
        source: "ipc_restart",
        reason: "manual_restart",
      });
      const stopResult = await stopHostMcpBridge();
      if (!stopResult?.success) {
        return stopResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const result = await startHostMcpBridge();
      await checkDockerStatus();
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "HOST_MCP_BRIDGE_RESTART_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("host-mcp-bridge-logs", async (event, lines = 100) => {
    try {
      const recentLogs = formatHostLogEntries(
        state.hostMcpBridge.logs.slice(-lines),
      );
      return { success: true, logs: recentLogs };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-host-mcp-bridge", async () => {
    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "stop_host_mcp_bridge",
        source: "control_plane",
      });
      setHostMcpBridgeDesiredEnabled(false, {
        userDataPath: app.getPath("userData"),
        source: "ipc_stop",
        reason: "manual_stop",
      });
      const result = await stopHostMcpBridge({ reason: "manual_stop" });
      await checkDockerStatus();
      if (!result?.success) {
        return {
          success: false,
          message: result?.error || "Host MCP Bridge did not stop",
          error: result?.error || "Host MCP Bridge did not stop",
          ...result,
        };
      }
      return { success: true, message: "Host MCP Bridge stopped", ...result };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "STOP_HOST_MCP_BRIDGE_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  ipcMain.handle("host-mcp-bridge-config-detect", async () => {
    const requestId = crypto.randomUUID();
    try {
      const clients = detectMcpClients({
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        userDataPath: app.getPath("userData"),
        bridgeUrl: DEFAULT_BRIDGE_URL,
      });
      void emitBridgeLogRepoEvent("bridge_clients_detected", {
        ...bridgeUiTelemetryFields({ request_id: requestId }),
        ...summarizeBridgeClientInventory(clients),
        outcome: "success",
      });
      return {
        success: true,
        bridgeUrl: DEFAULT_BRIDGE_URL,
        clients,
        auth: getBridgeAuthRedactedStatus({
          userDataPath: app.getPath("userData"),
        }),
      };
    } catch (error) {
      const errorMessage = logHostMcpBridgeConfigError("detect_clients", error, requestId);
      void emitBridgeLogRepoEvent("bridge_clients_detected", {
        ...bridgeUiTelemetryFields({ request_id: requestId }),
        outcome: "failed",
        ...buildBridgeErrorTelemetry(error),
      });
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle("host-mcp-bridge-configure-clients", async (_event, payload = {}) => {
    const requestId = crypto.randomUUID();
    const clientIds = Array.isArray(payload.clientIds)
      ? payload.clientIds.filter((id) => typeof id === "string")
      : [];
    const telemetryCommon = bridgeUiTelemetryFields({
      request_id: requestId,
      selected_client_ids: clientIds,
      selected_client_count: clientIds.length,
    });
    void emitBridgeLogRepoEvent("client_configure_requested", {
      ...telemetryCommon,
      outcome: "requested",
    });
    try {
      if (clientIds.length === 0) {
        const errorMessage = "Select at least one MCP client to configure.";
        void emitBridgeLogRepoEvent("client_configure_failed", {
          ...telemetryCommon,
          outcome: "failed",
          bridge_ready: false,
          ...buildBridgeErrorTelemetry(errorMessage, "no_clients"),
        });
        return {
          success: false,
          bridgeReady: false,
          error: errorMessage,
          results: [],
        };
      }

      setHostMcpBridgeDesiredEnabled(true, {
        userDataPath: app.getPath("userData"),
        source: "ipc_configure_clients",
        reason: "client_configuration",
      });
      const bridgeReady = await ensureHostMcpBridgeReady();
      if (!bridgeReady.ready) {
        const errorMessage = logHostMcpBridgeConfigError(
          "bridge_readiness",
          bridgeReady.error || "Host MCP Bridge did not become healthy",
          requestId,
        );
        void emitBridgeLogRepoEvent("client_configure_failed", {
          ...telemetryCommon,
          outcome: "failed",
          bridge_ready: false,
          bridge_enabled: true,
          ...buildBridgeErrorTelemetry(errorMessage),
        });
        return {
          success: false,
          bridgeReady: false,
          error: errorMessage,
          results: [],
        };
      }

      const result = await configureMcpClients({
        userDataPath: app.getPath("userData"),
        homeDir: os.homedir(),
        bridgeUrl: DEFAULT_BRIDGE_URL,
        clientIds,
        shell,
      });
      void emitBridgeLogRepoEvent("client_configure_completed", {
        ...telemetryCommon,
        ...summarizeBridgeClientResults(result.results || []),
        outcome: result.success ? "success" : "partial",
        bridge_ready: true,
        bridge_enabled: true,
      });
      void emitBridgeClientResultEvents("client_configure", result.results || [], {
        ...telemetryCommon,
        bridge_enabled: true,
      });
      await checkDockerStatus();
      return { ...result, bridgeReady: true, bridgeEnabled: true };
    } catch (error) {
      const errorMessage = logHostMcpBridgeConfigError("configure_clients", error, requestId);
      void emitBridgeLogRepoEvent("client_configure_failed", {
        ...telemetryCommon,
        outcome: "failed",
        bridge_ready: false,
        ...buildBridgeErrorTelemetry(error),
      });
      return { success: false, error: errorMessage, results: [] };
    }
  });

  ipcMain.handle("host-mcp-bridge-remove-client-configs", async (_event, payload = {}) => {
    const requestId = crypto.randomUUID();
    const clientIds = Array.isArray(payload.clientIds)
      ? payload.clientIds.filter((id) => typeof id === "string")
      : [];
    const telemetryCommon = bridgeUiTelemetryFields({
      request_id: requestId,
      selected_client_ids: clientIds,
      selected_client_count: clientIds.length,
    });
    void emitBridgeLogRepoEvent("client_remove_requested", {
      ...telemetryCommon,
      outcome: "requested",
    });
    try {
      const result = await removeMcpClientConfigs({
        userDataPath: app.getPath("userData"),
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        clientIds,
      });
      void emitBridgeLogRepoEvent("client_remove_completed", {
        ...telemetryCommon,
        ...summarizeBridgeClientResults(result.results || []),
        outcome: result.success ? "success" : "partial",
      });
      void emitBridgeClientResultEvents("client_remove", result.results || [], telemetryCommon);
      return result;
    } catch (error) {
      const errorMessage = logHostMcpBridgeConfigError("remove_clients", error, requestId);
      void emitBridgeLogRepoEvent("client_remove_failed", {
        ...telemetryCommon,
        outcome: "failed",
        ...buildBridgeErrorTelemetry(error),
      });
      return { success: false, error: errorMessage, results: [] };
    }
  });

  ipcMain.handle("host-mcp-bridge-reveal-client-config", async (_event, payload = {}) => {
    try {
      return revealMcpClientConfig({
        clientId: typeof payload.clientId === "string" ? payload.clientId : "",
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        shell,
      });
    } catch (error) {
      return {
        success: false,
        error: logHostMcpBridgeConfigError(
          "reveal_client_config",
          error,
          crypto.randomUUID(),
        ),
      };
    }
  });
}

// ============================================================================
// PER-SERVER MCPO HANDLERS
// ============================================================================

function registerPerServerMcpoHandlers() {
  // Get status of a specific MCP server container
  ipcMain.handle("mcpo-server-status", async (event, serverId) => {
    try {
      const { getMcpoServerStatus } = require("./docker-mcp");
      const result = await getMcpoServerStatus(serverId);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Restart a specific MCP server container
  ipcMain.handle("mcpo-server-restart", async (event, serverId) => {
    try {
      if (mcpOperationCoordinator) {
        return await startAndWaitForMcpOperation({
          clientRequestId: crypto.randomUUID(),
          kind: "restart",
          serverIds: [serverId],
        });
      }
      const { restartMcpoServer } = require("./docker-mcp");
      const result = await restartMcpoServer(serverId);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // List all per-server MCPO containers
  ipcMain.handle("mcpo-servers-list", async () => {
    try {
      const { listMcpoServers } = require("./docker-mcp");
      const servers = await listMcpoServers();
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Delete a user-installed MCP server
  ipcMain.handle("delete-user-mcp-server", async (event, serverId) => {
    console.log(`[IPC] Deleting user MCP server: ${serverId}`);

    let releaseMutation = null;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "delete_user_mcp_server",
        source: "ipc",
      });
      const result = await deleteUserMcpServer(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        env: createMcpRuntimeEnv(),
        isPackagedApp: app.isPackaged,
        logger: console,
        broadcastToggleState(payload) {
          BrowserWindow.getAllWindows().forEach((window) => {
            if (!window.isDestroyed()) {
              window.webContents.send("mcp-server-toggled", payload);
            }
          });
        },
      });
      if (result?.success) {
        clearStartupFailure(bootstrap.PROJECT_ROOT, serverId, {
          logger: console,
        });
      }
      console.log(`[IPC] Delete result:`, result);
      return result.success
        ? {
            ...result,
            serverId,
            filesDeleted: result.files_deleted_count || 0,
          }
        : {
            ...result,
            serverId,
            filesDeleted: result.files_deleted_count || 0,
          };
    } catch (error) {
      console.error(`[IPC] delete-user-mcp-server error:`, error);
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "DELETE_MCP_SERVER_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  // Toggle (enable/disable) an MCP server with container/process management
  ipcMain.handle(
    "toggle-mcp-server",
    async (event, serverId, enabled, deploymentType, options = {}) => {
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);
      const backgroundLifecycle = Boolean(options?.backgroundLifecycle);

      console.log(
        `[IPC] Toggling MCP server: ${serverId}, enabled=${enabled}, type=${deploymentType}, backgroundLifecycle=${backgroundLifecycle}`,
      );

      try {
        const operationRequest = {
            clientRequestId:
              options?.clientRequestId || crypto.randomUUID(),
            kind: enabled ? "enable" : "disable",
            // PORTICO-410: this channel is UI-initiated, so an enable always
            // lifts a hard disable; a disable may carry the chosen mode.
            ...(enabled
              ? { clearDisableMode: true }
              : options?.disableMode === "hard"
                ? { disableMode: "hard" }
                : {}),
            servers: [
              {
                serverId,
                label: options?.label || serverId,
                deploymentType,
              },
            ],
        };
        if (backgroundLifecycle) {
            const operation = mcpOperationCoordinator.start(operationRequest);
            return {
              success: true,
              queued: true,
              pending: true,
              serverId,
              enabled,
              operationId: operation.operationId,
              operation,
              results: [],
              errors: [],
            };
          }
        const operationResult = await startAndWaitForMcpOperation(
          operationRequest,
        );
        const rowResult = operationResult.results[0] || {};
        return {
          ...operationResult,
          ...rowResult,
          serverId,
          enabled,
          operationId: operationResult.operationId,
        };

        const noopResult = await detectToggleLifecycleNoop(serverId, enabled, {
          deploymentType,
          isServerEffectivelyEnabled: () =>
            isServerEffectivelyEnabled(serverId, dockerMcp),
          getMcpoServerStatus:
            deploymentType === "docker"
              ? () => dockerMcp.getMcpoServerStatus(serverId)
              : null,
        });

        if (noopResult) {
          if (!enabled) {
            clearStartupFailure(bootstrap.PROJECT_ROOT, serverId, {
              logger: console,
            });
            schedulePostToggleHealthSync(serverId, false, {
              runHealthCheckAndBroadcast,
              queueFullHealthCheck,
              logger: console,
            });
          }
          return {
            success: true,
            serverId,
            enabled,
            message: noopResult.message,
          };
        }

        const enablePreflightIssue = enabled
          ? detectToggleEnablePreflightIssue(serverId, {
              projectRoot: bootstrap.PROJECT_ROOT,
              findServerYaml: dockerMcp.findServerYaml,
              parseYaml,
              parseEnvFile: dockerMcp.parseEnvFile,
              checkServerConfigured,
            })
          : null;
        if (
          enablePreflightIssue &&
          !isConfigurationRequiredPreflightIssue(enablePreflightIssue)
        ) {
          const failureResult = buildStartupFailureResult(
            serverId,
            enablePreflightIssue.error || enablePreflightIssue.message,
            {
              operation: "enable",
              stage: enablePreflightIssue.stage || "config_generation",
              source: enablePreflightIssue.source || "config",
              errorCode: enablePreflightIssue.errorCode || null,
              configPath: enablePreflightIssue.configPath || null,
            },
          );
          recordAndPublishStartupFailure(failureResult.startupFailure, {
            logger: console,
            reason: `toggle-preflight-failure:${serverId}`,
          });
          return {
            success: false,
            error: failureResult.error,
            errorCode: enablePreflightIssue.errorCode || null,
            startupFailure: failureResult.startupFailure,
          };
        }
        const requiresConfiguration =
          enabled &&
          isConfigurationRequiredPreflightIssue(enablePreflightIssue);

        // 1. Update persisted toggles atomically.
        await mutateMcpToggles(
          (toggles) => {
            toggles[serverId] = enabled;
          },
          {
            reason: `toggle-mcp-server:${serverId}:${enabled ? "enable" : "disable"}`,
          },
        );
        dockerMcp.invalidateHostModeCaches?.();
        clearStartupFailure(bootstrap.PROJECT_ROOT, serverId, {
          logger: console,
        });
        console.log(`[IPC] Toggle saved for ${serverId}: ${enabled}`);

        // 2. Regenerate MCP configs
        console.log(`[IPC] Regenerating MCP infrastructure...`);
        try {
          await regenerateMcpInfrastructure(
            execAsync,
            bootstrap.PROJECT_ROOT,
            createMcpRuntimeEnv(),
            { isPackagedApp: app.isPackaged, timeout: 30000 },
          );
          dockerMcp.invalidateHostModeCaches?.();
        } catch (configErr) {
          console.log(`[IPC] Config regeneration notice: ${configErr.message}`);
          // Continue even if config generation has warnings
        }

        const runtimeTarget =
          deploymentType === "host"
            ? null
            : dockerMcp.getConfiguredMcpoRuntimeTarget(serverId);
        const performLifecycle = async () => {
          if (!enabled) {
            console.log(`[IPC] Disabling server ${serverId}...`);

            if (deploymentType === "host") {
              console.log(`[IPC] Host server - will restart host-mcpo`);
              try {
                await restartHostMcpoWithFreshConfig({
                  execAsync,
                  projectRoot: bootstrap.PROJECT_ROOT,
                  env: createMcpRuntimeEnv(),
                  regenerateMcpInfrastructure,
                  stopHostMcpo,
                  startHostMcpo,
                  logger: console,
                  regenerationOptions: { isPackagedApp: app.isPackaged },
                  skipRegeneration: true,
                });
                dockerMcp.invalidateHostModeCaches?.();
              } catch (hostErr) {
                console.log(`[IPC] Host MCPO restart notice: ${hostErr.message}`);
              }
              return;
            }

            const containerName =
              runtimeTarget?.containerName || `mcpo-${serverId}`;
            console.log(`[IPC] Force-removing container: ${containerName}`);
            try {
              await execAsync(buildForceRemoveContainerCommand(containerName), {
                timeout: 10000,
              });
            } catch (rmErr) {
              console.log(
                `[IPC] Container force-remove notice: ${rmErr.message}`,
              );
            }

            console.log(`[IPC] Refreshing control-plane to remove stale routes...`);
            try {
              await refreshMcpControlPlane(
                execAsync,
                bootstrap.PROJECT_ROOT,
                createMcpRuntimeEnv(),
                {
                  serverId,
                  includeRegular: runtimeTarget?.deploymentScope !== "core",
                  includeCore: runtimeTarget?.deploymentScope === "core",
                  serverRouteWait: "skip",
                  logger: console,
                  timeout: 30000,
                },
              );
            } catch (refreshErr) {
              console.log(
                `[IPC] Control-plane refresh notice: ${refreshErr.message}`,
              );
            }
            return;
          }

          console.log(`[IPC] Enabling server ${serverId}...`);

          if (deploymentType === "host") {
            console.log(`[IPC] Host server - will restart host-mcpo`);
            try {
              await restartHostMcpoWithFreshConfig({
                execAsync,
                projectRoot: bootstrap.PROJECT_ROOT,
                env: createMcpRuntimeEnv(),
                regenerateMcpInfrastructure,
                stopHostMcpo,
                startHostMcpo,
                logger: console,
                regenerationOptions: { isPackagedApp: app.isPackaged },
                skipRegeneration: true,
              });
              dockerMcp.invalidateHostModeCaches?.();
            } catch (hostErr) {
              console.log(`[IPC] Host MCPO restart notice: ${hostErr.message}`);
            }
            return;
          }

          const restartResult = await restartMcpoServer(serverId);
          if (!restartResult?.success) {
            throw new Error(restartResult?.error || "Server restart failed");
          }
          return restartResult;
        };

        const finalizeToggleHealthSync = () => {
          schedulePostToggleHealthSync(serverId, enabled, {
            runHealthCheckAndBroadcast,
            queueFullHealthCheck,
            logger: console,
          });
        };

        if (backgroundLifecycle) {
          if (requiresConfiguration) {
            finalizeToggleHealthSync();
            return {
              success: true,
              queued: false,
              serverId,
              enabled,
              requiresConfiguration: true,
              started: false,
              uiStatus: "not_configured",
              errorCode: enablePreflightIssue.errorCode,
              message: `Server ${serverId} enabled; configuration required before it can start`,
            };
          }

          await runToggleLifecycle(performLifecycle, {
            background: true,
            label: `toggle lifecycle for ${serverId}`,
            logger: console,
            onSuccess: async () => {
              console.log(
                `[IPC] Successfully toggled MCP server: ${serverId} to ${enabled ? "enabled" : "disabled"} (background lifecycle complete)`,
              );
              finalizeToggleHealthSync();
            },
            onError: async () => {
              finalizeToggleHealthSync();
            },
          });

          console.log(
            `[IPC] Queued background lifecycle for MCP server ${serverId}`,
          );

          return {
            success: true,
            queued: true,
            serverId,
            enabled,
            message: `Server ${serverId} ${enabled ? "enable" : "disable"} queued successfully`,
          };
        }

        if (requiresConfiguration) {
          console.log(
            `[IPC] Enabled ${serverId} without starting runtime because configuration is incomplete`,
          );
          finalizeToggleHealthSync();
          return {
            success: true,
            serverId,
            enabled,
            requiresConfiguration: true,
            started: false,
            uiStatus: "not_configured",
            errorCode: enablePreflightIssue.errorCode,
            message: `Server ${serverId} enabled; configuration required before it can start`,
          };
        }

        const lifecycleResult = await performLifecycle();
        if (enabled && lifecycleResult?.requiresConfiguration) {
          finalizeToggleHealthSync();
          return {
            success: true,
            serverId,
            enabled,
            requiresConfiguration: true,
            started: false,
            uiStatus: "not_configured",
            errorCode: lifecycleResult.errorCode || "NOT_CONFIGURED",
            message:
              lifecycleResult.message ||
              `Server ${serverId} enabled; configuration required before it can start`,
          };
        }

        console.log(
          `[IPC] Successfully toggled MCP server: ${serverId} to ${enabled ? "enabled" : "disabled"}`,
        );
        finalizeToggleHealthSync();

        return {
          success: true,
          serverId,
          enabled,
          message: `Server ${serverId} ${enabled ? "enabled" : "disabled"} successfully`,
        };
      } catch (error) {
        console.error(`[IPC] toggle-mcp-server error:`, error);
        return { success: false, error: error.message };
      }
    },
  );

  // Bulk toggle (enable/disable) MCP servers with a single config write and grouped lifecycle operations.
  // Kept as a named executor so the operation manager can use the same compatibility
  // path while legacy IPC callers continue to await the final result.
  const executeBulkMcpToggle = async (event, serverIds, enabled, executionOptions = {}) => {
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);

      const normalizedServerIds = normalizeServerIds(serverIds);

      if (normalizedServerIds.length === 0) {
        return {
          success: false,
          results: [],
          errors: ["No server IDs provided for bulk toggle"],
          error: "No server IDs provided for bulk toggle",
        };
      }

      console.log(
        `[IPC] Bulk toggling ${normalizedServerIds.length} server(s) to ${enabled ? "enabled" : "disabled"}: ${normalizedServerIds.join(", ")}`,
      );

      try {
        const fatalPreflightResults = [];
        const failedEnableServerIds = [];
        const configRequiredServerIds = [];
        const startableServerIds = [];
        const togglesToPersist = [];

        if (enabled) {
          for (const serverId of normalizedServerIds) {
            const issue = detectToggleEnablePreflightIssue(serverId, {
              projectRoot: bootstrap.PROJECT_ROOT,
              findServerYaml: dockerMcp.findServerYaml,
              parseYaml,
              parseEnvFile: dockerMcp.parseEnvFile,
              checkServerConfigured,
            });

            if (!issue) {
              startableServerIds.push(serverId);
              togglesToPersist.push(serverId);
              continue;
            }

            if (isConfigurationRequiredPreflightIssue(issue)) {
              configRequiredServerIds.push(serverId);
              togglesToPersist.push(serverId);
              continue;
            }

            const failureResult = buildStartupFailureResult(
              serverId,
              issue.error || issue.message,
              {
                operation: "enable",
                stage: issue.stage || "config_generation",
                source: issue.source || "config",
                errorCode: issue.errorCode || null,
                configPath: issue.configPath || null,
              },
            );
            fatalPreflightResults.push(failureResult);
            failedEnableServerIds.push(serverId);
            recordAndPublishStartupFailure(failureResult.startupFailure, {
              logger: console,
              reason: `bulk-preflight-failure:${serverId}`,
            });
          }
        } else {
          togglesToPersist.push(...normalizedServerIds);
        }

        if (enabled) {
          clearStartupFailures(
            bootstrap.PROJECT_ROOT,
            [...startableServerIds, ...configRequiredServerIds],
            { logger: console },
          );
        } else {
          clearStartupFailures(bootstrap.PROJECT_ROOT, normalizedServerIds, {
            logger: console,
          });
        }

        // 1. Persist toggles atomically in one mutation. Authoritative operations
        // perform this commit before entering the compatibility lifecycle path.
        if (executionOptions.skipTogglePersistence !== true) {
          await mutateMcpToggles(
            (toggles) => {
              togglesToPersist.forEach((serverId) => {
                toggles[serverId] = enabled;
              });
              if (enabled) {
                failedEnableServerIds.forEach((serverId) => {
                  toggles[serverId] = false;
                });
              }
            },
            {
              reason: enabled
                ? "toggle-mcp-servers-bulk:enable"
                : "toggle-mcp-servers-bulk:disable",
            },
          );
        }

        const results = [];
        const errors = [];
        const hostServers = [];
        const dockerServers = [];

        results.push(...fatalPreflightResults);
        errors.push(
          ...fatalPreflightResults.map((entry) => `${entry.serverId}: ${entry.error}`),
        );

        const lifecycleTargetIds = enabled
          ? startableServerIds
          : normalizedServerIds;

        for (const serverId of lifecycleTargetIds) {
          const isHost = await isHostDeployedServer(serverId);
          if (isHost) {
            hostServers.push(serverId);
          } else {
            dockerServers.push(serverId);
          }
        }

        const dockerTargets = groupDockerRuntimeTargets(
          dockerServers,
          dockerMcp.getConfiguredMcpoRuntimeTarget,
        );

        if (enabled) {
          if (startableServerIds.length === 0 && togglesToPersist.length > 0) {
            try {
              await regenerateMcpInfrastructure(
                execAsync,
                bootstrap.PROJECT_ROOT,
                createMcpRuntimeEnv(),
                { isPackagedApp: app.isPackaged, timeout: 60000 },
              );
            } catch (configErr) {
              const errorText =
                normalizeErrorText(configErr) || "Config regeneration failed";
              const attributedFailure = extractAttributedServerFailure(
                errorText,
                bootstrap.PROJECT_ROOT,
              );
              const attributedRequested =
                attributedFailure?.serverId &&
                normalizedServerIds.includes(attributedFailure.serverId);
              const affectedIds = attributedRequested
                ? [attributedFailure.serverId]
                : attributedFailure?.serverId
                  ? []
                  : togglesToPersist;
              const failureResults = ensureBulkResultsForRequested(
                affectedIds,
                [],
                {
                  error: errorText,
                  stage: "config_generation",
                  source: "config",
                  operation: "enable",
                  errorCode: "CONFIG_GENERATION_FAILED",
                },
              ).map((entry) => {
                if (entry.serverId !== attributedFailure?.serverId) {
                  return entry;
                }
                return {
                  ...entry,
                  configPath: attributedFailure.configPath || entry.configPath,
                  startupFailure: {
                    ...entry.startupFailure,
                    configPath:
                      attributedFailure.configPath ||
                      entry.startupFailure?.configPath,
                  },
                };
              });
              failureResults.forEach((entry) => {
                results.push(entry);
                errors.push(`${entry.serverId}: ${entry.error}`);
                if (entry.startupFailure) {
                  recordAndPublishStartupFailure(entry.startupFailure, {
                    logger: console,
                    reason: `bulk-config-failure:${entry.serverId}`,
                  });
                }
              });
              if (attributedFailure?.serverId) {
                await mutateMcpToggles(
                  (toggles) => {
                    toggles[attributedFailure.serverId] = false;
                  },
                  {
                    reason: "toggle-mcp-servers-bulk:enable:config-failure-exclude",
                  },
                );
                try {
                  await regenerateMcpInfrastructure(
                    execAsync,
                    bootstrap.PROJECT_ROOT,
                    createMcpRuntimeEnv(),
                    { isPackagedApp: app.isPackaged, timeout: 60000 },
                  );
                } catch (retryErr) {
                  const retryErrorText =
                    normalizeErrorText(retryErr) ||
                    "Config regeneration failed";
                  togglesToPersist.forEach((serverId) => {
                    if (
                      serverId === attributedFailure.serverId ||
                      results.some(
                        (entry) =>
                          entry?.serverId === serverId &&
                          entry.success === false,
                      )
                    ) {
                      return;
                    }
                    const retryFailure = buildStartupFailureResult(
                      serverId,
                      retryErrorText,
                      {
                        operation: "enable",
                        stage: "config_generation",
                        source: "config",
                        errorCode: "CONFIG_GENERATION_FAILED",
                      },
                    );
                    results.push(retryFailure);
                    errors.push(`${serverId}: ${retryFailure.error}`);
                    recordAndPublishStartupFailure(
                      retryFailure.startupFailure,
                      {
                        logger: console,
                        reason: `bulk-config-retry-failure:${serverId}`,
                      },
                    );
                  });
                }
              }
            }
          }

          configRequiredServerIds.forEach((serverId) => {
            if (
              results.some(
                (entry) => entry?.serverId === serverId && entry.success === false,
              )
            ) {
              return;
            }
            results.push({
              serverId,
              success: true,
              requiresConfiguration: true,
              started: false,
              uiStatus: "not_configured",
              errorCode: "NOT_CONFIGURED",
              message: `Server ${serverId} enabled; configuration required before it can start`,
            });
          });

          // 2a. Enable path: grouped restart path (single config regen + targeted container restarts)
          if (startableServerIds.length > 0) {
            let pendingStartIds = [...startableServerIds];
            const excludedAfterSharedFailure = new Set();
            for (let attempt = 0; attempt < 2 && pendingStartIds.length > 0; attempt += 1) {
              const restartResult = await restartMcpoServers(pendingStartIds);
              const restartResults = Array.isArray(restartResult.results)
                ? restartResult.results
                : [];
              const attributedFailure = restartResult.attributedServerId
                ? {
                    serverId: restartResult.attributedServerId,
                    error: restartResult.error,
                  }
                : extractAttributedServerFailure(
                    restartResult.error || restartResult.errors?.join("\n") || "",
                    bootstrap.PROJECT_ROOT,
                  );

              if (
                !restartResult.success &&
                attributedFailure?.serverId &&
                !excludedAfterSharedFailure.has(attributedFailure.serverId)
              ) {
                if (pendingStartIds.includes(attributedFailure.serverId)) {
                  const attributedEntries = restartResults.filter(
                    (entry) => entry?.serverId === attributedFailure.serverId,
                  );
                  if (attributedEntries.length > 0) {
                    results.push(...attributedEntries);
                  } else {
                    const failureResult = buildStartupFailureResult(
                      attributedFailure.serverId,
                      restartResult.error || "Config regeneration failed",
                      {
                        operation: "enable",
                        stage: "config_generation",
                        source: "config",
                        errorCode: "CONFIG_GENERATION_FAILED",
                        configPath: attributedFailure.configPath || null,
                      },
                    );
                    results.push(failureResult);
                    recordAndPublishStartupFailure(
                      failureResult.startupFailure,
                      {
                        logger: console,
                        reason: `bulk-restart-attributed-failure:${attributedFailure.serverId}`,
                      },
                    );
                  }
                  errors.push(
                    `${attributedFailure.serverId}: ${
                      restartResult.error || "Config regeneration failed"
                    }`,
                  );
                  pendingStartIds = pendingStartIds.filter(
                    (serverId) => serverId !== attributedFailure.serverId,
                  );
                }
                excludedAfterSharedFailure.add(attributedFailure.serverId);
                await mutateMcpToggles(
                  (toggles) => {
                    toggles[attributedFailure.serverId] = false;
                  },
                  {
                    reason: "toggle-mcp-servers-bulk:enable:retry-exclude",
                  },
                );
                continue;
              }

              if (restartResults.length > 0) {
                results.push(...restartResults);
              } else if (!restartResult.success) {
                const completed = ensureBulkResultsForRequested(
                  pendingStartIds,
                  [],
                  {
                    error:
                      restartResult.error ||
                      restartResult.errors?.join("\n") ||
                      "Config regeneration failed",
                    stage: "config_generation",
                    source: "config",
                    operation: "enable",
                    errorCode: "CONFIG_GENERATION_FAILED",
                  },
                );
                completed.forEach((entry) => {
                  results.push(entry);
                  if (entry.startupFailure) {
                    recordAndPublishStartupFailure(entry.startupFailure, {
                      logger: console,
                      reason: `bulk-restart-failure:${entry.serverId}`,
                    });
                  }
                });
              }
              if (Array.isArray(restartResult.errors)) {
                errors.push(...restartResult.errors);
              }
              break;
            }
          }
        } else {
          // 2b. Disable path: regen once, then fast-remove targeted containers
          try {
            const runtimeEnv = createMcpRuntimeEnv();
            await regenerateMcpInfrastructure(
              execAsync,
              bootstrap.PROJECT_ROOT,
              runtimeEnv,
              { isPackagedApp: app.isPackaged, timeout: 60000 },
            );
            if (dockerTargets.length > 0) {
              // Resolve Compose exactly once even though disabled services are
              // intentionally omitted from the regenerated topology. A failed
              // enumeration means Docker target discovery is not trustworthy,
              // but independent host-only mutations do not require Compose.
              await dockerMcp.getConfiguredComposeServices(
                execAsync,
                bootstrap.PROJECT_ROOT,
                runtimeEnv,
              );
              await executionOptions.onPhase?.("resolving_runtime_targets", {
                serverIds: dockerServers,
              });
            }
          } catch (configErr) {
            return {
              success: false,
              results: [],
              errors: [
                `Config regeneration failed: ${configErr.message || "unknown error"}`,
              ],
              error: configErr.message || "Config regeneration failed",
            };
          }

          if (hostServers.length > 0) {
            await executionOptions.onPhase?.("restarting_host", {
              serverIds: hostServers,
            });
            try {
              await restartHostMcpoWithFreshConfig({
                execAsync,
                projectRoot: bootstrap.PROJECT_ROOT,
                env: createMcpRuntimeEnv(),
                regenerateMcpInfrastructure,
                stopHostMcpo,
                startHostMcpo,
                logger: console,
                regenerationOptions: { isPackagedApp: app.isPackaged },
                skipRegeneration: true,
              });
              hostServers.forEach((serverId) => {
                results.push({ serverId, success: true, mode: "host" });
              });
            } catch (hostErr) {
              hostServers.forEach((serverId) => {
                results.push({
                  serverId,
                  success: false,
                  mode: "host",
                  error: hostErr.message,
                });
                errors.push(`${serverId}: ${hostErr.message}`);
              });
            }
          }

          const queue = [...dockerTargets];
          if (dockerTargets.length > 0) {
            await executionOptions.onPhase?.("restarting_docker", {
              serverIds: dockerServers,
            });
          }
          const workerCount = Math.min(
            Math.max(
              1,
              Number.parseInt(
                process.env.MCP_BULK_DISABLE_CONCURRENCY || "6",
                10,
              ) || 6,
            ),
            queue.length || 1,
          );

          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (queue.length > 0) {
                const nextTarget = queue.shift();
                if (!nextTarget) break;
                const { containerName, serverIds } = nextTarget;
                try {
                  await execAsync(
                    buildForceRemoveContainerCommand(containerName),
                    {
                      timeout: 10000,
                      cwd: bootstrap.PROJECT_ROOT,
                    },
                  );
                  serverIds.forEach((serverId) => {
                    results.push({ serverId, success: true, mode: "docker" });
                  });
                } catch (err) {
                  serverIds.forEach((serverId) => {
                    results.push({
                      serverId,
                      success: false,
                      mode: "docker",
                      error: err.message,
                    });
                    errors.push(`${serverId}: ${err.message}`);
                  });
                }
              }
            }),
          );

          if (dockerTargets.length > 0) {
            await executionOptions.onPhase?.("reloading_routes", {
              serverIds: dockerServers,
            });
            const refreshScope = buildAggregatorInvalidationScope(dockerTargets);
            try {
              await refreshMcpControlPlane(
                execAsync,
                bootstrap.PROJECT_ROOT,
                createMcpRuntimeEnv(),
                {
                  serverId:
                    dockerTargets.length === 1 &&
                    dockerTargets[0]?.serverIds?.length === 1
                      ? dockerTargets[0].serverIds[0]
                      : null,
                  ...refreshScope,
                  serverRouteWait: "skip",
                  logger: console,
                  timeout: 30000,
                },
              );
            } catch (refreshErr) {
              console.log(
                `[IPC] Control-plane refresh notice: ${refreshErr.message}`,
              );
            }
          }
        }

        if (executionOptions.skipHealthSync !== true) {
          scheduleBulkToggleHealthSync(enabled, {
            runHealthCheckAndBroadcast,
            queueFullHealthCheck,
            logger: console,
          });
        }

        const requestedResultMap = new Map();
        const requestedIdSet = new Set(normalizedServerIds);
        results.forEach((entry) => {
          if (entry?.serverId && requestedIdSet.has(entry.serverId)) {
            requestedResultMap.set(entry.serverId, entry);
          }
        });
        const finalResults = normalizedServerIds.map((serverId) => {
          if (requestedResultMap.has(serverId)) {
            return requestedResultMap.get(serverId);
          }
          if (!enabled && errors.length === 0) {
            return { serverId, success: true };
          }
          const failureResult = buildStartupFailureResult(
            serverId,
            errors[0] || "Startup failed",
            {
              operation: enabled ? "enable" : "disable",
              stage: enabled ? "startup" : "runtime_stop",
              source: "runtime",
            },
          );
          if (enabled) {
            recordAndPublishStartupFailure(failureResult.startupFailure, {
              logger: console,
              reason: `bulk-final-failure:${serverId}`,
            });
          }
          return failureResult;
        });
        const finalErrors = [
          ...errors,
          ...finalResults
            .filter((entry) => entry?.success === false)
            .map((entry) => `${entry.serverId}: ${entry.error}`),
        ];
        const dedupedErrors = [...new Set(finalErrors)];

        return {
          success:
            dedupedErrors.length === 0 &&
            finalResults.every((entry) => entry?.success !== false),
          enabled,
          results: finalResults,
          errors: dedupedErrors,
          error: dedupedErrors[0] || null,
        };
      } catch (error) {
        console.error("[IPC] toggle-mcp-servers-bulk error:", error);
        const errorText = normalizeErrorText(error) || error.message;
        const failureResults = ensureBulkResultsForRequested(
          normalizedServerIds,
          [],
          {
            error: errorText,
            stage: enabled ? "startup" : "runtime_stop",
            source: "runtime",
            operation: enabled ? "enable" : "disable",
          },
        );
        if (enabled) {
          failureResults.forEach((entry) => {
            if (entry.startupFailure) {
              recordAndPublishStartupFailure(entry.startupFailure, {
                logger: console,
                reason: `bulk-exception-failure:${entry.serverId}`,
              });
            }
          });
        }
        return {
          success: false,
          results: failureResults,
          errors: [errorText],
          error: errorText,
        };
      }
    };

  dockerMcp.resetTargetedMcpOperationPublication();
  const readinessPublisher = {
    publish: (entries, options = {}) =>
      dockerMcp.publishTargetedMcpReadiness(entries, options),
    beginOperation: (operationId) =>
      dockerMcp.beginTargetedMcpOperationPublication(operationId),
    endOperation: (operationId) =>
      dockerMcp.endTargetedMcpOperationPublication(operationId),
  };

  async function invalidateReadyAggregatorEntries(serverIds, targets) {
    const targetById = new Map(
      targets.map((target) => [target.serverId, target]),
    );
    const regularIds = serverIds.filter(
      (serverId) => targetById.get(serverId)?.deploymentType === "docker",
    );
    const coreIds = serverIds.filter(
      (serverId) => targetById.get(serverId)?.deploymentType === "core",
    );
    const attempts = [];
    if (regularIds.length > 0) {
      attempts.push({ serverIds: regularIds, includeRegular: true, includeCore: false });
    }
    if (coreIds.length > 0) {
      attempts.push({ serverIds: coreIds, includeRegular: false, includeCore: true });
    }
    for (const request of attempts) {
      let lastResult = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        lastResult = await invalidateMcpAggregatorCaches({
          ...request,
          reason: "mcp-operation-ready",
          logger: console,
        });
        if (lastResult.success) break;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** (attempt - 1)));
        }
      }
      if (!lastResult?.success) {
        console.warn(
          `[MCP Operation] Aggregator invalidation remained degraded for ${request.serverIds.join(",")}`,
        );
      }
    }
  }

  async function reconcileMcpOperationConfiguration({
    operationId,
    kind,
    serverIds = [],
    attempt = 1,
    excludedServerIds = [],
  }) {
    try {
      const runtimeEnv = createMcpRuntimeEnv();
      if (excludedServerIds.length > 0) {
        runtimeEnv.portico_MCP_GENERATION_EXCLUDED_SERVER_IDS =
          excludedServerIds.join(",");
      }
      await regenerateMcpInfrastructure(
        execPromise,
        bootstrap.PROJECT_ROOT,
        runtimeEnv,
        { isPackagedApp: app.isPackaged, timeout: 60000 },
      );
      return { success: true };
    } catch (error) {
      const message = normalizeErrorText(error) || error.message;
      const attribution = extractAttributedServerFailure(
        message,
        bootstrap.PROJECT_ROOT,
      );
      const attributedServerId = attribution?.serverId || null;
      if (
        attributedServerId &&
        serverIds.includes(attributedServerId) &&
        !excludedServerIds.includes(attributedServerId) &&
        !isCoreServer(attributedServerId)
      ) {
        const attributedFailure = {
          serverId: attributedServerId,
          code: "CONFIG_GENERATION_FAILED",
          message,
          source: "config",
          stage: "config_generation",
          retryable: true,
          ...(attribution.configPath
            ? { configPath: attribution.configPath }
            : {}),
        };
        recordAndPublishStartupFailure(
          {
            ...attributedFailure,
            operation: kind,
            deploymentType: "docker",
            error: message,
            errorCode: attributedFailure.code,
          },
          {
            logger: console,
            reason: `mcp-operation-config-failure:${operationId}:attempt-${attempt}`,
          },
        );
        return { success: false, attributedFailure };
      }

      const sharedError = new Error(message);
      sharedError.code = "CONFIG_GENERATION_FAILED";
      sharedError.source = "config";
      sharedError.stage = "config_generation";
      sharedError.retryable = true;
      throw sharedError;
    }
  }

  mcpOperationCoordinator = new McpOperationCoordinator({
    operationManager: defaultMcpOperationManager,
    resolveServerLabel: (server) =>
      resolveMcpServerDisplayName(bootstrap.PROJECT_ROOT, server.serverId),
    operationContextProvider: () => ({
      rootClassification: app.isPackaged
        ? "managed-runtime"
        : "repo-checkout",
      channel: bootstrap.getCurrentChannel?.() || "unknown",
      source: "main-process",
    }),
    onOperationStarted({ operationId }) {
      readinessPublisher.beginOperation(operationId);
    },
    async onOperationEffectsFinalized({ operationId, snapshot }) {
      try {
        const rows = operationRows(snapshot).filter(
          (row) =>
            row.terminal && row.error?.code !== "MCP_SERVER_NOT_FOUND",
        );
        if (rows.length > 0) {
          await readinessPublisher.publish(
            rows.map((row) => ({
              serverId: row.serverId || row.id,
              deploymentType: row.deploymentType || "docker",
              status: row.phase === "tool_ready" ? "healthy" : row.phase,
              phase: row.phase,
              outcome: row.outcome,
              healthy: row.healthy === true || row.phase === "tool_ready",
              runtimeStarted:
                row.healthy === true || row.phase === "tool_ready",
              configured:
                row.configured !== false && row.phase !== "not_configured",
              toolsCount: row.toolsCount,
              error:
                row.error?.message ||
                row.error ||
                row.configurationMessage ||
                null,
              requiredAction: row.requiredAction,
              targetEnabled: row.targetEnabled,
              lifecycleSessionId: snapshot?.lifecycleSessionId,
              desiredRevision: snapshot?.desiredRevision,
              transitionSequence: row.sequence,
              source: "mcp-operation-final-publication",
              configPath: row.configPath,
            })),
            { operationId, reason: "mcp-operation-final-publication" },
          );
        }
      } finally {
        readinessPublisher.endOperation(operationId);
      }
    },
    mutateToggles: mutateMcpToggles,
    mutateDisableModes: (mutator, options) =>
      dockerMcp.mutateMcpDisableModes(mutator, options),
    restartServers: (serverIds, options) => restartMcpoServers(serverIds, options),
    reconcileConfiguration: reconcileMcpOperationConfiguration,
    async resolveRuntimeTargets() {
      return {
        configuredComposeServices: await dockerMcp.getConfiguredComposeServices(
          execPromise,
          bootstrap.PROJECT_ROOT,
          createMcpRuntimeEnv(),
        ),
      };
    },
    async publishTerminalState(entry) {
      const snapshot = defaultMcpOperationManager.getMcpOperation(
        entry.operationId,
      );
      const row = operationRows(snapshot).find(
        (candidate) =>
          (candidate.serverId || candidate.id) === entry.serverId,
      );
      await readinessPublisher.publish(
        {
          ...entry,
          lifecycleSessionId: snapshot?.lifecycleSessionId,
          desiredRevision: snapshot?.desiredRevision,
          transitionSequence: (row?.sequence || 0) + 1,
          source: "mcp-operation-terminal",
        },
        { operationId: entry.operationId },
      );
    },
    disableServers: (serverIds, options = {}) =>
      executeBulkMcpToggle(null, serverIds, false, {
        ...options,
        skipTogglePersistence: true,
        skipHealthSync: true,
      }),
    async inspectServer(server, { kind, clearDisableMode }) {
      if (!isKnownMcpServerId(server.serverId)) {
        const error = new Error(`MCP server is not installed: ${server.serverId}`);
        error.code = "MCP_SERVER_NOT_FOUND";
        error.source = "validation";
        error.stage = "preflight";
        error.retryable = false;
        throw error;
      }
      const deploymentType = isCoreServer(server.serverId)
        ? "core"
        : (await isHostDeployedServer(server.serverId))
          ? "host"
          : "docker";
      if (deploymentType === "core" && kind !== "restart") {
        const error = new Error(
          `Core MCP server toggles are managed by the application: ${server.serverId}`,
        );
        error.code = "MCP_CORE_TOGGLE_FORBIDDEN";
        error.source = "validation";
        error.stage = "preflight";
        error.retryable = false;
        throw error;
      }
      // PORTICO-410 defense-in-depth: only enables that explicitly clear the
      // disable mode (user-initiated paths) may lift a hard disable. The
      // model's REST path is refused earlier in api.js and never sets it.
      if (
        kind === "enable" &&
        !clearDisableMode &&
        dockerMcp.isServerHardDisabled(server.serverId)
      ) {
        const error = new Error(
          `Integration was hard-disabled by the user and can only be re-enabled from the Control Plane: ${server.serverId}`,
        );
        error.code = "INTEGRATION_HARD_DISABLED";
        error.source = "validation";
        error.stage = "preflight";
        error.retryable = false;
        throw error;
      }
      if (kind !== "enable") {
        return { deploymentType };
      }
      const issue = detectToggleEnablePreflightIssue(server.serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        findServerYaml: dockerMcp.findServerYaml,
        parseYaml,
        parseEnvFile: dockerMcp.parseEnvFile,
        checkServerConfigured,
      });
      if (!issue) return { deploymentType };
      if (isConfigurationRequiredPreflightIssue(issue)) {
        clearStartupFailure(bootstrap.PROJECT_ROOT, server.serverId, {
          logger: console,
        });
        return {
          deploymentType,
          requiresConfiguration: true,
          configurationIssue: issue.configurationIssue || null,
          configurationErrorCode: issue.errorCode || "NOT_CONFIGURED",
          configurationMessage: issue.message || issue.error || null,
          requiredAction: issue.requiredAction || "configure",
          requiresSecretReplacement:
            issue.requiresSecretReplacement === true,
          recoveryPrompt: issue.recoveryPrompt || null,
          recoveryLabel: issue.recoveryLabel || null,
        };
      }
      return {
        deploymentType,
        preflightError: {
          code: issue.errorCode || "MCP_OPERATION_PREFLIGHT_FAILED",
          message: issue.error || issue.message || "MCP preflight failed",
          source: issue.source || "config",
          stage: issue.stage || "preflight",
          retryable: issue.retryable !== false,
        },
      };
    },
    createReadinessScheduler({ operationId, servers }) {
      const readyInvalidator = createDebouncedReadyInvalidator(
        (serverIds) => invalidateReadyAggregatorEntries(serverIds, servers),
        { delayMs: 250, logger: console },
      );
      const scheduler = new McpReadinessScheduler({
        operationManager: defaultMcpOperationManager,
        async publishReadiness(entry) {
          await readinessPublisher.publish(
            {
              serverId: entry.serverId,
              deploymentType: entry.deploymentType || "docker",
              status: entry.healthy
                ? "healthy"
                : entry.readinessPhase || entry.phase || "starting",
              phase: entry.readinessPhase || entry.phase,
              healthy: entry.healthy === true,
              toolsCount: entry.toolsCount,
              providerReadiness:
                entry.providerReadiness || entry.provider_readiness || null,
              error: entry.error,
              desiredRevision: entry.desiredRevision,
              transitionSequence: entry.transitionSequence,
              targetEnabled: entry.targetEnabled,
              lifecycleSessionId: entry.lifecycleSessionId,
              source: "mcp-operation-direct-probe",
            },
            { operationId },
          );
        },
        onReadyBatch({ serverIds }) {
          readyInvalidator.enqueue(serverIds);
        },
        // One-shot log classification, invoked by the scheduler only after a
        // sustained fatal probe streak (never per poll). Raw log lines stay out
        // of the UI — only the classification leaves this function. A null
        // return means "no verdict" and the scheduler keeps today's behavior.
        async classifyStartupFailure({ serverId, deploymentType, error }) {
          // Grouped containers and the host runtime interleave several
          // servers' output in one log stream — a match there could belong to
          // a different server, so only dedicated docker containers qualify.
          if (deploymentType && deploymentType !== "docker") return null;
          const runtimeTarget = dockerMcp.getConfiguredMcpoRuntimeTarget(serverId);
          if (!runtimeTarget || runtimeTarget.grouped) return null;
          if (
            runtimeTarget.deploymentScope &&
            runtimeTarget.deploymentScope !== "docker"
          ) {
            return null;
          }
          // --since bounds the evidence to this operation's own attempt, so a
          // failure fixed before an earlier retry cannot re-condemn the server.
          const logResult = await getMcpServerLogs(serverId, {
            lines: 200,
            sinceSeconds: 180,
          });
          if (!logResult?.success || !logResult.logs) return null;
          if (logResult.log_source !== "managed_container") return null;
          const verdict = classifyStartupLogText(logResult.logs, { serverId });
          if (!verdict) return null;
          recordAndPublishStartupFailure(
            {
              serverId,
              deploymentType,
              operation: "enable",
              stage: "startup",
              source: "runtime",
              error: humanizeStartupFailureDetail(verdict, error),
            },
            {
              logger: console,
              reason: `readiness-startup-failure:${serverId}`,
            },
          );
          return verdict;
        },
      });
      return {
        async run(...args) {
          try {
            return await scheduler.run(...args);
          } finally {
            // The operation mutex is deliberately held until this final flush
            // finishes, so a subsequent mutation cannot race stale routes.
            await readyInvalidator.flush();
          }
        },
      };
    },
    logger: console,
  });
  registerMcpOperationCoordinator(mcpOperationCoordinator);

  if (!unsubscribeMcpOperationBroadcast) {
    unsubscribeMcpOperationBroadcast =
      defaultMcpOperationManager.onMcpOperationUpdated((snapshot) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            safeWebContentsSend(window, "mcp-operation-updated", snapshot, {
              tag: "mcp-operation-updated",
            });
          }
        });
      });
  }

  ipcMain.handle("resync-mcp-server-data", async (_event, serverId) => {
    const { promisify } = require("util");
    const { exec } = require("child_process");
    const { purgeServerDataVolume } = require("./mcp-data-resync");
    try {
      return await purgeServerDataVolume(String(serverId || ""), {
        execAsync: promisify(exec),
        operationManager: defaultMcpOperationManager,
        getRuntimeTarget: dockerMcp.getConfiguredMcpoRuntimeTarget,
        appSupportHostDir:
          (process.env.PORTICO_APP_SUPPORT_DIR || "").trim() ||
          app.getPath("userData"),
        logger: console,
      });
    } catch (error) {
      if (error.code === "MCP_OPERATION_BUSY") {
        return {
          success: false,
          errorCode: error.code,
          error: error.message,
          activeOperation:
            error.activeOperation || defaultMcpOperationManager.getActiveMcpOperation(),
        };
      }
      return {
        success: false,
        errorCode: error.code || "MCP_RESYNC_FAILED",
        error: error.message,
      };
    }
  });

  ipcMain.handle("start-mcp-operation", async (_event, request = {}) => {
    try {
      return mcpOperationCoordinator.start(request);
    } catch (error) {
      if (error.code === "MCP_OPERATION_BUSY") {
        return {
          success: false,
          errorCode: error.code,
          error: error.message,
          activeOperation:
            error.activeOperation || defaultMcpOperationManager.getActiveMcpOperation(),
        };
      }
      return {
        success: false,
        errorCode: error.code || "MCP_OPERATION_START_FAILED",
        error: error.message,
      };
    }
  });
  ipcMain.handle("get-active-mcp-operation", () =>
    defaultMcpOperationManager.getActiveMcpOperation(),
  );
  ipcMain.handle("get-mcp-operation", (_event, operationId) =>
    defaultMcpOperationManager.getMcpOperation(operationId),
  );

  ipcMain.handle("toggle-mcp-servers-bulk", async (_event, serverIds, enabled) => {
    try {
      return await startAndWaitForMcpOperation({
        clientRequestId: crypto.randomUUID(),
        kind: enabled ? "enable" : "disable",
        // PORTICO-410: bulk actions are UI-initiated — enables lift hard
        // disables; bulk disable stays soft.
        ...(enabled ? { clearDisableMode: true } : {}),
        serverIds,
      });
    } catch (error) {
      if (error.code === "MCP_OPERATION_BUSY") {
        const activeOperation =
          error.activeOperation || defaultMcpOperationManager.getActiveMcpOperation();
        return {
          success: false,
          errorCode: error.code,
          error: error.message,
          operationId: activeOperation?.operationId || null,
          activeOperation,
          results: [],
          errors: [error.message],
        };
      }
      return {
        success: false,
        error: error.message,
        results: [],
        errors: [error.message],
      };
    }
  });

  // Get tools list for a specific MCP server from its OpenAPI endpoint
  ipcMain.handle("get-server-tools", async (event, serverId, options = {}) => {
    try {
      const { getServerTools } = require("./docker-mcp");
      const result = await getServerTools(serverId, options);
      return result;
    } catch (error) {
      console.error(`[IPC] get-server-tools error for ${serverId}:`, error);
      return { success: false, error: error.message };
    }
  });

  // Save disabled tools configuration for a server
  ipcMain.handle(
    "save-server-tools",
    async (event, serverId, disabledTools) => {
      let releaseMutation = null;
      try {
        releaseMutation = defaultMcpOperationManager.acquireMutationLease({
          kind: "save_server_tools",
          source: "configuration_modal",
        });
        const { saveServerTools } = require("./docker-mcp");
        const result = await saveServerTools(serverId, disabledTools);
        if (result?.success) {
          clearStartupFailure(bootstrap.PROJECT_ROOT, serverId, {
            logger: console,
          });
        }
        return result;
      } catch (error) {
        console.error(`[IPC] save-server-tools error for ${serverId}:`, error);
        return {
          success: false,
          error: error.message,
          errorCode: error.code || "SAVE_SERVER_TOOLS_FAILED",
          activeOperation: error.activeOperation || null,
          activeMutation: error.activeMutation || null,
        };
      } finally {
        releaseMutation?.();
      }
    },
  );

  // Invoke an MCP tool for testing purposes
  ipcMain.handle(
    "invoke-mcp-tool",
    async (event, serverId, toolName, inputs, mcpoPort) => {
      try {
        const { invokeMcpTool } = require("./docker-mcp");
        const result = await invokeMcpTool(
          serverId,
          toolName,
          inputs,
          mcpoPort,
        );
        return result;
      } catch (error) {
        console.error(
          `[IPC] invoke-mcp-tool error for ${serverId}/${toolName}:`,
          error,
        );
        return { success: false, error: error.message };
      }
    },
  );

  // Per-skill agent usage for the renderer's "used by N agents" badges.
  // Reuses the referential-integrity guard's one-call inventory, but fails
  // OPEN at this boundary: a badge must never block or error the UI, so any
  // failure just means no badges this cycle. (The guard itself stays
  // fail-closed where it protects mutations.) One MCP call per invocation,
  // invoked only from user-triggered render cycles — no cache, no timers.
  ipcMain.handle("list-agent-skill-usage", async () => {
    try {
      const agents = await agentSkillUsageGuard.listAgentSkillReferences();
      // Piggyback: the first cycle where the agent inventory answered proves
      // the subagents server is up — run the seedMigrations relink sweep once
      // per launch (no timers; retries next cycle if it could not complete).
      maybeRunStartupAgentRelinkSweep();
      maybeRunAgentLinkAdoptionSweep();
      return {
        success: true,
        agents: agents.map(({ id, name, leaves }) => ({
          id,
          name,
          leaves: Array.from(leaves),
        })),
      };
    } catch (error) {
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Local-only agent warning flags (SKILLS_NOT_FOUND today) for the renderer's
  // warning icon / detail-view surfaces. Fail-open like the usage badges: a
  // warning glyph must never block or error the UI.
  ipcMain.handle("list-agent-flags", async () => {
    try {
      const flags = await require("./agent-local-flags").listFlags();
      return { success: true, flags };
    } catch (error) {
      return { success: false, error: error.message, flags: {} };
    }
  });

  // Get Agent Skills
  ipcMain.handle("get-skills", async () => {
    try {
      // Keep the permissive Electron catalog and strict Skills MCP catalog in
      // lockstep. Identity/frontmatter repair is idempotent and fail-closed;
      // an unsafe entry remains untouched while other User skills still load.
      try {
        await userSkillReconciliation.reconcileUserSkills({
          projectRoot: bootstrap.PROJECT_ROOT,
        });
      } catch (error) {
        console.warn("[UserSkills] pre-scan reconciliation deferred", {
          code: error?.code || "user_skill_reconciliation_failed",
        });
      }
      const skillsByName = new Map();
      const skillDirs = [
        {
          path: path.join(bootstrap.PROJECT_ROOT, "skills"),
          source: "system",
          nested: false,
        },
        {
          path: path.join(bootstrap.PROJECT_ROOT, "skills-user"),
          source: "user",
          nested: false,
        },
        {
          path: path.join(bootstrap.PROJECT_ROOT, "skills-marketplace"),
          source: "marketplace",
          nested: true,
        },
      ];
      const sourcePrecedence = {
        system: 3,
        user: 2,
        marketplace: 1,
      };
      // Load default logo as base64
      let defaultLogo = null;
      try {
        const defaultLogoPath = path.join(
          bootstrap.PROJECT_ROOT,
          "electron-app",
          "assets",
          "icon_raw.png",
        );
        const logoBuffer = await fsPromises.readFile(defaultLogoPath);
        defaultLogo = `data:image/png;base64,${logoBuffer.toString("base64")}`;
      } catch (e) {
        console.log("[IPC] Could not load default skill logo:", e.message);
      }

      async function directoryHasMatchingFiles(rootDir, matcher = null) {
        try {
          const rootStat = await fsPromises.stat(rootDir);
          if (!rootStat.isDirectory()) return false;
        } catch (e) {
          return false;
        }

        const pendingDirs = [rootDir];
        while (pendingDirs.length > 0) {
          const currentDir = pendingDirs.pop();
          let entries = [];
          try {
            entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
          } catch (e) {
            continue;
          }

          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              pendingDirs.push(fullPath);
              continue;
            }
            if (!matcher || matcher(entry.name, fullPath)) {
              return true;
            }
          }
        }

        return false;
      }

      // Helper function to scan a skill directory
      async function scanSkillDir(
        skillDirPath,
        canonicalSkillName,
        source,
        marketplaceId = null,
        marketplaceOwner = null,
        marketplaceName = null,
        displayFallbackName = null,
        marketplaceSolutionId = null,
        updateState = null,
        pluginName = null,
      ) {
        const skillPath = path.join(skillDirPath, "SKILL.md");
        try {
          const frontmatter = await parseSkillDirectoryMetadata(skillDirPath);
          if (!frontmatter) {
            return;
          }

          const metadata = frontmatter.metadata || {};

          // Check for references directory with actual files
          const hasReferences = await directoryHasMatchingFiles(
            path.join(skillDirPath, "references"),
          );

          // Check for scripts directory with actual .py files
          const hasScripts = await directoryHasMatchingFiles(
            path.join(skillDirPath, "scripts"),
            (name) => name.endsWith(".py"),
          );

          // Check for logo
          let logo = null;
          const logoExtensions = ["png", "jpg", "jpeg", "svg"];
          for (const ext of logoExtensions) {
            const logoPath = path.join(skillDirPath, `logo.${ext}`);
            try {
              const logoBuffer = await fsPromises.readFile(logoPath);
              const mimeType = getSkillImageMimeType(logoPath);
              if (mimeType) {
                logo = `data:${mimeType};base64,${logoBuffer.toString("base64")}`;
              }
              break;
            } catch (e) {
              // Logo not found with this extension
            }
          }

          // Normalize common metadata fields with top-level fallbacks
          const priority =
            metadata.priority || frontmatter.priority || "medium";
          let triggers = metadata.triggers || frontmatter.triggers || [];
          if (typeof triggers === "string") {
            triggers = [triggers];
          }

          // `author` remains descriptive content metadata. User ownership is
          // represented independently by the durable authenticated email.
          const author =
            metadata.author ||
            frontmatter.author ||
            marketplaceOwner ||
            "Unknown";
          const createdByEmail =
            metadata.created_by_email || frontmatter.created_by_email || "";

          const rawDisplayName =
            metadata.display_name ||
            frontmatter.display_name ||
            frontmatter.name ||
            displayFallbackName ||
            canonicalSkillName;
          const displayName = formatSkillDisplayName(rawDisplayName);

          const existingSkill = skillsByName.get(canonicalSkillName);
          if (existingSkill) {
            const existingRank = sourcePrecedence[existingSkill.source] || 0;
            const newRank = sourcePrecedence[source] || 0;
            if (newRank <= existingRank) {
              if (existingSkill.source === "system" && source === "user") {
                console.log(
                  `[IPC] Skipping user skill "${canonicalSkillName}" due to system collision`,
                );
              } else {
                console.log(
                  `[IPC] Skipping duplicate skill "${canonicalSkillName}" from ${source}`,
                );
              }
              return;
            }
          }

          skillsByName.set(canonicalSkillName, {
            // Use directory name as the canonical identifier for file operations.
            name: canonicalSkillName,
            display_name: displayName,
            description:
              frontmatter.description || "No description available",
            source,
            priority,
            version: metadata.version || frontmatter.version || "1.0",
            author,
            created_by_email: createdByEmail,
            triggers,
            has_references: hasReferences,
            has_scripts: hasScripts,
            logo,
            skill_path: skillDirPath,
            marketplace_id: marketplaceId,
            marketplace_name: marketplaceName,
            // Plugin identity for plugin-layout installs
            // (skills-marketplace/{mp}/{plugin}/{skill}); null for flat.
            plugin_name: pluginName,
            // Provenance gate for agent attachment: system/user/Solutions
            // always qualify; git marketplaces qualify via the allowlist.
            agent_attachable: require("./marketplace-allowlist").skillProvenanceQualifies({
              source,
              marketplaceId,
              registryEntry: marketplaceId
                ? (marketplacesConfig?.marketplaces || []).find(
                    (m) => m.id === marketplaceId,
                  ) || null
                : null,
            }),
            marketplace_relationship:
              source === "marketplace" ? "installed" : null,
            marketplace_solution_id:
              source === "marketplace" && marketplaceSolutionId
                ? marketplaceSolutionId
                : null,
            // Update-available state from the installed-skill record (git
            // version compare or solutions listing freshness), surfaced so
            // the Skills tab can badge/tint outdated installed copies.
            has_update: updateState?.hasUpdate === true,
            has_conflict: updateState?.hasConflict === true,
            is_read_only: source !== "user",
            ootb_seeded:
              source === "marketplace" && marketplaceId
                ? ootbSeededKeys.has(
                    `${marketplaceId}/${path.basename(skillDirPath)}`,
                  )
                : false,
          });
        } catch (e) {
          if (e?.code !== "ENOENT") {
            console.warn(
              `[IPC] Failed to parse skill metadata at ${skillPath}: ${e.message}`,
            );
          }
        }
      }

      // Load marketplace config for author info and reconcile legacy installs.
      let marketplacesConfig = null;
      try {
        marketplacesConfig = await marketplaceService.loadMarketplacesConfig(
          bootstrap.PROJECT_ROOT,
          { logger: console },
        );
      } catch (e) {
        console.log(`[Marketplace] Could not load marketplace config: ${e.message}`);
      }
      // Built-in bundle seeds are immutable at the service chokepoint
      // (uninstall/detach refuse) — surface that so skill cards stop
      // offering actions that can never succeed. Fail-open: no seed info
      // just means no Built-in gating.
      let ootbSeededKeys = new Set();
      try {
        ootbSeededKeys = await require("./marketplace-ootb").listOotbSeededKeys(
          bootstrap.PROJECT_ROOT,
        );
      } catch (e) {
        console.log(`[Marketplace] Could not load OOTB seed keys: ${e.message}`);
      }

      // Index installed records by their normalized localPath once, so each
      // scanned skill directory is a Map lookup instead of a linear scan that
      // re-normalizes every record's path.
      const installedByLocalPath = new Map(
        (marketplacesConfig?.installedSkills || []).map((installed) => [
          String(installed?.localPath || "").replace(/\\/g, "/"),
          installed,
        ]),
      );

      for (const { path: skillDirPath, source, nested } of skillDirs) {
        try {
          const entries = await fsPromises.readdir(skillDirPath, {
            withFileTypes: true,
          });

          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".") || entry.name.startsWith("_"))
              continue;

            if (nested) {
              // Marketplace structure: skills-marketplace/{marketplace-id}/{skill-name}/SKILL.md
              const marketplaceId = entry.name;
              const marketplacePath = path.join(skillDirPath, marketplaceId);

              // Get marketplace owner for author fallback
              let marketplaceOwner = null;
              let marketplaceName = marketplaceId;
              if (marketplacesConfig) {
                const marketplace = marketplacesConfig.marketplaces?.find(
                  (m) => m.id === marketplaceId,
                );
                marketplaceOwner = marketplace?.owner?.name;
                marketplaceName = marketplace?.name || marketplaceId;
              }
              if (marketplaceId === "ai-marketplace") {
                marketplaceOwner = marketplaceOwner || "Portico AI Marketplace";
                marketplaceName = marketplaceName === marketplaceId
                  ? "Solutions Marketplace"
                  : marketplaceName;
              }

              // Scan one skill directory (flat depth-2 or plugin depth-3),
              // matching the installed record by its exact localPath.
              const scanMarketplaceSkillDir = async (entryPath, skillId, pluginName) => {
                const relativeLocalPath = pluginName
                  ? `skills-marketplace/${marketplaceId}/${pluginName}/${skillId}`
                  : `skills-marketplace/${marketplaceId}/${skillId}`;
                const installedMarketplaceSkill =
                  installedByLocalPath.get(relativeLocalPath) || null;
                const marketplaceSolutionId =
                  installedMarketplaceSkill?.skillSource?.type ===
                    "ai-marketplace-solution" &&
                  typeof installedMarketplaceSkill?.skillSource?.solutionId ===
                    "string"
                    ? installedMarketplaceSkill.skillSource.solutionId.trim()
                    : "";
                await scanSkillDir(
                  entryPath,
                  pluginName
                    ? `${marketplaceId}/${pluginName}/${skillId}`
                    : `${marketplaceId}/${skillId}`,
                  source,
                  marketplaceId,
                  marketplaceOwner,
                  marketplaceName,
                  skillId,
                  marketplaceSolutionId,
                  installedMarketplaceSkill,
                  pluginName,
                );
              };
              const dirHasSkillMd = async (dirPath) => {
                try {
                  return (
                    await fsPromises.stat(path.join(dirPath, "SKILL.md"))
                  ).isFile();
                } catch (e) {
                  return false;
                }
              };

              try {
                const marketplaceEntries = await fsPromises.readdir(
                  marketplacePath,
                  { withFileTypes: true },
                );
                for (const skillEntry of marketplaceEntries) {
                  if (!skillEntry.isDirectory()) continue;
                  if (
                    skillEntry.name.startsWith(".") ||
                    skillEntry.name.startsWith("_")
                  ) {
                    continue;
                  }
                  const entryPath = path.join(marketplacePath, skillEntry.name);
                  if (await dirHasSkillMd(entryPath)) {
                    // Flat layout: skills-marketplace/{mp}/{skill}/SKILL.md
                    await scanMarketplaceSkillDir(entryPath, skillEntry.name, null);
                    continue;
                  }

                  // Plugin layout: skills-marketplace/{mp}/{plugin}/{skill}/
                  // SKILL.md — one level deeper, never beyond (a SKILL.md dir
                  // is a skill; anything under it is reference material).
                  let pluginEntries = [];
                  try {
                    pluginEntries = await fsPromises.readdir(entryPath, {
                      withFileTypes: true,
                    });
                  } catch (e) {
                    continue;
                  }
                  for (const leafEntry of pluginEntries) {
                    if (!leafEntry.isDirectory()) continue;
                    if (
                      leafEntry.name.startsWith(".") ||
                      leafEntry.name.startsWith("_")
                    ) {
                      continue;
                    }
                    const leafPath = path.join(entryPath, leafEntry.name);
                    if (!(await dirHasSkillMd(leafPath))) continue;
                    await scanMarketplaceSkillDir(
                      leafPath,
                      leafEntry.name,
                      skillEntry.name,
                    );
                  }
                }
              } catch (e) {
                // A broken marketplace directory must not read as "no skills"
                // in a support bundle without saying which one and why.
                require("./marketplace-diagnostics").logMarketplaceDiag(
                  "catalog",
                  "dir:skipped",
                  {
                    marketplaceId,
                    ...require("./marketplace-diagnostics").safeErrorMeta(e),
                  },
                  "warn",
                );
              }
            } else {
              // For flat directories (system, user), scan directly
              // Structure: skills/{skill-name}/SKILL.md
              await scanSkillDir(
                path.join(skillDirPath, entry.name),
                entry.name,
                source,
                null,
                null,
                entry.name,
              );
            }
          }
        } catch (e) {
          // Directory doesn't exist, skip
          console.log(`[IPC] Skills directory not found: ${skillDirPath}`);
        }
      }

      const skills = Array.from(skillsByName.values());
      console.log(`[IPC] Loaded ${skills.length} skills`);
      require("./marketplace-diagnostics").logMarketplaceDiag(
        "catalog",
        "scan:summary",
        {
          totalCount: skills.length,
          systemCount: skills.filter((s) => s.source === "system").length,
          userCount: skills.filter((s) => s.source === "user").length,
          marketplaceFlatCount: skills.filter(
            (s) => s.source === "marketplace" && !s.plugin_name,
          ).length,
          marketplacePluginCount: skills.filter(
            (s) => s.source === "marketplace" && s.plugin_name,
          ).length,
        },
      );
      return { success: true, skills, defaultLogo };
    } catch (error) {
      // This catch returns skills: [] — without an error-level trail a total
      // catalog loss reads as "you have no skills" in a bug report.
      console.error(`[IPC] get-skills error:`, error);
      require("./marketplace-diagnostics").logMarketplaceDiag(
        "catalog",
        "load:failed",
        require("./marketplace-diagnostics").safeErrorMeta(error),
        "error",
      );
      return {
        success: false,
        error: error.message,
        skills: [],
        defaultLogo: null,
      };
    }
  });

  // LEGACY: Old skill scanning code removed - now using helper function above

  // Get all files in a skill directory - also needs to handle nested marketplace structure
  ipcMain.handle("get-skill-files-OLD-REMOVED", async () => {
    return { success: false };
  });

  function getAllowedSkillRoots() {
    return [
      path.join(bootstrap.PROJECT_ROOT, "skills"),
      path.join(bootstrap.PROJECT_ROOT, "skills-user"),
      path.join(bootstrap.PROJECT_ROOT, "skills-marketplace"),
    ];
  }

  function getAllowedMcpServerRoots() {
    return [
      path.join(bootstrap.PROJECT_ROOT, "mcp-configs"),
      path.join(bootstrap.PROJECT_ROOT, "mcp-configs-user"),
    ];
  }

  function isPathWithinRoots(candidatePath, roots) {
    return roots.some(
      (root) => candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`),
    );
  }

  function resolveSkillPathFromInput(skillPath, allowedRoots) {
    if (!skillPath || typeof skillPath !== "string") {
      return null;
    }

    const resolvedPath = path.resolve(bootstrap.PROJECT_ROOT, skillPath);
    if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
      return null;
    }

    return resolvedPath;
  }

  function resolveMcpServerPathFromInput(serverPath, allowedRoots) {
    if (!serverPath || typeof serverPath !== "string") {
      return null;
    }

    const resolvedPath = path.resolve(bootstrap.PROJECT_ROOT, serverPath);
    if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
      return null;
    }

    return resolvedPath;
  }

  async function resolveValidSkillDirectory(skillPath) {
    const allowedRoots = getAllowedSkillRoots();
    const resolvedPath = resolveSkillPathFromInput(skillPath, allowedRoots);
    if (!resolvedPath) {
      return { success: false, error: "Invalid skill path" };
    }

    let stat;
    try {
      stat = await fsPromises.stat(resolvedPath);
    } catch (error) {
      return { success: false, error: "Skill path not found" };
    }

    if (!stat.isDirectory()) {
      return { success: false, error: "Skill path is not a directory" };
    }

    const skillMdPath = path.join(resolvedPath, "SKILL.md");
    try {
      const skillMdStat = await fsPromises.stat(skillMdPath);
      if (!skillMdStat.isFile()) {
        return { success: false, error: "SKILL.md not found in skill directory" };
      }
    } catch (error) {
      return { success: false, error: "SKILL.md not found in skill directory" };
    }

    return { success: true, resolvedPath };
  }

  async function resolveValidMcpServerDirectory(serverPath) {
    const allowedRoots = getAllowedMcpServerRoots();
    const resolvedPath = resolveMcpServerPathFromInput(serverPath, allowedRoots);
    if (!resolvedPath) {
      return { success: false, error: "Invalid MCP server path" };
    }

    let stat;
    try {
      stat = await fsPromises.stat(resolvedPath);
    } catch (error) {
      return { success: false, error: "MCP server path not found" };
    }

    if (!stat.isDirectory()) {
      return { success: false, error: "MCP server path is not a directory" };
    }

    const serverDir = path.basename(resolvedPath);
    const yamlPath = path.join(resolvedPath, `${serverDir}.yaml`);
    try {
      const yamlStat = await fsPromises.stat(yamlPath);
      if (!yamlStat.isFile()) {
        return {
          success: false,
          error: "MCP server YAML config not found in server directory",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: "MCP server YAML config not found in server directory",
      };
    }

    return { success: true, resolvedPath };
  }

  function safeSkillPathComponent(value) {
    const cleaned = String(value || "")
      .replaceAll("/", "")
      .replaceAll("\\", "")
      .replaceAll("\0", "")
      .trim()
      .replace(/^\.+/, "");
    return cleaned.slice(0, 255);
  }

  function safeMcpServerPathComponent(value) {
    const cleaned = String(value || "")
      .replaceAll("/", "")
      .replaceAll("\\", "")
      .replaceAll("\0", "")
      .trim()
      .replace(/^\.+/, "");
    return cleaned.slice(0, 255);
  }

  function getSkillsExportRoot() {
    return path.join(bootstrap.PROJECT_ROOT, "skills-exported");
  }

  function getMcpServersExportRoot() {
    return path.join(bootstrap.PROJECT_ROOT, "mcp-servers-exported");
  }

  async function runSkillExportCommand(command, args, options = {}) {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `${command} exited with code ${code}`,
          ),
        );
      });
    });
  }

  async function createSkillExportArchive(skillDir) {
    const exportRoot = getSkillsExportRoot();
    await fsPromises.mkdir(exportRoot, { recursive: true });

    const folderName = path.basename(skillDir);
    const safeSkillName = safeSkillPathComponent(folderName) || "skill";
    const timestamp = Math.floor(Date.now() / 1000);
    const archiveGuid = crypto.randomUUID().replaceAll("-", "");
    const archivePath = path.join(
      exportRoot,
      `${timestamp}-${safeSkillName}-${archiveGuid}.zip`,
    );

    if (process.platform === "win32") {
      await runSkillExportCommand(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          skillDir,
          archivePath,
        ],
      );
      return archivePath;
    }

    await runSkillExportCommand(
      "zip",
      ["-r", "--symlinks", archivePath, folderName],
      { cwd: path.dirname(skillDir) },
    );
    return archivePath;
  }

  async function createMcpServerExportArchive(serverDir) {
    const exportRoot = getMcpServersExportRoot();
    await fsPromises.mkdir(exportRoot, { recursive: true });

    const folderName = path.basename(serverDir);
    const safeServerName = safeMcpServerPathComponent(folderName) || "mcp-server";
    const timestamp = Math.floor(Date.now() / 1000);
    const archiveGuid = crypto.randomUUID().replaceAll("-", "");
    const archivePath = path.join(
      exportRoot,
      `${timestamp}-${safeServerName}-${archiveGuid}.zip`,
    );

    if (process.platform === "win32") {
      await runSkillExportCommand(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          serverDir,
          archivePath,
        ],
      );
      return archivePath;
    }

    await runSkillExportCommand(
      "zip",
      ["-r", "--symlinks", archivePath, folderName],
      { cwd: path.dirname(serverDir) },
    );
    return archivePath;
  }

  ipcMain.handle("open-skill-folder", async (_event, { skillPath } = {}) => {
    try {
      const validation = await resolveValidSkillDirectory(skillPath);
      if (!validation.success) {
        return validation;
      }
      const { resolvedPath } = validation;

      const openError = await shell.openPath(resolvedPath);
      if (openError) {
        throw new Error(openError);
      }

      return { success: true, path: resolvedPath };
    } catch (error) {
      console.error("[IPC] open-skill-folder error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("export-skill", async (_event, { skillPath } = {}) => {
    try {
      const validation = await resolveValidSkillDirectory(skillPath);
      if (!validation.success) {
        return validation;
      }
      const { resolvedPath } = validation;

      const archivePath = await createSkillExportArchive(resolvedPath);
      shell.showItemInFolder(archivePath);

      return {
        success: true,
        path: archivePath,
        message: `Exported skill archive: ${path.basename(archivePath)}`,
      };
    } catch (error) {
      console.error("[IPC] export-skill error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "open-mcp-server-folder",
    async (_event, { serverPath } = {}) => {
      try {
        const validation = await resolveValidMcpServerDirectory(serverPath);
        if (!validation.success) {
          return validation;
        }
        const { resolvedPath } = validation;

        const openError = await shell.openPath(resolvedPath);
        if (openError) {
          throw new Error(openError);
        }

        return { success: true, path: resolvedPath };
      } catch (error) {
        console.error("[IPC] open-mcp-server-folder error:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("export-mcp-server", async (_event, { serverPath } = {}) => {
    try {
      const validation = await resolveValidMcpServerDirectory(serverPath);
      if (!validation.success) {
        return validation;
      }
      const { resolvedPath } = validation;

      const archivePath = await createMcpServerExportArchive(resolvedPath);
      shell.showItemInFolder(archivePath);

      return {
        success: true,
        path: archivePath,
        message: `Exported integration archive: ${path.basename(archivePath)}`,
      };
    } catch (error) {
      console.error("[IPC] export-mcp-server error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-skill-files", async (event, skillName, skillPath) => {
    try {
      const allowedRoots = getAllowedSkillRoots();

      let skillDir = null;

      const resolvedPath = resolveSkillPathFromInput(skillPath, allowedRoots);
      if (resolvedPath) {
        try {
          const stat = await fsPromises.stat(resolvedPath);
          if (stat.isDirectory()) {
            skillDir = resolvedPath;
          }
        } catch (e) {
          // Invalid or missing skill path, fallback to name lookup
        }
      }

      // Search in all skill directories including nested marketplace structure
      const searchPaths = [];
      if (!skillDir) {
        searchPaths.push(
          path.join(bootstrap.PROJECT_ROOT, "skills", skillName),
          path.join(bootstrap.PROJECT_ROOT, "skills-user", skillName),
        );
      }

      // Add all possible marketplace paths
      if (!skillDir) {
        const marketplacePath = path.join(
          bootstrap.PROJECT_ROOT,
          "skills-marketplace",
        );
        try {
          const marketplaces = await fsPromises.readdir(marketplacePath, {
            withFileTypes: true,
          });
          for (const mp of marketplaces) {
            if (!mp.isDirectory() || mp.name.startsWith(".")) continue;

            const marketplaceRoot = path.join(marketplacePath, mp.name);
            searchPaths.push(path.join(marketplaceRoot, skillName));

            try {
              const bundleEntries = await fsPromises.readdir(marketplaceRoot, {
                withFileTypes: true,
              });
              for (const bundleEntry of bundleEntries) {
                if (!bundleEntry.isDirectory()) continue;
                if (bundleEntry.name.startsWith(".")) continue;
                searchPaths.push(
                  path.join(
                    marketplaceRoot,
                    bundleEntry.name,
                    "skills",
                    skillName,
                  ),
                );
              }
            } catch (e) {
              // Could not read marketplace bundle directories
            }
          }
        } catch (e) {
          // Marketplace directory doesn't exist
        }

        for (const searchPath of searchPaths) {
          try {
            await fsPromises.access(searchPath);
            skillDir = searchPath;
            break;
          } catch (e) {
            // Not found in this path
          }
        }
      }

      if (!skillDir) {
        return { success: false, error: `Skill "${skillName}" not found` };
      }

      // Recursively get all files - returns flat list with relativePath and fullPath
      async function getFilesRecursively(dir, basePath = "", skillDirRoot) {
        const files = [];
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          if (entry.isDirectory() && entry.name === "__pycache__") continue;
          if (entry.name.endsWith(".pyc")) continue;

          const relativePath = basePath
            ? `${basePath}/${entry.name}`
            : entry.name;
          const fullPath = path.join(skillDirRoot, relativePath);

          if (entry.isDirectory()) {
            // Recurse into directories
            const subFiles = await getFilesRecursively(
              path.join(dir, entry.name),
              relativePath,
              skillDirRoot,
            );
            files.push(...subFiles);
          } else {
            files.push({
              name: entry.name,
              relativePath: relativePath,
              fullPath: fullPath,
              type: "file",
            });
          }
        }

        return files;
      }

      const files = await getFilesRecursively(skillDir, "", skillDir);
      return { success: true, files, skillDir, basePath: skillDir };
    } catch (error) {
      console.error(`[IPC] get-skill-files error:`, error);
      return { success: false, error: error.message };
    }
  });

  function getSkillImageMimeType(filePath) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    switch (extension) {
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".gif":
        return "image/gif";
      case ".webp":
        return "image/webp";
      case ".svg":
        return "image/svg+xml";
      case ".bmp":
        return "image/bmp";
      case ".ico":
        return "image/x-icon";
      case ".avif":
        return "image/avif";
      default:
        return null;
    }
  }

  // Read skill file content - also needs to handle nested marketplace structure
  ipcMain.handle("read-skill-file", async (event, filePath) => {
    try {
      // Security check: ensure path is within allowed directories
      const allowedRoots = getAllowedSkillRoots();

      const resolvedPath = path.resolve(bootstrap.PROJECT_ROOT, filePath);
      const isAllowed = isPathWithinRoots(resolvedPath, allowedRoots);

      if (!isAllowed) {
        return {
          success: false,
          error: "Access denied: path not in allowed directories",
        };
      }

      const imageMimeType = getSkillImageMimeType(resolvedPath);
      if (imageMimeType) {
        const bytes = await fsPromises.readFile(resolvedPath);
        const data = bytes.toString("base64");
        return {
          success: true,
          fileKind: "image",
          mimeType: imageMimeType,
          data,
          dataUrl: `data:${imageMimeType};base64,${data}`,
          sizeBytes: bytes.length,
        };
      }

      const content = await fsPromises.readFile(resolvedPath, "utf8");
      return { success: true, fileKind: "text", content };
    } catch (error) {
      console.error(`[IPC] read-skill-file error:`, error);
      return { success: false, error: error.message };
    }
  });

  // Save edits to a skill file. Restricted to user-authored skills
  // (skills-user root) — system and marketplace copies are read-only in the
  // UI; marketplace copies must be detached to a user copy first. Edit-only:
  // the file must already exist (the file tree is the source of truth).
  const MAX_SKILL_FILE_CHARS = 2_000_000;
  ipcMain.handle("write-skill-file", async (event, filePath, content) => {
    try {
      if (typeof content !== "string") {
        return { success: false, error: "Content must be a string" };
      }
      if (content.length > MAX_SKILL_FILE_CHARS) {
        return { success: false, error: "File is too large to save" };
      }
      const userRoot = path.join(bootstrap.PROJECT_ROOT, "skills-user");
      const resolvedPath = path.resolve(bootstrap.PROJECT_ROOT, filePath);
      if (!isPathWithinRoots(resolvedPath, [userRoot])) {
        return { success: false, error: "Only user skills are editable" };
      }
      let stat;
      try {
        stat = await fsPromises.lstat(resolvedPath);
      } catch {
        return { success: false, error: "File not found" };
      }
      if (!stat.isFile()) {
        return { success: false, error: "Path is not a file" };
      }
      // A symlink (or symlinked parent dir) inside skills-user can point
      // outside the sandbox; the prefix check above is textual only, and
      // writeFile dereferences links. Verify the real filesystem path too.
      const [realPath, realRoot] = await Promise.all([
        fsPromises.realpath(resolvedPath),
        fsPromises.realpath(userRoot),
      ]);
      if (!isPathWithinRoots(realPath, [realRoot])) {
        return { success: false, error: "Only user skills are editable" };
      }
      const relativeToUserRoot = path.relative(realRoot, realPath).split(path.sep);
      if (
        relativeToUserRoot.length === 2 &&
        relativeToUserRoot[1] === "SKILL.md"
      ) {
        await userSkillService.updateSkill({
          projectRoot: bootstrap.PROJECT_ROOT,
          skillName: relativeToUserRoot[0],
          skillContent: content,
        });
      } else {
        await userSkillService.writeTextAtomic(realPath, content);
        // Reference/script edits also diverge a published skill; SKILL.md
        // updates are flagged inside userSkillService.updateSkill.
        try {
          await require("./ai-marketplace-skill-links").markLinkDirty(
            relativeToUserRoot[0],
          );
        } catch (dirtyError) {
          console.warn(
            "[IPC] write-skill-file: could not flag unpublished changes",
            dirtyError?.message || dirtyError,
          );
        }
      }
      return { success: true };
    } catch (error) {
      console.error(`[IPC] write-skill-file error:`, error);
      return { success: false, error: error.message };
    }
  });

  // Duplicate any valid skill (system/user/marketplace) into an editable copy
  // under skills-user/. When `exact` is set (the Duplicate-with-name modal),
  // use the user-supplied name verbatim and REJECT on collision so the
  // renderer's uniqueness validation is authoritative; otherwise auto-suffix a
  // unique name (legacy behavior).
  ipcMain.handle("duplicate-skill", async (event, { skillPath, preferredName, exact } = {}) => {
    try {
      const validation = await resolveValidSkillDirectory(skillPath);
      if (!validation.success) {
        return validation;
      }
      const sourcePath = validation.resolvedPath;
      let skillName;
      if (exact) {
        skillName = marketplaceService.sanitizeUserSkillDirectoryName(preferredName);
        if (!skillName) {
          return { success: false, error: "A valid skill name is required" };
        }
        const candidatePath = path.join(
          bootstrap.PROJECT_ROOT,
          "skills-user",
          skillName,
        );
        const exists = await fsPromises
          .access(candidatePath)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          return {
            success: false,
            error: "A user skill with this name already exists",
          };
        }
      } else {
        skillName = await marketplaceService.resolveUniqueUserSkillDirectoryName(
          bootstrap.PROJECT_ROOT,
          preferredName,
          `${path.basename(sourcePath)}-copy`,
          "-copy",
        );
      }
      const copied = await userSkillService.copySkillToUser({
        projectRoot: bootstrap.PROJECT_ROOT,
        sourcePath,
        skillName,
      });
      return {
        success: true,
        skillName,
        localPath: copied.localPath,
      };
    } catch (error) {
      console.error(`[IPC] duplicate-skill error:`, error);
      return { success: false, error: error.message };
    }
  });

  // Delete a skill (user or marketplace only - system skills cannot be deleted)
  ipcMain.handle("delete-skill", async (event, skillName, skillPath) => {
    try {
      if (skillPath && typeof skillPath === "string") {
        const allowedRoots = getAllowedSkillRoots();
        const resolvedPath = resolveSkillPathFromInput(skillPath, allowedRoots);
        if (!resolvedPath) {
          return { success: false, error: "Invalid skill path" };
        }

        const systemRoot = path.join(bootstrap.PROJECT_ROOT, "skills");
        if (
          resolvedPath === systemRoot ||
          resolvedPath.startsWith(`${systemRoot}${path.sep}`)
        ) {
          return { success: false, error: "System skills cannot be deleted" };
        }

        try {
          const stat = await fsPromises.stat(resolvedPath);
          if (!stat.isDirectory()) {
            return { success: false, error: "Skill path is not a directory" };
          }
        } catch (e) {
          return { success: false, error: "Skill path not found" };
        }

        // Referential integrity: a skill still attached to agents cannot be
        // deleted (fail closed when the agent inventory is unreachable).
        try {
          await agentSkillUsageGuard.assertSkillDeletable({
            leafName: path.basename(resolvedPath),
          });
        } catch (guardError) {
          return {
            success: false,
            error: guardError.message,
            errorCode: guardError.code,
            ...(guardError.body !== undefined ? { body: guardError.body } : {}),
          };
        }

        await fsPromises.rm(resolvedPath, { recursive: true, force: true });

        const marketplaceRoot = path.join(
          bootstrap.PROJECT_ROOT,
          "skills-marketplace",
        );
        if (
          resolvedPath === marketplaceRoot ||
          resolvedPath.startsWith(`${marketplaceRoot}${path.sep}`)
        ) {
          const relative = path.relative(marketplaceRoot, resolvedPath);
          const parts = relative.split(path.sep).filter(Boolean);
          if (parts.length === 2) {
            try {
              await marketplaceService.removeInstalledSkillRecords(
                bootstrap.PROJECT_ROOT,
                { identities: [{ marketplaceId: parts[0], skillId: parts[1] }] },
              );
            } catch (configError) {
              console.log(
                `[IPC] Could not update marketplace config: ${configError.message}`,
              );
            }
          }
        }

        console.log(`[IPC] Deleted skill at path: ${resolvedPath}`);
        return { success: true };
      }

      // Validate skill name to prevent path traversal
      if (
        !skillName ||
        typeof skillName !== "string" ||
        skillName.includes("/") ||
        skillName.includes("\\") ||
        skillName.includes("..")
      ) {
        return { success: false, error: "Invalid skill name" };
      }

      // Check if skill exists in system directory (not deletable)
      const systemSkillPath = path.join(
        bootstrap.PROJECT_ROOT,
        "skills",
        skillName,
      );
      try {
        await fsPromises.access(systemSkillPath);
        return { success: false, error: "System skills cannot be deleted" };
      } catch (e) {
        // Not a system skill, continue
      }

      // Referential integrity: a skill still attached to agents cannot be
      // deleted (fail closed when the agent inventory is unreachable).
      try {
        await agentSkillUsageGuard.assertSkillDeletable({ leafName: skillName });
      } catch (guardError) {
        return {
          success: false,
          error: guardError.message,
          errorCode: guardError.code,
          ...(guardError.body !== undefined ? { body: guardError.body } : {}),
        };
      }

      // Check user skills directory
      const userSkillPath = path.join(
        bootstrap.PROJECT_ROOT,
        "skills-user",
        skillName,
      );
      try {
        await fsPromises.access(userSkillPath);
        // Found in user skills - delete it
        await fsPromises.rm(userSkillPath, { recursive: true, force: true });
        console.log(`[IPC] Deleted user skill: ${skillName}`);
        return { success: true };
      } catch (e) {
        // Not in user skills, check marketplace
      }

      // Check marketplace skills (nested structure: skills-marketplace/{marketplace-id}/{skill-name})
      const marketplacePath = path.join(
        bootstrap.PROJECT_ROOT,
        "skills-marketplace",
      );
      try {
        const marketplaces = await fsPromises.readdir(marketplacePath, {
          withFileTypes: true,
        });
        for (const mp of marketplaces) {
          if (!mp.isDirectory() || mp.name.startsWith(".")) continue;

          const marketplaceSkillPath = path.join(
            marketplacePath,
            mp.name,
            skillName,
          );
          try {
            await fsPromises.access(marketplaceSkillPath);
            // Found in marketplace - delete directory
            await fsPromises.rm(marketplaceSkillPath, {
              recursive: true,
              force: true,
            });

            // Also remove from marketplaces.json config
            try {
              await marketplaceService.removeInstalledSkillRecords(
                bootstrap.PROJECT_ROOT,
                { identities: [{ marketplaceId: mp.name, skillId: skillName }] },
              );
            } catch (configError) {
              console.log(
                `[IPC] Could not update marketplace config: ${configError.message}`,
              );
            }

            console.log(
              `[IPC] Deleted marketplace skill: ${skillName} from ${mp.name}`,
            );
            return { success: true };
          } catch (e) {
            // Not in this marketplace, continue checking
          }
        }
      } catch (e) {
        // Marketplace directory doesn't exist
      }

      return { success: false, error: `Skill "${skillName}" not found` };
    } catch (error) {
      console.error(`[IPC] delete-skill error:`, error);
      return { success: false, error: error.message };
    }
  });
}

// ============================================================================
// WINDOW HANDLERS
// ============================================================================

function registerWindowHandlers() {
  // Toggle window maximize
  ipcMain.handle("toggle-maximize", () => {
    const window = BrowserWindow.getFocusedWindow();
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    }
    return { success: true };
  });

  ipcMain.handle("set-mac-traffic-light-position", (_event, position = {}) => {
    return windows.setMacTrafficLightPosition(position);
  });

  ipcMain.handle("window-is-full-screen", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window && !window.isDestroyed() && window.isFullScreen());
  });

  // Check if first run
  ipcMain.handle("is-first-run", async () => {
    if (dependencies.isFirstRun) {
      return await dependencies.isFirstRun();
    }
    return false;
  });

  // Open chat window
  ipcMain.handle("open-chat", () => {
    if (dependencies.createChatWindow) {
      dependencies.createChatWindow();
    }
    return { success: true };
  });

  // Detached runtime configuration modals cannot create tabs themselves.
  // Route their explicit request to the main renderer and wait for its tab-cap
  // aware acknowledgement before reporting success to the originating modal.
  ipcMain.handle("request-open-new-chat-tab", async (_event, options = {}) => {
    const mainWindow = getUsableBrowserWindow(state.windows.main);
    if (!mainWindow) {
      return { success: false, error: "The main chat window is unavailable." };
    }

    const requestId = `new-chat-${Date.now()}-${++newChatTabRequestSequence}`;
    const normalizedOptions = normalizeNewChatTabOptions(options);

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        settleNewChatTabRequest(requestId, {
          success: false,
          error: "Timed out while opening the new chat tab.",
        });
      }, NEW_CHAT_TAB_REQUEST_TIMEOUT_MS);
      pendingNewChatTabRequests.set(requestId, { resolve, timeout });

      const delivered = safeWebContentsSend(
        mainWindow,
        "open-new-chat-tab",
        { requestId, options: normalizedOptions },
        { tag: "request-open-new-chat-tab" },
      );
      if (!delivered) {
        settleNewChatTabRequest(requestId, {
          success: false,
          error: "Could not reach the main chat window.",
        });
      }
    });
    if (result?.success) {
      revealBrowserWindow(mainWindow);
    }
    return result;
  });

  ipcMain.on("complete-open-new-chat-tab-request", (event, result = {}) => {
    const requestId =
      typeof result?.requestId === "string" ? result.requestId.trim() : "";
    const mainWindow = getUsableBrowserWindow(state.windows.main);
    if (
      !requestId ||
      !mainWindow ||
      event.sender.id !== mainWindow.webContents.id
    ) {
      return;
    }
    const opened = result.opened === true;
    settleNewChatTabRequest(requestId, {
      success: opened,
      error: opened
        ? null
        : String(result.error || "Could not open a new chat tab."),
    });
  });

  ipcMain.handle("set-loading-window-logs-drawer-open", async (_event, open) => {
    try {
      const resized = windows.setLoadingWindowLogsDrawerOpen(Boolean(open));
      return { success: true, resized };
    } catch (error) {
      console.error("[IPC] Failed to resize loading window for logs drawer:", error);
      return { success: false, error: error.message };
    }
  });

  // Detach conversation tab to a new window
  ipcMain.handle(
    "conversation-detach",
    async (_event, { conversationId, url, title, windowType, viewKey, x, y }) => {
      if (!conversationId || !url) {
        return { success: false, error: "Missing conversationId or url" };
      }

      return createConversationWindow({
        conversationId,
        url,
        title,
        windowType,
        viewKey,
        x,
        y,
      });
    },
  );

  // Focus an existing detached conversation window if one is open (used by the
  // Cost Dashboard to open tab-first without double-opening a chat that's
  // already a window). Returns { focused: boolean }.
  ipcMain.handle(
    "conversation-window-focus-if-open",
    (_event, { conversationId } = {}) => ({
      focused: focusConversationWindowIfOpen(conversationId) === true,
    }),
  );

  ipcMain.handle("conversation-attach", async (event, payload = {}) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return attachConversationToMainWindow(payload, {
      senderWindow,
      closeSender: true,
    });
  });

  ipcMain.handle("detached-conversation-set-title", (event, title) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { success: false, error: "Detached window not found" };
    }
    return setDetachedConversationWindowTitle(senderWindow.id, title);
  });

  // Launch guided setup from control panel
  ipcMain.handle("launch-electron-app", () => {
    // Close the main window when opening guided setup
    closeMainWindow({ force: true });
    if (dependencies.createGuidedSetupWindow) {
      dependencies.createGuidedSetupWindow({
        source: "manual",
        trigger: "control-plane",
        setupMode: "manual",
      });
    }
    return { success: true };
  });

  // Launch guided setup from init failure screen
  ipcMain.on("launch-electron-app-from-init", (_event, requestedContext = {}) => {
    console.log("[Main] Launching guided setup from init failure screen");
    // This is a terminal handoff: start-initialization will never run for this
    // bring-up, so its finally block can never release a lease docker-start or
    // docker-restart is still holding. Release here or guided setup's own
    // mutations (write-env-file, toggles, config generation) all fail busy.
    state.releasePendingMcpRuntimeMutation("guided-setup-handoff");
    // Close the loading window when opening guided setup
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.close();
    }
    if (dependencies.createGuidedSetupWindow) {
      dependencies.createGuidedSetupWindow({
        source: "required",
        trigger: "init-failure",
        setupMode:
          requestedContext?.setupMode === "full" ||
          requestedContext?.setupMode === "runtime_repair" ||
          requestedContext?.setupMode === "identity_repair"
            ? requestedContext.setupMode
            : null,
        setupReason:
          typeof requestedContext?.setupReason === "string"
            ? requestedContext.setupReason
            : null,
        setupRequirementId:
          typeof requestedContext?.setupRequirementId === "string"
            ? requestedContext.setupRequirementId
            : null,
        safeErrorCode:
          typeof requestedContext?.safeErrorCode === "string"
            ? requestedContext.safeErrorCode
            : null,
        setupOperationId:
          typeof requestedContext?.setupOperationId === "string"
            ? requestedContext.setupOperationId
            : null,
        seedDefaults: requestedContext?.seedDefaults === true,
      });
    }
  });

  // For chat window
  ipcMain.on("show-config", () => {
    if (state.windows.main) {
      state.windows.main.webContents.send("show-config");
    }
  });

  ipcMain.on("open-manager", () => {
    if (state.windows.main) {
      state.windows.main.focus();
    }
  });
}

function registerOwuiHandlers() {
  owuiViews.setChatRuntimeTransitionListener?.(
    ({ chatId, previousState, nextState, payload = {} }) => {
      if (previousState?.busy === true && nextState?.busy !== true) {
        getChatNativeNotificationService().show({
          type: "completed",
          chatId,
          chatTitle:
            typeof payload?.title === "string" && payload.title.trim()
              ? payload.title.trim()
              : "New Chat",
          modelIdentity:
            payload?.modelIdentity && typeof payload.modelIdentity === "object"
              ? payload.modelIdentity
              : null,
        });
      }
    },
  );

  ipcMain.handle("show-chat-native-notification", (_event, payload = {}) =>
    getChatNativeNotificationService().show(payload),
  );

  ipcMain.handle("owui-create-or-adopt-view", async (event, options = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: "Owui host window not available" };
    }

    try {
      const state = await owuiViews.createOrAdoptView(options, ownerWindow.id);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to create/adopt view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-destroy-view", (_event, payload = {}) => {
    try {
      const viewKey = typeof payload === "string" ? payload : payload.viewKey;
      const expectedWebContentsId =
        typeof payload === "string" ? undefined : payload.expectedWebContentsId;
      return {
        success: true,
        destroyed: owuiViews.destroyView(viewKey, expectedWebContentsId),
      };
    } catch (error) {
      console.error("[OWUI] Failed to destroy view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-recreate-view", async (_event, { viewKey, url } = {}) => {
    try {
      const state = await owuiViews.recreateView(viewKey, url);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to recreate view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-set-bounds", (_event, { viewKey, bounds } = {}) => {
    try {
      const state = owuiViews.setBounds(viewKey, bounds);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to set bounds:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-set-visible", (_event, { viewKey, visible } = {}) => {
    try {
      const state = owuiViews.setVisible(viewKey, visible);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to set visibility:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-load-url", async (_event, { viewKey, url } = {}) => {
    try {
      const state = await owuiViews.loadUrl(viewKey, url);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to load URL:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-reload-view", async (_event, viewKey) => {
    try {
      const state = await owuiViews.reloadView(viewKey);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to reload view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-execute-javascript", async (_event, { viewKey, script } = {}) => {
    try {
      const result = await owuiViews.executeJavaScript(viewKey, script);
      return { success: true, result };
    } catch (error) {
      console.error("[OWUI] Failed to execute JavaScript:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-insert-css", async (_event, { viewKey, css } = {}) => {
    try {
      const key = await owuiViews.insertCss(viewKey, css);
      return { success: true, key };
    } catch (error) {
      console.error("[OWUI] Failed to insert CSS:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-send-artifacts-update", async (_event, { viewKey, detail } = {}) => {
    try {
      const state = await owuiViews.sendArtifactsUpdate(viewKey, detail);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to send artifacts update:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-broadcast-owner-event", async (event, { channel, payload } = {}) => {
    try {
      if (!channel || typeof channel !== "string") {
        throw new Error("Missing OWUI owner event channel");
      }
      const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
      if (!ownerWindowId) {
        throw new Error("Unable to resolve owner window");
      }
      owuiViews.broadcastToOwnerViews(ownerWindowId, channel, payload);
      return { success: true };
    } catch (error) {
      console.error("[OWUI] Failed to broadcast owner-scoped event:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-set-debug-mode", async (_event, enabled = false) => {
    try {
      const normalized = Boolean(enabled);
      globalOwuiDebugModeEnabled = normalized;
      broadcastOwuiDebugModeChanged(normalized);
      return { success: true, enabled: normalized };
    } catch (error) {
      console.error("[OWUI] Failed to set global debug mode:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-get-debug-mode", async () => {
    try {
      return {
        success: true,
        enabled: Boolean(globalOwuiDebugModeEnabled),
      };
    } catch (error) {
      console.error("[OWUI] Failed to get global debug mode:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-get-debug-monitor-access", async () => {
    try {
      if (!globalOwuiDebugModeEnabled) {
        throw new Error("OWUI debug mode is disabled");
      }
      return {
        success: true,
        ...bootstrap.getDebugMonitorAccess(),
      };
    } catch (error) {
      console.error("[OWUI] Failed to get debug monitor access:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("konami-get-state", async (event, options = {}) => {
    try {
      const previousUnlocked = Boolean(state.appState.konamiUnlocked);
      const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
      const senderWebContentsId = event.sender?.id ?? null;
      const { unlocked, flagPath, mirrorPath } = syncAndReadKonamiUnlocked();
      let immediate = false;
      let error = null;

      logKonamiMain("Main", "info", "Received Konami state request", {
        phase: "get-state",
        ownerWindowId,
        senderWebContentsId,
        viewKey: options?.viewKey || null,
        previousUnlocked,
        unlocked,
        flagPath,
        mirrorPath,
      });

      if (unlocked) {
        try {
          await attemptKonamiOwuiUnlock({
            ownerWindowId,
            preferredViewKey: options?.viewKey,
          }, {
            attempts: 1,
          }, {
            suppressStartupTransientWarnings: true,
          });
          immediate = true;
        } catch (reconcileError) {
          const failure = resolveKonamiStartupHydrationFailure(reconcileError);
          if (failure.transient) {
            logKonamiMain("Main", "info", "Deferred persisted Konami reconcile until OWUI is ready", {
              phase: "get-state",
              ownerWindowId,
              senderWebContentsId,
              viewKey: options?.viewKey || null,
              code: failure.code,
              status: failure.status,
              message: failure.message,
            });
          } else {
            error = failure.surfacedError;
            console.warn("[Konami] Failed to reconcile unlocked state immediately:", error);
          }
        }

        if (!previousUnlocked || immediate) {
          broadcastKonamiUnlockChanged(true);
        }
      } else if (previousUnlocked) {
        broadcastKonamiUnlockChanged(false);
      }

      logKonamiMain("Main", "info", "Completed Konami state request", {
        phase: "get-state",
        ownerWindowId,
        senderWebContentsId,
        viewKey: options?.viewKey || null,
        previousUnlocked,
        unlocked,
        immediate,
        error,
        flagPath,
        mirrorPath,
      });

      return {
        success: true,
        unlocked,
        immediate,
        error,
      };
    } catch (error) {
      logKonamiMain("Main", "error", "Konami state request failed", {
        phase: "get-state",
        error: normalizeKonamiError(error),
      });
      console.error("[Konami] Failed to get unlock state:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("konami-unlock", async (event, options = {}) => {
    let flagPath = "";
    let desiredStatePersisted = false;

    try {
      const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
      const senderWebContentsId = event.sender?.id ?? null;
      const context = getKonamiRuntimeContext();
      const beforePaths = getKonamiPathMetadata(context);
      const { unlocked: existingUnlocked } = syncAndReadKonamiUnlocked();

      logKonamiMain("Main", "info", "Received Konami unlock request", {
        phase: "unlock-request",
        ownerWindowId,
        senderWebContentsId,
        viewKey: options?.viewKey || null,
        existingUnlocked,
        flagPath: beforePaths.flagPath,
        mirrorPath: beforePaths.mirrorPath,
        flagExistsBefore: beforePaths.flagExists,
        mirrorExistsBefore: beforePaths.mirrorExists,
      });

      if (existingUnlocked) {
        let immediate = false;
        let error = null;

        try {
          await attemptKonamiOwuiUnlock({
            ownerWindowId,
            preferredViewKey: options?.viewKey,
          });
          immediate = true;
          broadcastKonamiUnlockChanged(true);
        } catch (reconcileError) {
          error = reconcileError?.message || String(reconcileError);
          console.warn("[Konami] Failed to reconcile persisted unlock immediately:", error);
        }

        logKonamiMain("Main", "info", "Completed Konami unlock request for already-unlocked install", {
          phase: "unlock-result",
          ownerWindowId,
          senderWebContentsId,
          viewKey: options?.viewKey || null,
          existingUnlocked,
          immediate,
          error,
          flagPath: getKonamiFlagPath(context.userDataPath),
          mirrorPath: beforePaths.mirrorPath,
        });

        return {
          success: immediate,
          unlocked: true,
          immediate,
          alreadyUnlocked: true,
          path: getKonamiFlagPath(context.userDataPath),
          error,
        };
      }

      const persisted = persistKonamiDesiredState(context);
      flagPath = persisted.flagPath;
      desiredStatePersisted = true;
      state.appState.konamiUnlocked = true;
      const afterPaths = getKonamiPathMetadata(context);

      logKonamiMain("Main", "info", "Persisted Konami unlock flag before immediate OWUI reconcile", {
        phase: "persist-unlock",
        ownerWindowId,
        senderWebContentsId,
        viewKey: options?.viewKey || null,
        flagPath,
        mirrorPath: persisted.mirrorPath || afterPaths.mirrorPath,
        flagExistsAfter: afterPaths.flagExists,
        mirrorExistsAfter: afterPaths.mirrorExists,
      });

      let result;
      try {
        result = await attemptKonamiOwuiUnlock({
          ownerWindowId,
          preferredViewKey: options?.viewKey,
        });
      } catch (reconcileError) {
        const error = reconcileError?.message || String(reconcileError);
        logKonamiMain("Main", "warn", "Persisted Konami unlock is pending OWUI repair", {
          phase: "unlock-repair-pending",
          ownerWindowId,
          senderWebContentsId,
          viewKey: options?.viewKey || null,
          flagPath,
          mirrorPath: persisted.mirrorPath || afterPaths.mirrorPath,
          error,
        });
        broadcastKonamiUnlockChanged(true);
        return {
          success: false,
          unlocked: true,
          immediate: false,
          alreadyUnlocked: false,
          repairPending: true,
          path: flagPath,
          error,
        };
      }

      broadcastKonamiUnlockChanged(true);

      logKonamiMain("Main", "info", "Completed Konami unlock request successfully", {
        phase: "unlock-result",
        ownerWindowId,
        senderWebContentsId,
        viewKey: options?.viewKey || null,
        existingUnlocked: false,
        immediate: true,
        modelId: result?.modelId || KONAMI_UNLOCK_MODEL_ID,
        flagPath,
        mirrorPath: afterPaths.mirrorPath,
      });

      return {
        success: true,
        unlocked: true,
        immediate: true,
        alreadyUnlocked: false,
        repairPending: false,
        path: flagPath,
        modelId: result?.modelId || KONAMI_UNLOCK_MODEL_ID,
        viewKey: result?.viewKey || options?.viewKey || null,
      };
    } catch (error) {
      state.appState.konamiUnlocked = desiredStatePersisted;
      logKonamiMain("Main", "error", "Konami unlock request failed", {
        phase: "unlock-result",
        flagPath,
        desiredStatePersisted,
        rollbackError: error?.rollbackError || null,
        error: normalizeKonamiError(error),
      });
      console.error("[Konami] Failed to unlock GPT-5.6 Sol Pro:", error);
      return {
        success: false,
        unlocked: desiredStatePersisted,
        immediate: false,
        alreadyUnlocked: false,
        repairPending: desiredStatePersisted,
        path: flagPath,
        error: error.message,
      };
    }
  });

  ipcMain.handle("owui-set-theme", async (_event, { viewKey, theme } = {}) => {
    try {
      const state = await owuiViews.setTheme(viewKey, theme);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to set theme:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-get-view-state", (_event, viewKey) => {
    try {
      return { success: true, state: owuiViews.getViewState(viewKey) };
    } catch (error) {
      console.error("[OWUI] Failed to read view state:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-list-views", () => {
    try {
      return { success: true, views: owuiViews.listViews() };
    } catch (error) {
      console.error("[OWUI] Failed to list views:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-open-debug-request-modal", async (event, payload = {}) => {
    try {
      const forwarded = owuiViews.sendToOwnerWindowForContents(
        event.sender,
        "owui-debug-request-modal",
        payload,
      );
      if (!forwarded) {
        throw new Error("Unable to forward debug request modal event to owner window");
      }
      return { success: true };
    } catch (error) {
      console.error("[OWUI] Failed to open debug request modal:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-open-debug-monitor-link", async (_event, payload = {}) => {
    try {
      const url = typeof payload?.url === "string" ? payload.url.trim() : "";
      if (!url) {
        throw new Error("Missing debug monitor URL");
      }
      await shell.openExternal(bootstrap.buildDebugMonitorUrl(url));
      return { success: true };
    } catch (error) {
      console.error("[OWUI] Failed to open debug monitor link:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-focus-view", async (_event, viewKey) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(_event.sender);
      const currentState = owuiViews.getViewState(viewKey);
      if (!currentState) {
        return { success: true, state: null, skipped: "view-not-ready" };
      }
      if (!ownerWindow || ownerWindow.isDestroyed() || !ownerWindow.isFocused()) {
        return { success: true, state: currentState, skipped: "window-not-focused" };
      }
      const state = await owuiViews.focusView(viewKey);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to focus view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-capture-page", async (_event, viewKey) => {
    try {
      const image = await owuiViews.capturePage(viewKey);
      return {
        success: true,
        png: image.toPNG().toString("base64"),
      };
    } catch (error) {
      console.error("[OWUI] Failed to capture page:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-send-input-event", async (_event, { viewKey, input } = {}) => {
    try {
      const state = await owuiViews.sendInputEvent(viewKey, input);
      return { success: true, state };
    } catch (error) {
      console.error("[OWUI] Failed to send input event:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp-tooltip-show', async (_event, payload = {}) => {
    try {
      const shown = await showMcpTooltip(payload);
      return { success: true, shown };
    } catch (error) {
      console.error('[MCP Tooltip] Failed to show:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp-tooltip-hide', () => {
    try {
      hideMcpTooltip();
      return { success: true };
    } catch (error) {
      console.error('[MCP Tooltip] Failed to hide:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-prep-tooltip-show', async (_event, payload = {}) => {
    try {
      const shown = await showUpdatePrepTooltip(payload);
      return { success: true, shown };
    } catch (error) {
      console.error('[Update Prep Tooltip] Failed to show:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-prep-tooltip-hide', () => {
    try {
      hideUpdatePrepTooltip();
      return { success: true };
    } catch (error) {
      console.error('[Update Prep Tooltip] Failed to hide:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('artifact-version-menu-show', async (event, payload = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: 'Artifact version menu owner window not available' };
    }

    try {
      const shown = await showArtifactVersionMenu(payload, ownerWindow);
      return { success: true, shown };
    } catch (error) {
      console.error('[Artifacts] Failed to show artifact version menu:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('artifact-version-menu-hide', (_event, payload = {}) => {
    try {
      hideArtifactVersionMenu(payload);
      return { success: true };
    } catch (error) {
      console.error('[Artifacts] Failed to hide artifact version menu:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('artifact-version-menu-select', (event, payload = {}) => {
    const menuWindow = BrowserWindow.fromWebContents(event.sender);
    if (!menuWindow || state.windows.artifactVersionMenu?.id !== menuWindow.id) {
      return;
    }

    const ownerWindow = menuWindow.getParentWindow();
    const version = Number(payload.version);
    if (ownerWindow && !ownerWindow.isDestroyed() && Number.isFinite(version)) {
      safeWebContentsSend(ownerWindow, 'artifact-version-menu-event', {
        type: 'select',
        version,
      }, {
        tag: 'artifact-version-menu-select',
        meta: { ownerWindowId: ownerWindow.id, version },
      });
    }

    hideArtifactVersionMenu({ notifyOwner: false, reason: 'selection' });
  });

  ipcMain.on('artifact-version-menu-close', (event, payload = {}) => {
    const menuWindow = BrowserWindow.fromWebContents(event.sender);
    if (!menuWindow || state.windows.artifactVersionMenu?.id !== menuWindow.id) {
      return;
    }

    hideArtifactVersionMenu({
      notifyOwner: true,
      reason: payload.reason || 'dismiss',
    });
  });

  ipcMain.handle('artifact-divider-overlay-sync', async (event, payload = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: 'Artifact divider overlay owner window not available' };
    }

    try {
      const state = await syncArtifactDividerOverlay(payload, ownerWindow);
      return { success: true, state };
    } catch (error) {
      console.error('[Artifacts] Failed to sync artifact divider overlay:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('artifact-divider-overlay-hide', (_event, payload = {}) => {
    try {
      hideArtifactDividerOverlay(payload);
      return { success: true };
    } catch (error) {
      console.error('[Artifacts] Failed to hide artifact divider overlay:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('local-find-overlay-sync', async (event, payload = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: 'Local find overlay owner window not available' };
    }

    try {
      const state = await syncLocalFindOverlay(payload, ownerWindow);
      return { success: true, state };
    } catch (error) {
      console.error('[Local Find] Failed to sync overlay:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('local-find-overlay-window-event', (event, payload = {}) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    const ownerWindow = getLocalFindOverlayOwnerWindow(overlayWindow);
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      try {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        overlayWindow.destroy();
      } catch (_error) {
        // best-effort cleanup for orphaned overlays
      }
      return;
    }

    const type = String(payload?.type || '');
    const handledInMain =
      type === 'query-change' ||
      type === 'toggle-case' ||
      type === 'next' ||
      type === 'prev' ||
      type === 'release-focus' ||
      type === 'close';

    let forwardedPayload = payload;
    if (handledInMain) {
      handleLocalFindOverlayFallbackEvent(ownerWindow, payload);
      if (type === 'release-focus') {
        // PORTICO PATCH: only rewrite overlay blur as a 'close' (which the
        // find-bar treats as full dismiss) when the focus moved to something
        // INSIDE our app. When focus left to another app entirely (Cmd+Tab,
        // click on another window), the overlay blurs as a side effect and
        // we must NOT close the find bar — doing so swallows the user's
        // first click/keypress and competes with the OS-level focus
        // transfer. Pair this with the matching guard inside
        // handleLocalFindOverlayFallbackEvent.
        const ownerStillFocused =
          ownerWindow && !ownerWindow.isDestroyed() && ownerWindow.isFocused();
        if (ownerStillFocused) {
          forwardedPayload = {
            type: 'close',
            reason: payload?.reason || 'overlay-blur',
          };
        }
        // else: leave forwardedPayload as the original 'release-focus', which
        // find-bar treats as _setRetainFocus(false) — find bar stays open.
      }
    }

    const delivered = safeWebContentsSend(
      ownerWindow,
      'local-find-overlay-event',
      handledInMain ? { ...forwardedPayload, handledInMain: true } : payload,
      {
      tag: 'local-find-overlay-window-event',
      meta: {
        ownerWindowId: ownerWindow.id,
        overlayWindowId: overlayWindow.id,
        type: payload?.type || 'unknown',
      },
      },
    );

    if (!delivered && !handledInMain) {
      handleLocalFindOverlayFallbackEvent(ownerWindow, payload);
    }
  });

  ipcMain.on('artifact-divider-overlay-drag-start', (event, payload = {}) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    beginArtifactDividerDrag(payload);
  });

  ipcMain.on('artifact-divider-overlay-drag-move', (event, payload = {}) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    updateArtifactDividerDrag(payload);
  });

  ipcMain.on('artifact-divider-overlay-drag-end', (event, payload = {}) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    finishArtifactDividerDrag(payload);
  });

  ipcMain.on('artifact-divider-overlay-drag-cancel', (event, payload = {}) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    finishArtifactDividerDrag(payload, { cancelled: true, reason: payload.reason || 'cancelled' });
  });

  ipcMain.on('artifact-divider-overlay-hover-start', (event) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    forwardArtifactDividerOverlayHover({ type: 'hover-start' });
  });

  ipcMain.on('artifact-divider-overlay-hover-end', (event) => {
    const overlayWindow = BrowserWindow.fromWebContents(event.sender);
    if (!overlayWindow || state.windows.artifactDividerOverlay?.id !== overlayWindow.id) {
      return;
    }

    forwardArtifactDividerOverlayHover({ type: 'hover-end' });
  });

  ipcMain.on("owui-artifact-action", (event, payload) => {
    if (!owuiViews.forwardArtifactAction(event.sender, payload)) {
      console.warn("[OWUI] Dropped artifact action from unknown sender");
    }
  });

  ipcMain.on("owui-tab-activity", (event, payload = {}) => {
    const viewKey = owuiViews.getViewKeyForContents(event.sender);
    if (!viewKey) {
      return;
    }

    owuiViews.updateChatActivityForContents(event.sender, payload);

    // A later activity report carries the real (auto-generated) chat title once
    // OWUI finishes title generation — fire any completion notification we
    // deferred at busy→idle because the title was still the placeholder.
    if (typeof payload?.chatId === "string" && typeof payload?.title === "string") {
      getChatNativeNotificationService().resolveTitle(payload.chatId, payload.title);
    }

    owuiViews.emitEventForView(viewKey, "tab-activity-changed", {
      busy: payload?.busy === true,
      phase: typeof payload?.phase === "string" ? payload.phase : "idle",
      chatId: typeof payload?.chatId === "string" ? payload.chatId : "",
      // Multi-chat tiling: shell artifact routing goes windowed-only for
      // tabs whose OWUI view reports an active tiled layout.
      multiChat: payload?.multiChat === true,
      // Model shown on the tab: the chat's currently selected model (incl.
      // base-model fields for agents) — drives the tab-strip model logos.
      // Already normalized by the webview preload.
      modelIdentity:
        payload?.modelIdentity && typeof payload.modelIdentity === "object"
          ? payload.modelIdentity
          : null,
    });
  });

  ipcMain.handle("owui-get-chat-activity-snapshot", (event) => {
    const snapshot = owuiViews.getChatActivitySnapshotForContents(event.sender);
    if (!snapshot) {
      return { success: false, error: "Unknown OWUI sender" };
    }
    return { success: true, data: snapshot };
  });

  ipcMain.handle("owui-get-native-input-presentation-snapshot", (event) => {
    const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
    if (!ownerWindowId) {
      return { success: false, error: "Unknown OWUI sender" };
    }
    return {
      success: true,
      data: state.buildNativeInputPresentationSnapshot(ownerWindowId),
    };
  });

  ipcMain.handle("owui-reopen-native-input", (event, payload = {}) => {
    const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
    const chatId = typeof payload?.chat_id === "string" ? payload.chat_id.trim() : "";
    const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
    const entry = kind && flowId ? state.getNativeInputFlow(kind, flowId) : null;
    // Chat-scoped flows may only be reopened from their own chat. Flows with
    // no chat binding (marketplace_publish — the Rust proxy carries no chat
    // id) reopen from any chat in the owning window.
    const chatScoped = Boolean(entry?.chatId);
    if (
      !ownerWindowId ||
      !entry ||
      entry.status !== "in_progress" ||
      entry.presentation !== "hidden" ||
      (chatScoped && (!chatId || entry.chatId !== chatId)) ||
      Number(entry.ownerWindowId) !== Number(ownerWindowId)
    ) {
      return { success: false, error: "Native-input flow is unavailable for this window" };
    }

    const ownerWindow = BrowserWindow.fromId(Number(ownerWindowId));
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: "Input window is no longer available" };
    }

    state.setNativeInputFlowPresentation(kind, flowId, "visible", ownerWindowId);
    ownerWindow.webContents.send("native-input-reopen-requested", {
      kind,
      flow_id: flowId,
      chat_id: entry.chatId,
    });
    const snapshot = state.buildNativeInputPresentationSnapshot(ownerWindowId);
    try {
      broadcastNativeInputPresentationSnapshot(ownerWindowId);
    } catch (error) {
      // The presentation state has already changed. A stale secondary OWUI view
      // must not turn that successful action into a rejected IPC call.
      console.warn("[IPC] Failed to broadcast reopened native-input snapshot:", error);
    }
    return { success: true, data: snapshot };
  });

  // Answer a question from the chat transcript. The sender must be an OWUI
  // view of the flow's owner window AND be showing the
  // chat that owns the flow, so one chat can never answer another's question.
  ipcMain.handle("owui-submit-user-question", (event, payload = {}) => {
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id.trim() : "";
    const chatId = typeof payload?.chat_id === "string" ? payload.chat_id.trim() : "";
    const ownerWindowId = resolveOwuiOwnerWindowIdFromSender(event.sender);
    const entry = flowId ? state.userQuestionFlowResults.get(flowId) : null;
    if (
      !ownerWindowId ||
      !entry ||
      entry.status !== "in_progress" ||
      !chatId ||
      entry.chatId !== chatId ||
      Number(entry.ownerWindowId) !== Number(ownerWindowId)
    ) {
      return { success: false, error: "User-question flow is unavailable for this window" };
    }

    let result;
    try {
      if (payload.action === "submitted") {
        result = buildUserQuestionSubmittedResult(entry, payload.answers);
      } else if (payload.action === "dismissed") {
        result = buildUserQuestionDismissedResult(entry);
      } else {
        result = buildUserQuestionErrorResult(
          entry,
          `Unknown user-question completion action: ${payload.action || "missing"}`,
        );
      }
    } catch (error) {
      console.error(`[User Question] Inline completion failed for ${flowId}:`, error);
      return {
        success: false,
        error: error?.message || "Failed to process answers",
      };
    }

    state.completeUserQuestionFlow(flowId, result);
    notifyNativeInputTerminal(
      ownerWindowId,
      state.NATIVE_INPUT_FLOW_KINDS.USER_QUESTION,
      flowId,
      result.status,
    );
    broadcastNativeInputPresentationSnapshot(ownerWindowId);
    return { success: true };
  });

  ipcMain.handle("owui-reconcile-chat-runtime", (event, payload = {}) => {
    const snapshot = owuiViews.reconcileChatRuntimeForContents(
      event.sender,
      payload,
    );
    if (!snapshot) {
      return { success: false, error: "Unknown OWUI sender" };
    }
    return { success: true, data: snapshot };
  });

  ipcMain.handle("owui-acknowledge-chat-runtime", (event, chatId = "") => {
    const snapshot = owuiViews.acknowledgeChatRuntimeForContents(
      event.sender,
      chatId,
    );
    if (!snapshot) {
      return { success: false, error: "Unknown OWUI sender" };
    }
    return { success: true, data: snapshot };
  });

  ipcMain.handle("focus-renderer", (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed() && win.isFocused()) {
        win.webContents.focus();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("show-tab-context-menu", (event, payload = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: "Tab context menu window not available" };
      }

      const fullTabId =
        typeof payload?.fullTabId === "string" ? payload.fullTabId.trim() : "";
      if (!fullTabId) {
        return { success: false, error: "Missing tab context menu target" };
      }

      const x = Number(payload?.x);
      const y = Number(payload?.y);
      const menuSections = [
        [
          payload?.canRename === true
            ? { label: "Rename Tab", action: "rename" }
            : null,
        ],
        [
          payload?.canClose === true
            ? { label: "Close Tab", action: "close" }
            : null,
          payload?.canCloseOthers === true
            ? { label: "Close Other Tabs", action: "close-others" }
            : null,
          payload?.canCloseRight === true
            ? { label: "Close Tabs to the Right", action: "close-right" }
            : null,
        ],
        [
          payload?.canDetach === true
            ? { label: "Detach to Window", action: "detach" }
            : null,
        ],
      ]
        .map((section) => section.filter(Boolean))
        .filter((section) => section.length > 0);

      const template = [];
      const appendAction = (item) => {
        template.push({
          label: item.label,
          click: () => {
            try {
              win.webContents.send("tab-context-menu-command", {
                action: item.action,
                fullTabId,
              });
            } catch (error) {
              console.warn(
                "[Tabs] Failed to dispatch tab context menu command:",
                error.message,
              );
            }
          },
        });
      };

      for (const [sectionIndex, section] of menuSections.entries()) {
        if (sectionIndex > 0) {
          template.push({ type: "separator" });
        }
        section.forEach(appendAction);
      }

      if (template.length === 0) {
        template.push({
          label: "No Available Actions",
          enabled: false,
        });
      }

      const menu = Menu.buildFromTemplate(template);
      const popupOptions = { window: win };
      if (Number.isFinite(x) && Number.isFinite(y)) {
        popupOptions.x = Math.max(0, Math.round(x));
        popupOptions.y = Math.max(0, Math.round(y));
      }
      menu.popup(popupOptions);
      return { success: true };
    } catch (error) {
      console.error("[Tabs] Failed to show tab context menu:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-find-in-page", (event, text, options = {}) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { success: false, error: "Owui find requested without an owning window" };
      }
      const windowId = ownerWindow.id;
      owuiViews.findInPage(text, options, windowId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("owui-stop-find-in-page", (event, action) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { success: false, error: "Owui stop-find requested without an owning window" };
      }
      const windowId = ownerWindow.id;
      owuiViews.stopFindInPage(action, windowId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // PORTICO PATCH: receive Highlight-API local-find updates from OWUI preload
  // (see chat-webview-preload.js portico-portico-local-find-update bridge) and
  // forward them to the owning shell window's find-bar through the existing
  // found-in-page-result channel — same shape as Chromium's native event so
  // find-bar.js does not need to know which engine produced the result.
  ipcMain.on("owui-portico-local-find-update", (event, payload) => {
    try {
      owuiViews.deliverHighlightUpdateForContents(event.sender, payload || {});
    } catch (error) {
      console.warn(
        "[IPC] Failed to forward local-find update:",
        error?.message || error,
      );
    }
  });

  ipcMain.handle("get-open-conversation-tabs", () => {
    try {
      return owuiViews.getOpenConversationTabs();
    } catch (error) {
      return [];
    }
  });

  ipcMain.handle("navigate-to-conversation-window", (event, chatId, messageId, options = {}) => {
    try {
      return activateChatConversation({
        chatId,
        messageId,
        title: options?.title,
        preferredWindow: BrowserWindow.fromWebContents(event.sender),
      });
    } catch (error) {
      return { found: false, error: error.message };
    }
  });

  ipcMain.handle("owui-setup-find-forwarding", (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      owuiViews.setupFindInPageForwarding(ownerWindow);
    }
    return { success: true };
  });

  ipcMain.on("set-active-view-key", (event, viewKey) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      owuiViews.setActiveViewForWindow(win.id, viewKey);
    }
  });

  ipcMain.on("open-new-chat-tab", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("open-new-chat-tab");
    }
  });

  ipcMain.on("close-active-tab", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("close-active-tab");
    }
  });

  ipcMain.on("switch-to-tab-index", (event, index) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("switch-to-tab-index", index);
    }
  });

  ipcMain.on("switch-tab-next", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("switch-tab-next");
    }
  });

  ipcMain.on("switch-tab-prev", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send("switch-tab-prev");
    }
  });
}

function registerArtifactViewHandlers() {
  ipcMain.handle("artifact-view-create-or-adopt-view", async (event, options = {}) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      return { success: false, error: "Artifact host window not available" };
    }

    try {
      const state = await artifactViews.createOrAdoptView(options, ownerWindow.id);
      return { success: true, state };
    } catch (error) {
      console.error("[Artifacts] Failed to create/adopt native view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-destroy-view", (_event, viewKey) => {
    try {
      return { success: true, destroyed: artifactViews.destroyView(viewKey) };
    } catch (error) {
      console.error("[Artifacts] Failed to destroy native view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-set-bounds", (_event, { viewKey, bounds } = {}) => {
    try {
      const state = artifactViews.setBounds(viewKey, bounds);
      return { success: true, state };
    } catch (error) {
      console.error("[Artifacts] Failed to set native view bounds:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-set-visible", (_event, { viewKey, visible } = {}) => {
    try {
      const state = artifactViews.setVisible(viewKey, visible);
      return { success: true, state };
    } catch (error) {
      console.error("[Artifacts] Failed to set native view visibility:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-load-url", async (_event, { viewKey, url, options = {} } = {}) => {
    try {
      const state = await artifactViews.loadUrl(viewKey, url, options);
      return { success: true, state };
    } catch (error) {
      console.error("[Artifacts] Failed to load native view URL:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-reload-view", async (_event, viewKey) => {
    try {
      const state = await artifactViews.reloadView(viewKey);
      return { success: true, state };
    } catch (error) {
      console.error("[Artifacts] Failed to reload native view:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-get-view-state", (_event, viewKey) => {
    try {
      return { success: true, state: artifactViews.getViewState(viewKey) };
    } catch (error) {
      console.error("[Artifacts] Failed to read native view state:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("artifact-view-list-views", () => {
    try {
      return { success: true, views: artifactViews.listViews() };
    } catch (error) {
      console.error("[Artifacts] Failed to list native views:", error);
      return { success: false, error: error.message };
    }
  });
}

// ============================================================================
// PROCESS HANDLERS
// ============================================================================

function registerProcessHandlers() {
  // Stream Docker stop output with colors without exposing a generic shell bridge.
  ipcMain.handle("docker-stop-with-logs", async () => {
    let releaseMutation;
    try {
      releaseMutation = defaultMcpOperationManager.acquireMutationLease({
        kind: "docker_stop_with_logs",
        source: "control_plane",
      });
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.code || "DOCKER_STOP_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    }
    return new Promise((resolve) => {
      const finish = (result) => {
        releaseMutation?.();
        resolve(result);
      };
      const processId = Date.now().toString();
      const enhancedEnv = createEnhancedEnv({ FORCE_COLOR: "1", TERM: "xterm-256color" });
      const child = spawn(
        "bash",
        [path.join(bootstrap.SCRIPTS_DIR, "docker-compose.sh"), "stop"],
        {
        cwd: bootstrap.PROJECT_ROOT,
        env: enhancedEnv,
        },
      );

      let output = "";
      let errorOutput = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        output += text;
        if (state.windows.main && !state.windows.main.isDestroyed()) {
          state.windows.main.webContents.send("log-output", {
            processId,
            data: text,
            type: "stdout",
          });
        }
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        errorOutput += text;
        if (state.windows.main && !state.windows.main.isDestroyed()) {
          state.windows.main.webContents.send("log-output", {
            processId,
            data: text,
            type: "stderr",
          });
        }
      });

      child.on("close", (code) => {
        if (state.windows.main && !state.windows.main.isDestroyed()) {
          state.windows.main.webContents.send("log-complete", {
            processId,
            code,
          });
        }
        finish({
          success: code === 0,
          output,
          error: errorOutput,
          code,
          processId,
        });
      });

      child.on("error", (err) => {
        finish({
          success: false,
          error: err.message,
          processId,
        });
      });
    });
  });

  ipcMain.handle("generate-mcp-config", async (_event, projectRoot) => {
    if (!projectRoot || typeof projectRoot !== "string") {
      return { success: false, error: "projectRoot (string) is required" };
    }

    const normalizedRoot = path.resolve(projectRoot);
    let releaseMutation = null;

    try {
      releaseMutation = await acquireGuidedSetupFinalizeLease({
        kind: "generate_mcp_config",
        source: "guided_setup",
      });
      const generationEnv = createMcpRuntimeEnv({
        PROJECT_ROOT: normalizedRoot,
      });
      const command = await ensureMcpOrcGeneratorCommand(
        normalizedRoot,
        "generate-mcp-config",
        {
          isPackagedApp: app.isPackaged,
          resourcesPath: process.resourcesPath,
          env: generationEnv,
          execAsync: execPromise,
        },
      );
      console.log(
        `[IPC] generate-mcp-config: ${command} (timeout: ${MCP_CONFIG_GENERATION_TIMEOUT_MS}ms)`,
      );

      const { stdout, stderr } = await execPromise(command, {
        cwd: normalizedRoot,
        env: generationEnv,
        timeout: MCP_CONFIG_GENERATION_TIMEOUT_MS,
      });

      console.log("[IPC] generate-mcp-config completed successfully");
      return { success: true, output: stdout, error: stderr };
    } catch (error) {
      const failureDetails = formatProcessFailureDetails(error);
      console.error("[IPC] generate-mcp-config failed:", error.message);
      if (failureDetails) {
        console.error(`[IPC] generate-mcp-config output:\n${failureDetails}`);
      }
      return {
        success: false,
        error: error.message,
        details: failureDetails,
        errorCode: error.code || "GENERATE_MCP_CONFIG_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
      };
    } finally {
      releaseMutation?.();
    }
  });

  // ============================================================================
  // SINGLE-SERVER STACK HANDLERS
  // ============================================================================

  // Start single MCP server for setup wizard testing.
  ipcMain.handle("start-single-mcp-server", async (_event, serverId, options = {}) => {
    let recoveryAttempted = false;
    let lastComposeProbe = null;
    let sessionId = null;
    let sessionEstablished = false;
    let releaseMutation = null;
    try {
      const oauthMode = options?.oauthMode;
      if (oauthMode !== "existing-record" && oauthMode !== "bootstrap") {
        return {
          success: false,
          state: "failed",
          error:
            'startSingleMcpServer requires oauthMode "existing-record" or "bootstrap"',
        };
      }
      if (oauthMode === "existing-record") {
        const preflightIssue = detectToggleEnablePreflightIssue(serverId, {
          projectRoot: bootstrap.PROJECT_ROOT,
          findServerYaml: dockerMcp.findServerYaml,
          parseYaml,
          parseEnvFile: dockerMcp.parseEnvFile,
          checkServerConfigured,
        });
        if (isConfigurationRequiredPreflightIssue(preflightIssue)) {
          const savedSecretUnavailable =
            isSavedSecretUnavailableIssue(preflightIssue);
          const snowflakeSetupPrompt =
            serverId === "snowflake" ? "Help me set up Snowflake" : null;
          console.warn(
            `[IPC] Single-server test skipped for ${serverId} because required configuration is unavailable`,
          );
          return {
            success: false,
            state: "configuration_required",
            errorCode: preflightIssue.errorCode,
            configurationIssue:
              preflightIssue.configurationIssue || "configuration_incomplete",
            requiresConfiguration: true,
            requiresSecretReplacement: savedSecretUnavailable,
            requiredAction: preflightIssue.requiredAction || "configure",
            severity: preflightIssue.severity || "warning",
            error: preflightIssue.error,
            message: preflightIssue.message,
            recoveryPrompt:
              preflightIssue.recoveryPrompt || snowflakeSetupPrompt,
            recoveryLabel:
              preflightIssue.recoveryLabel ||
              (snowflakeSetupPrompt ? "Set up Snowflake in chat" : null),
          };
        }
        if (preflightIssue) {
          return {
            success: false,
            state: "failed",
            errorCode:
              preflightIssue.errorCode || "MCP_CONFIG_PREFLIGHT_FAILED",
            severity: preflightIssue.severity || "error",
            error:
              preflightIssue.error ||
              preflightIssue.message ||
              `Configuration preflight failed for ${serverId}`,
            message:
              preflightIssue.message ||
              preflightIssue.error ||
              `Configuration preflight failed for ${serverId}`,
            stage: preflightIssue.stage || "config_generation",
            source: preflightIssue.source || "config",
            configPath: preflightIssue.configPath || null,
          };
        }
      }

      releaseMutation = await acquireMcpMutationLeaseWithWait(
        {
          kind: "start_single_mcp_server",
          source: "configuration_modal",
        },
        { waitMs: SINGLE_SERVER_LEASE_WAIT_MS },
      );
      if (singleServerSession) {
        return {
          success: false,
          state: "failed",
          error: `A single-server session is already active for ${singleServerSession.serverId}`,
        };
      }

      const scriptPath = path.join(
        bootstrap.PROJECT_ROOT,
        "src/scripts/start-single-mcp-server.sh",
      );
      const singleServerEnv = dockerMcp.createEnhancedEnv();
      const orphanCleanup = await cleanupOrphanedSingleServerStack({
        exec: execPromise,
        projectRoot: bootstrap.PROJECT_ROOT,
        scriptPath,
        requestedServerId: serverId,
        env: singleServerEnv,
      });
      if (orphanCleanup.cleaned) {
        console.warn(
          `[IPC] Removed abandoned single-server stack for ${orphanCleanup.orphanedServerId} before starting ${serverId}`,
        );
      } else if (orphanCleanup.inspectionError) {
        console.warn(
          `[IPC] Could not inspect abandoned single-server stacks before starting ${serverId}: ${orphanCleanup.inspectionError}`,
        );
      }

      sessionId = crypto.randomUUID();
      singleServerSession = {
        sessionId,
        serverId,
        oauthMode,
        state: "starting",
        hostPort: null,
        callbackPort: null,
      };
      console.log(
        `[IPC] Starting single MCP server: ${serverId} (oauthMode=${oauthMode}, session=${sessionId})`,
      );

      // Drop any stale bootstrap session so a failed/abandoned previous attempt
      // can never have its export bearer reused against a different server.
      singleServerBootstrap = null;

      // The single-server OAuth container reaches the host OAuth/secret broker
      // at host.docker.internal:8891. Make sure that broker is up first so we
      // fail fast with a clear reason instead of an opaque container error.
      const bridgeReady = await ensureHostMcpBridgeReady();
      if (!bridgeReady.ready) {
        console.error(
          `[IPC] Host MCP Bridge unavailable for single-server ${serverId}: ${bridgeReady.error}`,
        );
        return { success: false, error: bridgeReady.error };
      }

      const callbackPortReady =
        await ensureSingleServerCallbackPortAvailable();
      if (!callbackPortReady.success) {
        console.error(
          `[IPC] Reserved OAuth callback port unavailable for ${serverId}: ${callbackPortReady.error}`,
        );
        return { success: false, error: callbackPortReady.error };
      }

      const { hostPort, callbackPort } = await allocateSingleServerPorts();
      singleServerSession.hostPort = hostPort;
      singleServerSession.callbackPort = callbackPort;
      console.log(
        `[IPC] Allocated dynamic ports for single stack: host=${hostPort}, callback=${callbackPort}`,
      );

      const oauthBootstrapExportToken =
        oauthMode === "bootstrap"
          ? crypto.randomBytes(32).toString("base64url")
          : "";

      const oauthModeArg =
        oauthMode === "bootstrap" ? " --oauth-bootstrap" : "";
      const startCommand =
        `bash "${scriptPath}" "${serverId}"${oauthModeArg} --host-port ${hostPort} --callback-port ${callbackPort}`;
      const startEnvOverrides =
        oauthMode === "bootstrap"
          ? {
              portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN: oauthBootstrapExportToken,
            }
          : {};
      const runStartAttempt = () =>
        execPromise(startCommand, {
          cwd: bootstrap.PROJECT_ROOT,
          env: dockerMcp.createEnhancedEnv(startEnvOverrides),
          timeout: 120000, // 2 minute timeout
        });

      let startOutput;
      try {
        startOutput = await runStartAttempt();
      } catch (error) {
        const composeFailure = classifyDockerComposeFailure(error);
        if (!composeFailure || singleServerComposeRecoveryAttempted) {
          if (composeFailure) {
            return {
              success: false,
              ...composeFailure,
              recoveryAttempted: singleServerComposeRecoveryAttempted,
            };
          }
          throw error;
        }

        singleServerComposeRecoveryAttempted = true;
        recoveryAttempted = true;
        console.warn(
          `[IPC] Docker Compose unavailable while starting ${serverId}; restarting OrbStack once`,
        );

        const recovery = await dockerMcp.restartOrbStackAndWaitForDocker({
          projectRoot: bootstrap.PROJECT_ROOT,
        });
        if (recovery?.success) {
          lastComposeProbe = await waitForDockerComposeFrontendReady(
            (command) =>
              execPromise(command, {
                cwd: bootstrap.PROJECT_ROOT,
                timeout: 10000,
              }),
            { attempts: 20, delayMs: 1000 },
          );
        }

        if (!recovery?.success || !lastComposeProbe?.available) {
          return {
            success: false,
            ...composeFailure,
            selectedFrontend:
              lastComposeProbe?.selectedFrontend ||
              composeFailure.selectedFrontend,
            probeDiagnostics:
              lastComposeProbe?.probeDiagnostics ||
              composeFailure.probeDiagnostics,
            recoveryAttempted: true,
            recoveryError: recovery?.error || null,
          };
        }

        try {
          startOutput = await runStartAttempt();
        } catch (retryError) {
          const retryComposeFailure = classifyDockerComposeFailure(retryError);
          if (retryComposeFailure) {
            return {
              success: false,
              ...retryComposeFailure,
              recoveryAttempted: true,
            };
          }
          throw retryError;
        }
      }

      const { stdout, stderr } = startOutput;
      singleServerComposeRecoveryAttempted = false;
      const readiness = await waitForSingleServerListeners({
        serverId,
        hostPort,
        callbackPort,
        inspectContainerState: async (readinessServerId) => {
          const containerName = `mcpo-single-${readinessServerId}`;
          try {
            const inspect = await execPromise(
              `docker inspect ${shellQuote(containerName)} --format '{{json .}}'`,
              {
                cwd: bootstrap.PROJECT_ROOT,
                env: dockerMcp.createEnhancedEnv(),
                timeout: 5000,
              },
            );
            const container = JSON.parse(String(inspect.stdout || "{}").trim());
            return {
              found: true,
              status: container?.State?.Status || "unknown",
              running: Boolean(container?.State?.Running),
              restarting: Boolean(container?.State?.Restarting),
              exitCode: container?.State?.ExitCode,
              oomKilled: Boolean(container?.State?.OOMKilled),
              restartCount: Number(container?.RestartCount || 0),
            };
          } catch (error) {
            return {
              found: false,
              error: error?.message || String(error),
            };
          }
        },
        getContainerLogs: async (readinessServerId) => {
          const containerName = `mcpo-single-${readinessServerId}`;
          const logs = await execPromise(
            `docker logs --tail 120 ${shellQuote(containerName)}`,
            {
              cwd: bootstrap.PROJECT_ROOT,
              env: dockerMcp.createEnhancedEnv(),
              timeout: 5000,
            },
          );
          return [logs.stdout, logs.stderr].filter(Boolean).join("\n");
        },
      });
      if (!readiness.ready) {
        console.error(
          `[IPC] Single MCP server listeners failed for ${serverId}: ${readiness.error}`,
        );
        try {
          await execPromise(`bash "${scriptPath}" "${serverId}" --stop`, {
            cwd: bootstrap.PROJECT_ROOT,
            env: dockerMcp.createEnhancedEnv(),
            timeout: 30000,
          });
        } catch (stopError) {
          console.warn(
            `[IPC] Failed to stop single MCP server after listener failure for ${serverId}: ${stopError.message}`,
          );
        }
        const startupClassification = classifyStartupLogText(
          readiness.containerLogs,
          { serverId },
        );
        if (startupClassification === "saved_secret_unavailable") {
          const savedSecretIssue = buildSavedSecretUnavailableIssue(serverId);
          return {
            success: false,
            state: "configuration_required",
            errorCode: savedSecretIssue.errorCode,
            configurationIssue: savedSecretIssue.configurationIssue,
            requiresConfiguration: true,
            requiresSecretReplacement: true,
            requiredAction: savedSecretIssue.requiredAction,
            severity: savedSecretIssue.severity,
            error: savedSecretIssue.error,
            message: savedSecretIssue.message,
            recoveryPrompt: savedSecretIssue.recoveryPrompt,
            recoveryLabel: savedSecretIssue.recoveryLabel,
            details: {
              startup_classification: startupClassification,
              host_listener: readiness.hostListener,
              callback_listener: readiness.callbackListener,
              container_state: readiness.containerState,
            },
            hostPort,
            callbackPort,
          };
        }
        return {
          success: false,
          error: readiness.error,
          details: {
            startup_classification: startupClassification,
            host_listener: readiness.hostListener,
            callback_listener: readiness.callbackListener,
            container_state: readiness.containerState,
            container_logs: readiness.containerLogs,
          },
          hostPort,
          callbackPort,
        };
      }

      singleServerStackPorts = { hostPort, callbackPort };
      if (oauthMode === "bootstrap") {
        singleServerBootstrap = {
          sessionId,
          serverId,
          exportToken: oauthBootstrapExportToken,
        };
      }
      if (!lastComposeProbe) {
        lastComposeProbe = await probeDockerComposeFrontend((command) =>
          execPromise(command, {
            cwd: bootstrap.PROJECT_ROOT,
            timeout: 10000,
          }),
        );
      }
      console.log(`[IPC] Start single MCP server output: ${stdout}`);
      if (stderr)
        console.log(`[IPC] Start single MCP server stderr: ${stderr}`);
      singleServerSession.state = "running";
      sessionEstablished = true;
      return {
        success: true,
        state: "starting",
        sessionId,
        oauthMode,
        output: stdout,
        error: stderr,
        baseUrl: getSingleServerBaseUrl(singleServerSession),
        hostPort,
        callbackPort,
        selectedFrontend: lastComposeProbe.selectedFrontend,
        probeDiagnostics: lastComposeProbe.probeDiagnostics,
        recoveryAttempted,
      };
    } catch (error) {
      console.error(
        `[IPC] Failed to start single MCP server ${serverId}:`,
        error,
      );
      const composeFailure = classifyDockerComposeFailure(error);
      if (composeFailure) {
        return {
          success: false,
          ...composeFailure,
          recoveryAttempted,
        };
      }
      return {
        success: false,
        state: "failed",
        error: error.message,
        errorCode: error.code || "START_SINGLE_MCP_SERVER_FAILED",
        activeOperation: error.activeOperation || null,
        activeMutation: error.activeMutation || null,
        details: error.stderr || error.stdout,
      };
    } finally {
      if (
        !sessionEstablished &&
        sessionId &&
        singleServerSession?.sessionId === sessionId
      ) {
        singleServerSession = null;
        singleServerStackPorts = { hostPort: 8770, callbackPort: 3836 };
      }
      if (
        !sessionEstablished &&
        sessionId &&
        singleServerBootstrap?.sessionId === sessionId
      ) {
        singleServerBootstrap = null;
      }
      releaseMutation?.();
    }
  });

  // Stop single MCP server
  // Options:
  //   skipMcpoRestore: Deprecated (kept for API compatibility)
  ipcMain.handle(
    "stop-single-mcp-server",
    async (_event, serverId, options = {}) => {
      const { skipMcpoRestore = false, sessionId } = options;
      const session = getOwnedSingleServerSession(sessionId, serverId);
      if (!session) {
        return staleSingleServerSessionResult();
      }
      let releaseMutation = null;
      try {
        releaseMutation = await acquireMcpMutationLeaseWithWait(
          {
            kind: "stop_single_mcp_server",
            source: "configuration_modal",
          },
          { waitMs: SINGLE_SERVER_LEASE_WAIT_MS },
        );
        session.state = "stopping";
        console.log(
          `[IPC] Stopping single MCP server: ${serverId} (session=${sessionId}, skipMcpoRestore: ${skipMcpoRestore})`,
        );
        const scriptPath = path.join(
          bootstrap.PROJECT_ROOT,
          "src/scripts/start-single-mcp-server.sh",
        );
        const { stdout, stderr } = await execPromise(
          `bash "${scriptPath}" "${serverId}" --stop`,
          {
            cwd: bootstrap.PROJECT_ROOT,
            env: dockerMcp.createEnhancedEnv(),
            timeout: 60000, // 1 minute timeout
          },
        );
        console.log(`[IPC] Stop single MCP server output: ${stdout}`);
        return { success: true, state: "stopped", output: stdout };
      } catch (error) {
        console.error(
          `[IPC] Failed to stop single MCP server ${serverId}:`,
          error,
        );
        return {
          success: false,
          error: error.message,
          errorCode: error.code || "STOP_SINGLE_MCP_SERVER_FAILED",
          activeOperation: error.activeOperation || null,
          activeMutation: error.activeMutation || null,
        };
      } finally {
        if (releaseMutation && singleServerSession?.sessionId === sessionId) {
          singleServerSession = null;
          singleServerStackPorts = { hostPort: 8770, callbackPort: 3836 };
        }
        if (releaseMutation && singleServerBootstrap?.sessionId === sessionId) {
          singleServerBootstrap = null;
        }
        releaseMutation?.();
      }
    },
  );

  // Check/health-check single MCP server.
  ipcMain.handle("check-single-mcp-server", async (_event, serverId, options = {}) => {
    const session = getOwnedSingleServerSession(options?.sessionId, serverId);
    if (!session) {
      return staleSingleServerSessionResult();
    }

    const baseUrl = getSingleServerBaseUrl(session);
    const requestText = (url) =>
      new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({ statusCode: res.statusCode || 0, body: data }),
          );
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });

    try {
      const statusResponse = await requestText(
        `${baseUrl}/servers/${encodeURIComponent(serverId)}/status`,
      );
      if (!getOwnedSingleServerSession(options?.sessionId, serverId)) {
        return staleSingleServerSessionResult();
      }
      if (statusResponse.statusCode === 200) {
        try {
          const serverStatus = JSON.parse(statusResponse.body);
          if (
            ["needs_oauth", "waiting_callback"].includes(
              serverStatus.readiness_phase,
            ) ||
            ["active", "waiting_callback"].includes(serverStatus.oauth_state)
          ) {
            session.state = "authorization_required";
            return {
              success: true,
              state: "authorization_required",
              healthy: false,
              tools: [],
              error:
                serverStatus.error ||
                "OAuth authorization is required for this server",
            };
          }
          if (serverStatus.readiness_phase === "failed") {
            session.state = "failed";
            return {
              success: false,
              state: "failed",
              healthy: false,
              tools: [],
              error: serverStatus.error || "Server initialization failed",
            };
          }
        } catch (_error) {
          // Fall through to the OpenAPI probe when status JSON is unavailable.
        }
      }

      const openApiResponse = await requestText(
        `${baseUrl}/${serverId}/openapi.json`,
      );
      if (!getOwnedSingleServerSession(options?.sessionId, serverId)) {
        return staleSingleServerSessionResult();
      }
      if ([401, 403, 428].includes(openApiResponse.statusCode)) {
        session.state = "authorization_required";
        return {
          success: true,
          state: "authorization_required",
          healthy: false,
          tools: [],
          error: "OAuth authorization is required for this server",
        };
      }
      if (openApiResponse.statusCode !== 200) {
        return {
          success: true,
          state: "starting",
          healthy: false,
          tools: [],
          error: null,
        };
      }

      const spec = JSON.parse(openApiResponse.body);

      // Filter tools the same way check-single-mcp-server.py does:
      // skip OAuth paths, openapi.json, docs, empty — require ≥1 real tool
      const tools = Object.keys(spec.paths || {})
        .filter((p) => {
          if (p.toLowerCase().includes("oauth")) return false;
          const name = p.split("/").filter(Boolean).pop() || "";
          return name && name !== "openapi.json" && name !== "docs";
        })
        .map((p) => p.split("/").filter(Boolean).pop());

      const healthy = tools.length > 0;
      session.state = healthy ? "healthy" : "starting";
      return {
        success: true,
        state: session.state,
        healthy,
        tools,
        error: null,
      };
    } catch (error) {
      return {
        success: true,
        state: "starting",
        healthy: false,
        tools: [],
        error: null,
      };
    }
  });

  // Get logs from single MCP server container
  ipcMain.handle("get-single-mcp-server-logs", async (event, serverId, lines = 100, options = {}) => {
    try {
      const preferSingleServer = Boolean(options?.preferSingleServer);
      if (
        preferSingleServer &&
        !getOwnedSingleServerSession(options?.sessionId, serverId)
      ) {
        return {
          ...staleSingleServerSessionResult(),
          server_id: serverId,
          logs: "",
        };
      }
      console.log(
        `[IPC] Getting logs for MCP server: ${serverId}${preferSingleServer ? " (prefer single-server container)" : ""}`,
      );
      const result = await getMcpServerLogs(serverId, { lines, preferSingleServer });
      if (
        preferSingleServer &&
        !getOwnedSingleServerSession(options?.sessionId, serverId)
      ) {
        return {
          ...staleSingleServerSessionResult(),
          server_id: serverId,
          logs: "",
        };
      }
      console.log(
        `[IPC] Got logs for ${serverId} from ${result.log_source || "unknown source"}, length: ${(result.logs || "").length}`,
      );
      return result;
    } catch (error) {
      console.error(`[IPC] Failed to get logs for MCP server ${serverId}:`, error);
      return {
        success: false,
        server_id: serverId,
        logs: "",
        error: error.message,
      };
    }
  });
}

// ============================================================================
// MARKETPLACE HANDLERS
// ============================================================================

async function ensureBundledMarketplaceDefaultsAtStartup() {
  // Runs the OOTB merge + legacy migrations (reconcile) and then the
  // once-per-launch integrity pass: adopt orphaned skill dirs, drop ghost
  // records. Offline by design — no marketplace downloads at startup.
  const passResult = await marketplaceService.runStartupMarketplaceIntegrityPass(
    bootstrap.PROJECT_ROOT,
    {
      logger: console,
    },
  );
  const result = passResult?.reconcile;

  if (result?.updated) {
    const marketplacesCount = Array.isArray(result?.config?.marketplaces)
      ? result.config.marketplaces.length
      : 0;
    const installedSkillsCount = Array.isArray(result?.config?.installedSkills)
      ? result.config.installedSkills.length
      : 0;
    console.log(
      `[Marketplace] Reconciled bundled marketplace defaults (${marketplacesCount} marketplaces, ${installedSkillsCount} installed skills)`,
    );
  }

  return {
    success: true,
    restored: Boolean(result?.restoredFromBundledDefaults),
    updated: Boolean(result?.updated),
    adopted: Array.isArray(passResult?.adopted) ? passResult.adopted.length : 0,
    removedGhostRecords: Number(passResult?.removedGhostRecords) || 0,
  };
}

async function ensureOfficialMarketplaceInstalled() {
  return ensureBundledMarketplaceDefaultsAtStartup();
}

function registerMarketplaceHandlers() {
  ipcMain.handle("get-marketplaces", async () => {
    try {
      const config = await marketplaceService.loadMarketplacesConfig(
        bootstrap.PROJECT_ROOT,
        { logger: console },
      );
      return { success: true, data: config };
    } catch (error) {
      console.error("[Marketplace] get-marketplaces error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Renderer pre-flag for the agent-install plan modal: whether a git source
  // would pass the add allowlist. Advisory only — addMarketplace remains the
  // enforcement point.
  ipcMain.handle("marketplace-source-allowed", async (event, sourceInput) => {
    try {
      const { isAllowedMarketplaceSource } = require("./marketplace-allowlist");
      const normalized = marketplaceService.normalizeMarketplaceSourceInput(
        sourceInput,
        { allowDirectUrlSource: true, allowSparseFileUrl: true },
      );
      return { success: true, allowed: isAllowedMarketplaceSource(normalized) };
    } catch (error) {
      // Unparseable sources can never be added.
      return { success: true, allowed: false, errorCode: error.code };
    }
  });

  ipcMain.handle("add-marketplace", async (event, sourceInput) => {
    try {
      const marketplace = await marketplaceService.addMarketplace({
        projectRoot: bootstrap.PROJECT_ROOT,
        sourceInput,
        interactiveAuth: true,
        logger: console,
      });
      console.log(`[Marketplace] Added marketplace: ${marketplace.id}`);
      return { success: true, marketplace };
    } catch (error) {
      console.error("[Marketplace] add-marketplace error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Remove a marketplace
  ipcMain.handle(
    "remove-marketplace",
    async (event, marketplaceId, removeSkills = false) => {
      try {
        await marketplaceService.removeMarketplace({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          removeInstalledSkills: removeSkills,
          logger: console,
        });

        console.log(`[Marketplace] Removed marketplace: ${marketplaceId}`);
        return { success: true };
      } catch (error) {
        console.error("[Marketplace] remove-marketplace error:", error);
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );

  // Removed-skill aftercare shared by the sync and removal-executor
  // envelopes: clear publish sidecar links (Electron-bound, so it lives here
  // rather than in marketplace-service).
  async function clearRemovedSkillSidecarLinks(removed) {
    const skillIds = (Array.isArray(removed) ? removed : [])
      .map((entry) => entry?.skillId)
      .filter(Boolean);
    if (!skillIds.length) return;
    try {
      // One registry rewrite for the batch: clearLink() serializes a full
      // read-modify-write per skill on the shared write chain.
      await require("./ai-marketplace-skill-links").clearLinks(skillIds);
    } catch (error) {
      console.warn(
        `[Marketplace] Could not clear publish links for removed skills ${skillIds.join(", ")}: ${error.message}`,
      );
    }
  }

  function marketplaceSyncAgentReferencesReader() {
    const { buildSyncAgentTools } = require("./marketplace-sync-agent-tools");
    return buildSyncAgentTools().listReferences;
  }

  // Agents-first ordering for the destructive sync: rewrite references the
  // bundle's seedMigrations declared (leaf renames) BEFORE evaluating skills,
  // so healed references never read as blockers. Fail-open — the sweep is
  // opportunistic repair, never a sync precondition.
  async function runPreSyncAgentRelinkSweep() {
    try {
      await require("./agent-skill-relink").runAgentSkillRelinkSweep({
        projectRoot: bootstrap.PROJECT_ROOT,
        logger: console,
      });
    } catch (error) {
      console.warn(
        `[Marketplace] Pre-sync agent relink sweep failed: ${error.message}`,
      );
    }
  }

  ipcMain.handle("sync-marketplace", async (event, marketplaceId) => {
    try {
      await runPreSyncAgentRelinkSweep();
      const result = await marketplaceService.syncMarketplace({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        interactiveAuth: true,
        logger: console,
        listAgentReferences: marketplaceSyncAgentReferencesReader(),
      });
      await clearRemovedSkillSidecarLinks(result.skillsRemoved);

      const updatedCount = result.skillsUpdated?.length || 0;
      const conflictedCount = result.skillsConflicted?.length || 0;
      const removedCount = result.skillsRemoved?.length || 0;
      const pendingCount = result.pendingRemovals?.length || 0;
      console.log(
        `[Marketplace] Synced marketplace: ${marketplaceId} (v${result.marketplace.marketplaceVersion}), skills updated: ${updatedCount}, conflicted: ${conflictedCount}, removed: ${removedCount}, pending removal: ${pendingCount}`,
      );

      return {
        success: true,
        marketplace: result.marketplace,
        hasUpdate: result.hasUpdate,
        skillsUpdated: result.skillsUpdated,
        skillsConflicted: result.skillsConflicted,
        skillsUpToDate: result.skillsUpToDate,
        skillSyncErrors: result.skillSyncErrors,
        skillsRemoved: result.skillsRemoved,
        skillsSourceMissing: result.skillsSourceMissing,
        pendingRemovals: result.pendingRemovals,
        agentInventoryUnavailable: result.agentInventoryUnavailable,
      };
    } catch (error) {
      console.error("[Marketplace] sync-marketplace error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  ipcMain.handle("sync-all-marketplaces", async () => {
    try {
      await runPreSyncAgentRelinkSweep();
      const results = await marketplaceService.syncAllMarketplaces({
        projectRoot: bootstrap.PROJECT_ROOT,
        interactiveAuth: true,
        logger: console,
        listAgentReferences: marketplaceSyncAgentReferencesReader(),
      });
      for (const result of results) {
        await clearRemovedSkillSidecarLinks(result?.skillsRemoved);
      }
      return { success: true, results };
    } catch (error) {
      console.error("[Marketplace] sync-all-marketplaces error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Second phase of the destructive sync: the user consented in the removal
  // modal — unlink editable agents, flag read-only ones, remove the skills.
  ipcMain.handle(
    "apply-marketplace-sync-removals",
    async (event, marketplaceId, removals) => {
      try {
        const { buildSyncAgentTools } = require("./marketplace-sync-agent-tools");
        const result = await marketplaceService.applyMarketplaceSyncRemovals({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          removals: Array.isArray(removals) ? removals : [],
          logger: console,
          agentTools: buildSyncAgentTools(),
        });
        await clearRemovedSkillSidecarLinks(result.removed);
        console.log(
          `[Marketplace] Applied sync removals for ${marketplaceId}: removed ${result.removed.length}, agents updated ${result.agentsUpdated.length}, flagged ${result.agentsFlagged.length}`,
        );
        return { success: true, ...result };
      } catch (error) {
        console.error("[Marketplace] apply-marketplace-sync-removals error:", error);
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );

  ipcMain.handle("get-marketplace-skills", async (event, marketplaceId) => {
    try {
      const result = await marketplaceService.getMarketplaceSkills({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        interactiveAuth: true,
        logger: console,
      });
      return {
        success: true,
        skills: result.skills,
        marketplace: result.marketplace,
      };
    } catch (error) {
      console.error("[Marketplace] get-marketplace-skills error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Read-only first-paint path for the details page: cached manifest +
  // install overlay, no reconcile/network/writes, nothing interactive.
  ipcMain.handle("get-marketplace-skills-cached", async (event, marketplaceId) => {
    try {
      const result = await marketplaceService.getMarketplaceSkillsCached({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        logger: console,
      });
      return {
        success: true,
        skills: result.skills,
        marketplace: result.marketplace,
      };
    } catch (error) {
      console.error("[Marketplace] get-marketplace-skills-cached error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  // Read-only bundle for the git-marketplace skill details page. Installed
  // skills read from disk; uninstalled ones materialize from the allowlisted
  // repository on demand (interactive auth allowed — this is a user-clicked
  // control-plane path, same as Install/Sync).
  ipcMain.handle(
    "get-marketplace-skill-bundle",
    async (event, marketplaceId, skillId, pluginName = null) => {
      try {
        const {
          materializeGitMarketplaceSkillBundle,
        } = require("./ai-marketplace-git-bundle");
        const result = await materializeGitMarketplaceSkillBundle({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          skillId,
          pluginName,
          interactiveAuth: true,
          logger: console,
        });
        return {
          success: true,
          bundle: result.bundle,
          installed: result.installed,
        };
      } catch (error) {
        console.error("[Marketplace] get-marketplace-skill-bundle error:", error);
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );

  ipcMain.handle(
    "install-marketplace-skill",
    async (event, marketplaceId, skillId, skillPath, skillSource, pluginName = null) => {
      try {
        const result = await marketplaceService.installMarketplaceSkill({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          skillId,
          skillPath,
          skillSource,
          pluginName,
          interactiveAuth: true,
          logger: console,
        });
        console.log(`[Marketplace] Installed skill: ${skillId} from ${marketplaceId}`);
        return {
          success: true,
          localPath: result.localPath,
          version: result.version,
          pluginName: result.pluginName ?? null,
        };
      } catch (error) {
        console.error("[Marketplace] install-marketplace-skill error:", error);
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );

  // Uninstall a skill
  ipcMain.handle(
    "uninstall-marketplace-skill",
    async (event, marketplaceId, skillId, pluginName = null) => {
      try {
        // Referential integrity: an installed skill still attached to agents
        // cannot be uninstalled (fail closed when the inventory is
        // unreachable). Guarded at the entry funnel — internal rollback and
        // detach flows call the service directly and stay unguarded.
        await agentSkillUsageGuard.assertSkillDeletable({ leafName: skillId });
        await marketplaceService.uninstallMarketplaceSkill({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          skillId,
          pluginName,
          logger: console,
        });

        console.log(
          `[Marketplace] Uninstalled skill: ${skillId} from ${marketplaceId}`,
        );
        return { success: true };
      } catch (error) {
        console.error(
          "[Marketplace] uninstall-marketplace-skill error:",
          error,
        );
        return {
          success: false,
          error: error.message,
          errorCode: error.code,
          ...(error.body !== undefined ? { body: error.body } : {}),
        };
      }
    },
  );

  ipcMain.handle(
    "detach-marketplace-skill-to-user-skill",
    async (event, marketplaceId, skillId, targetSkillName = null, pluginName = null) => {
      try {
        const result = await marketplaceService.detachMarketplaceSkillToUserSkill({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          skillId,
          targetSkillName,
          pluginName,
          logger: console,
        });

        console.log(
          `[Marketplace] Detached skill: ${skillId} from ${marketplaceId} to ${result.skillName}`,
        );
        return { success: true, ...result };
      } catch (error) {
        console.error(
          "[Marketplace] detach-marketplace-skill-to-user-skill error:",
          error,
        );
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );

  ipcMain.handle("check-skill-updates", async (event, options = {}) => {
    try {
      const result = await marketplaceService.checkSkillUpdates({
        projectRoot: bootstrap.PROJECT_ROOT,
        // Default stays interactive (Sync All / Marketplaces check button);
        // passive render-path freshness scans pass false so viewing a tab can
        // never pop a GitLab sign-in.
        interactiveAuth: options?.interactiveAuth !== false,
        // Solutions-marketplace installs compare the listing's updated_at.
        // One type-filtered search resolves the whole installed fleet;
        // fetchSolution covers only ids the search page missed.
        searchSolutions: (params) =>
          // Sweep searches block the Updates tab's spinner: a backend body
          // stall must cost seconds, not the client's 30s default.
          require("./ai-marketplace-operations").search(params, { timeoutMs: 12_000 }),
        fetchSolution: (solutionId) =>
          require("./ai-marketplace-operations").getSolution(solutionId),
        logger: console,
      });
      return {
        success: true,
        updates: result.updates,
        hasUpdates: result.hasUpdates,
      };
    } catch (error) {
      console.error("[Marketplace] check-skill-updates error:", error);
      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  ipcMain.handle(
    "update-marketplace-skill",
    async (event, marketplaceId, skillId, options = {}) => {
      try {
        const forceDiscardLocalChanges =
          typeof options === "boolean"
            ? options
            : Boolean(options?.forceDiscardLocalChanges);
        const pluginName =
          typeof options === "object" && options !== null
            ? options.pluginName ?? null
            : null;
        const result = await marketplaceService.updateMarketplaceSkill({
          projectRoot: bootstrap.PROJECT_ROOT,
          marketplaceId,
          skillId,
          pluginName,
          forceDiscardLocalChanges,
          interactiveAuth: true,
          logger: console,
        });
        console.log(`[Marketplace] Updated skill: ${skillId} to v${result.version}`);
        return { success: true, version: result.version };
      } catch (error) {
        console.error("[Marketplace] update-marketplace-skill error:", error);
        return { success: false, error: error.message, errorCode: error.code };
      }
    },
  );
}

// ============================================================================
// COST REPORTING HANDLERS
// ============================================================================

let stopCostReportingWatcher = null;
let pendingCostReportBroadcastTimer = null;

function broadcastCostReportUpdated(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send("cost-report-updated", payload);
      }
    } catch (error) {
      console.warn("[CostReporting] Failed to broadcast update:", error.message);
    }
  }

  try {
    owuiViews.broadcastToViews("cost-report-updated", payload);
  } catch (error) {
    console.warn("[CostReporting] Failed to broadcast update to OWUI views:", error.message);
  }
}

function scheduleCostReportUpdatedBroadcast(payload = {}) {
  if (pendingCostReportBroadcastTimer) {
    clearTimeout(pendingCostReportBroadcastTimer);
  }

  pendingCostReportBroadcastTimer = setTimeout(() => {
    pendingCostReportBroadcastTimer = null;
    broadcastCostReportUpdated({
      reportedAt: new Date().toISOString(),
      ...payload,
    });
  }, 120);
}

function registerCostReportingHandlers() {
  if (!stopCostReportingWatcher) {
    stopCostReportingWatcher = costReporting.watchReportingEvents((event) => {
      scheduleCostReportUpdatedBroadcast({
        reason: "filesystem",
        event,
      });
    });
  }

  ipcMain.handle("report-prompt-cost", async (event, payload) => {
    try {
      const result = await costReporting.recordPromptCost(payload);
      if (result.success && !result.ignored) {
        scheduleCostReportUpdatedBroadcast({
          reason: "ipc",
          reportingPath: result.reportingPath,
          event: result.event,
        });
      }
      return result;
    } catch (error) {
      console.error("[CostReporting] Failed to record prompt cost:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-cost-dashboard", async (event, options = {}) => {
    try {
      return await costReporting.getDashboard(options);
    } catch (error) {
      console.error("[CostReporting] Failed to read dashboard:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-chat-cost-summary", async (event, options = {}) => {
    try {
      return await costReporting.getChatCostSummary(options);
    } catch (error) {
      console.error("[CostReporting] Failed to read chat cost summary:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-chat-turn-summary", async (event, options = {}) => {
    try {
      return await costReporting.getChatTurnSummary(options);
    } catch (error) {
      console.error("[CostReporting] Failed to read chat turn summary:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("reveal-cost-reporting-folder", async () => {
    try {
      const result = await costReporting.revealReportingFolder();
      if (!result.success) {
        return result;
      }

      await shell.openPath(result.path);
      return result;
    } catch (error) {
      console.error("[CostReporting] Failed to reveal reporting folder:", error);
      return { success: false, error: error.message };
    }
  });

  console.log("[CostReporting] IPC handlers registered");
}

// ============================================================================
// DEBUG HANDLERS
// ============================================================================

function registerDebugHandlers() {
  // Renderer log forwarding (writes to app logs via main console)
  ipcMain.on("log-to-main", (event, payload = {}) => {
    try {
      const level = payload.level || "info";
      const message = payload.message || "";
      let meta = payload.meta;
      // Marketplace diagnostic events ship in bug-report log bundles: run
      // their metas through the content belt regardless of what the
      // renderer call site passed.
      if (typeof message === "string" && message.startsWith("[Agents][Marketplace")) {
        meta = require("./marketplace-diagnostics").safeMeta(meta);
      }
      const formatted = meta ? `${message} ${JSON.stringify(meta)}` : message;
      const isWebviewConsoleLog =
        Boolean(meta) &&
        typeof meta === "object" &&
        !Array.isArray(meta) &&
        meta.webviewConsole === true;
      const isKonamiLog =
        Boolean(meta) &&
        typeof meta === "object" &&
        !Array.isArray(meta) &&
        meta.konami === true;

      if (isWebviewConsoleLog) {
        const logger = getLogger();
        if (logger && typeof logger.writeWebviewConsoleEntry === "function") {
          logger.writeWebviewConsoleEntry({ level, message, meta });
        }
      }

      if (isKonamiLog) {
        logKonamiMain(meta.konamiLayer || "Renderer", level, message, meta);
      }

      if (!isKonamiLog) {
        if (level === "error") {
          console.error(formatted);
        } else if (level === "warn") {
          console.warn(formatted);
        } else if (level === "debug") {
          console.info(formatted);
        } else {
          console.info(formatted);
        }
      }
    } catch (error) {
      console.error("[IPC] Failed to log from renderer:", error);
    }
  });

  // Save initialization logs handler
  ipcMain.on("save-init-logs", (event, logs) => {
    state.initLogs.saved = logs;
    console.log("[Main] Saved initialization logs for debug collection");
  });

  // Save control panel logs handler
  ipcMain.handle("save-control-panel-logs", async (event, logs) => {
    state.initLogs.controlPanel = logs;
    console.log("[Main] Saved control panel logs for debug collection");
    return { success: true };
  });

  ipcMain.handle("get-guided-setup-debug-sections", async () => {
    try {
      const loggerPaths = getLogPaths() || {};
      const appRuntimeLogs = await readGuidedSetupLogTail(
        loggerPaths.consoleFile || loggerPaths.logFile,
      );
      const prereqLogs = await readGuidedSetupLogTail(getPrereqLogPath());
      const oauthLogs = await readGuidedSetupLogTail(getOAuthLogPath());
      const initLogs = normalizeGuidedSetupLogText(state.initLogs.saved).trim();
      const controlPanelLogs = normalizeGuidedSetupLogText(
        state.initLogs.controlPanel,
      ).trim();
      const hostLogs = Array.isArray(state.hostMcpo?.logs)
        ? state.hostMcpo.logs.join("").trim()
        : "";
      const hostBridgeLogs = Array.isArray(state.hostMcpBridge?.logs)
        ? state.hostMcpBridge.logs.join("").trim()
        : "";
      const runtimeDiagnostics = buildRuntimeDiagnosticsText({
        appRef: app,
        projectRoot: bootstrap.PROJECT_ROOT,
        addressSpaceSnapshot: state.addressSpaceMonitor
          ? state.addressSpaceMonitor.snapshot()
          : null,
        formatAddressSpace: formatAddressSpaceReport,
      }).trim();

      const sections = [
        {
          id: "runtime-paths",
          title: "Runtime Paths",
          content: runtimeDiagnostics,
        },
        {
          id: "system-runtime",
          title: "System / Runtime",
          content: appRuntimeLogs,
        },
        {
          id: "initialization",
          title: "Initialization",
          content: initLogs,
        },
        {
          id: "guided-setup-saved",
          title: "Saved Guided Setup Snapshot",
          content: controlPanelLogs,
        },
        {
          id: "prereq-runtime",
          title: "Prerequisites Runtime",
          content: prereqLogs,
        },
        {
          id: "oauth-runtime",
          title: "Authorization Runtime",
          content: oauthLogs,
        },
        {
          id: "host-runtime",
          title: "Host MCP Runtime",
          content: hostLogs,
        },
        {
          id: "host-mcp-bridge",
          title: "Host MCP Bridge",
          content: hostBridgeLogs,
        },
      ].filter((section) => section.content && section.content.trim().length > 0);

      return { success: true, sections };
    } catch (error) {
      console.error("[IPC] Failed to build guided setup debug sections:", error);
      return {
        success: false,
        error: error.message || "Failed to gather guided setup logs",
      };
    }
  });

  // Collect debug information handler
  ipcMain.handle("collect-debug-info", async (event) => {
    // Collection runs in the background (the renderer no longer blocks the
    // UI on it), so guard against concurrent runs racing on the same temp
    // files and doubling the collection load.
    // PORTICO-373: the guard used to be a plain boolean cleared in `finally`. When a
    // collection hung on an unresponsive engine that `finally` never ran, so every
    // later attempt answered "already running" for the rest of the session — the
    // diagnostics feature stayed dead even after the engine recovered. The guard
    // now expires, so a stuck run costs one attempt instead of all of them.
    const collectStartedAt = Date.now();
    const previousStartedAt = Number(state.debugCollectStartedAt) || 0;
    const previousRunIsStuck =
      previousStartedAt > 0 &&
      collectStartedAt - previousStartedAt > DEBUG_COLLECT_STUCK_AFTER_MS;
    if (state.debugCollectInProgress && !previousRunIsStuck) {
      return {
        success: false,
        alreadyRunning: true,
        error: "Debug collection is already running.",
      };
    }
    if (previousRunIsStuck) {
      console.warn(
        "[Main] Previous debug collection never finished; allowing a new attempt.",
      );
    }
    state.debugCollectInProgress = true;
    state.debugCollectStartedAt = collectStartedAt;
    let logStream = null;
    try {
      const startedAt = Date.now();

      const isRootPath = (candidate) => {
        if (!candidate) return true;
        const resolved = path.resolve(candidate);
        return resolved === path.parse(resolved).root;
      };

      const ensureWritableDir = (dirPath) => {
        if (!dirPath || isRootPath(dirPath)) return false;
        try {
          fs.mkdirSync(dirPath, { recursive: true });
        } catch (error) {
          return false;
        }
        try {
          fs.accessSync(dirPath, fs.constants.W_OK);
          return true;
        } catch (error) {
          return false;
        }
      };

      const resolveDebugProjectRoot = () => {
        const configuredRoot = bootstrap.PROJECT_ROOT;
        if (ensureWritableDir(configuredRoot)) {
          return configuredRoot;
        }

        const managedRoot = path.join(
          os.homedir(),
          "portico",
          "portico-managed",
        );
        if (ensureWritableDir(managedRoot)) {
          return managedRoot;
        }

        const tempRoot = path.join(os.tmpdir(), "portico");
        if (ensureWritableDir(tempRoot)) {
          return tempRoot;
        }

        return process.cwd();
      };

      const debugProjectRoot = resolveDebugProjectRoot();
      const resolvedDebugScript =
        typeof bootstrap.resolveScriptPath === "function"
          ? bootstrap.resolveScriptPath("debug.sh")
          : null;
      const stagedDebugScript =
        typeof bootstrap.ensureProjectScript === "function"
          ? bootstrap.ensureProjectScript("debug.sh")
          : null;
      const debugScript =
        resolvedDebugScript ||
        stagedDebugScript ||
        path.join(debugProjectRoot, "src", "scripts", "debug.sh");
      if (!debugScript || !fs.existsSync(debugScript)) {
        return {
          success: false,
          error:
            "Debug script not found. Run prerequisites to install project scripts and try again.",
        };
      }

      // Save init logs to a temporary file if available
      let initLogsFile = null;
      if (state.initLogs.saved) {
        initLogsFile = path.join(debugProjectRoot, "init_logs_temp.txt");
        await fs.promises.writeFile(initLogsFile, state.initLogs.saved);
        console.log("[Main] Saved init logs to temporary file:", initLogsFile);
      }

      // Save control panel logs to a temporary file if available
      let controlPanelLogsFile = null;
      if (state.initLogs.controlPanel) {
        controlPanelLogsFile = path.join(
          debugProjectRoot,
          "control_panel_logs_temp.txt",
        );
        await fs.promises.writeFile(
          controlPanelLogsFile,
          state.initLogs.controlPanel,
        );
        console.log(
          "[Main] Saved control panel logs to temporary file:",
          controlPanelLogsFile,
        );
      }
      let runtimeDiagnosticsFile = path.join(
        debugProjectRoot,
        "runtime_diagnostics_temp.txt",
      );
      try {
        await fs.promises.writeFile(
          runtimeDiagnosticsFile,
          buildRuntimeDiagnosticsText({
            appRef: app,
            projectRoot: bootstrap.PROJECT_ROOT,
            addressSpaceSnapshot: state.addressSpaceMonitor
              ? state.addressSpaceMonitor.snapshot()
              : null,
            formatAddressSpace: formatAddressSpaceReport,
          }),
        );
        console.log(
          "[Main] Saved runtime diagnostics to temporary file:",
          runtimeDiagnosticsFile,
        );
      } catch (error) {
        console.warn("[Main] Failed to save runtime diagnostics:", error.message);
        runtimeDiagnosticsFile = null;
      }
      const logPaths = getLogPaths();
      const appSupportLogsDir = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "portico",
        "logs",
      );
      const defaultLogsDir = logPaths?.logDir || appSupportLogsDir;
      const logsDir =
        process.platform === "darwin" ? appSupportLogsDir : defaultLogsDir;
      await fs.promises.mkdir(logsDir, { recursive: true });
      const debugLogPath = path.join(logsDir, `debug-info-${startedAt}.log`);
      logStream = fs.createWriteStream(debugLogPath, { flags: "a" });
      logStream.on("error", (streamError) => {
        console.error("[Main] Debug info log stream error:", streamError);
      });

      const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
      const appendTail = (buffer, chunk, maxSize) => {
        const next = buffer + chunk;
        if (next.length <= maxSize) {
          return next;
        }
        return next.slice(next.length - maxSize);
      };

      let stdoutTail = "";
      let stderrTail = "";
      let zipFile = null;
      const zipMatchRegex = /Debug information saved to: (.+\.zip)/;
      // [PROGRESS] <percent> <label> lines emitted by debug.sh drive the
      // titlebar progress pill. Clamped monotonic: redaction workers run in
      // parallel and can emit slightly out of order.
      const progressMatchRegex = /^\[PROGRESS\]\s+(\d{1,3})\s+(.*)$/;
      let lastForwardedPercent = -1;

      const logLine = (line, streamLabel = "stdout") => {
        const cleaned = stripAnsi(line).replace(/\r/g, "");
        if (!cleaned) {
          return;
        }
        const tagged = `[Debug Info] [${streamLabel}] ${cleaned}`;
        logStream.write(`${tagged}\n`);
        if (streamLabel === "stderr") {
          console.error(tagged);
        } else {
          console.log(tagged);
        }
        const match = cleaned.match(zipMatchRegex);
        if (match) {
          zipFile = match[1];
        }
        if (streamLabel !== "stderr") {
          const progressMatch = cleaned.match(progressMatchRegex);
          if (progressMatch) {
            const percent = Math.min(100, Number(progressMatch[1]));
            if (
              percent > lastForwardedPercent &&
              event?.sender &&
              !event.sender.isDestroyed()
            ) {
              lastForwardedPercent = percent;
              event.sender.send("debug-collect-progress", {
                percent,
                label: progressMatch[2].trim(),
              });
            }
          }
        }
      };

      console.log("[Main] Running debug script:", debugScript);
      logLine(
        `Started debug info collection (log file: ${debugLogPath})`,
        "status",
      );

      // PORTICO-373: decide up front whether the container engine can be talked to.
      // debug.sh gates every Docker call on `command -v docker`, i.e. on the
      // BINARY existing, which is always true — so on an unresponsive engine the
      // collector blocked on its first daemon call and produced nothing. The one
      // moment a bundle matters most was the one moment it could not be made.
      //
      // Deliberately a probe and not a repair: collecting diagnostics must never
      // restart the user's container engine as a side effect.
      const dockerPreflight = await (async () => {
        try {
          const probe = await dockerMcp.probeDockerDaemon({
            projectRoot: debugProjectRoot,
            timeoutMs: DEBUG_DOCKER_PREFLIGHT_TIMEOUT_MS,
          });
          if (probe?.ready === true) {
            return { skipDocker: false, status: "ok" };
          }
          return {
            skipDocker: true,
            status: probe?.timedOut === true ? "probe-timeout" : "probe-failed",
          };
        } catch (error) {
          // Never carry raw probe errors into the bundle or the env.
          return { skipDocker: true, status: "probe-failed" };
        }
      })();

      if (dockerPreflight.skipDocker) {
        logLine(
          `Container engine did not respond (${dockerPreflight.status}); collecting everything except Docker diagnostics`,
          "status",
        );
      }

      const enhancedEnv = createEnhancedEnv({
        FORCE_COLOR: "1",
        TERM: "xterm-256color",
        PROJECT_ROOT_OVERRIDE: debugProjectRoot,
        // Both are always set explicitly so inherited environment can neither
        // force a skip on a healthy engine nor hide one on a wedged engine.
        DEBUG_SKIP_DOCKER: dockerPreflight.skipDocker ? "1" : "0",
        DEBUG_DOCKER_PREFLIGHT_STATUS: dockerPreflight.status,
      });

      const { exitCode } = await new Promise((resolve) => {
        const child = spawn("bash", ["-c", `bash "${debugScript}"`], {
          cwd: debugProjectRoot,
          env: enhancedEnv,
        });

        const progressInterval = setInterval(() => {
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          logLine(
            `Debug info collection still running (${elapsedSeconds}s elapsed)`,
            "status",
          );
        }, 30000);

        const handleChunk = (data, streamLabel) => {
          const text = data.toString();
          const cleanText = stripAnsi(text).replace(/\r/g, "");
          if (streamLabel === "stdout") {
            stdoutTail = appendTail(stdoutTail, cleanText, 512 * 1024);
          } else {
            stderrTail = appendTail(stderrTail, cleanText, 512 * 1024);
          }

          const lines = text.split(/\r?\n/);
          lines.forEach((line) => logLine(line, streamLabel));
        };

        child.stdout.on("data", (data) => handleChunk(data, "stdout"));
        child.stderr.on("data", (data) => handleChunk(data, "stderr"));

        child.on("error", (error) => {
          clearInterval(progressInterval);
          logLine(`Debug script failed to start: ${error.message}`, "stderr");
          resolve({ stdout: "", stderr: error.message, exitCode: 1 });
        });

        child.on("close", (code) => {
          clearInterval(progressInterval);
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
          logLine(
            `Debug info collection finished (exit code ${code}, ${elapsedSeconds}s elapsed)`,
            "status",
          );
          resolve({ stdout: "", stderr: "", exitCode: code });
        });
      });

      // Clean up temporary files
      if (initLogsFile) {
        try {
          await fs.promises.unlink(initLogsFile);
        } catch (err) {
          console.error("[Main] Failed to delete temp init logs:", err);
        }
      }
      if (controlPanelLogsFile) {
        try {
          await fs.promises.unlink(controlPanelLogsFile);
        } catch (err) {
          console.error(
            "[Main] Failed to delete temp control panel logs:",
            err,
          );
        }
      }
      if (runtimeDiagnosticsFile) {
        try {
          await fs.promises.unlink(runtimeDiagnosticsFile);
        } catch (err) {
          console.error("[Main] Failed to delete temp runtime diagnostics:", err);
        }
      }

      logStream.end();

      return {
        success: exitCode === 0,
        output: stdoutTail,
        error: stderrTail,
        zipFile: zipFile,
        logFile: debugLogPath,
      };
    } catch (error) {
      console.error("[Main] Failed to collect debug info:", error);
      if (logStream) {
        try {
          logStream.end();
        } catch (closeError) {
          console.error("[Main] Failed to close debug log stream:", closeError);
        }
      }
      return {
        success: false,
        error: error.message,
        details: error.stderr || error.stdout,
      };
    } finally {
      state.debugCollectInProgress = false;
      state.debugCollectStartedAt = 0;
    }
  });

  // Lets the bug-report modal show "Reporting as: {ldap}" before submitting.
  ipcMain.handle("get-bug-report-identity", async () => {
    return resolveBugReportIdentity();
  });

  // Upload debug logs to portico-service
  ipcMain.handle("upload-debug-logs", async (_event, { zipFile, description, reporter, severity }) => {
    const { UPLOAD_ENDPOINT, UPLOAD_MAX_SIZE_BYTES } = require("../config/upload-service-config");
    try {
      if (!zipFile || !fs.existsSync(zipFile)) {
        return { success: false, error: "Debug log zip file not found" };
      }

      const stat = await fs.promises.stat(zipFile);
      if (stat.size > UPLOAD_MAX_SIZE_BYTES) {
        return { success: false, error: `File exceeds 50 MB limit (${Math.round(stat.size / 1024 / 1024)} MB)` };
      }

      if (!description || !description.trim()) {
        return { success: false, error: "Description is required" };
      }

      // Identity is attached automatically so admins can find reports by LDAP+time
      // without relying on the optional free-text reporter field. Resolution never
      // blocks the upload — worst case the report goes out attributed to the OS user.
      const identity = await resolveBugReportIdentity();
      const correlationId = crypto.randomUUID();

      const boundary = `----porticoBoundary${crypto.randomBytes(16).toString("hex")}`;
      const fileName = path.basename(zipFile);

      // Build multipart/form-data preamble + tail; the file itself is streamed from
      // disk rather than buffered on the heap.
      const parts = [];
      const addField = (name, value) => {
        if (value == null) return;
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        );
      };
      addField("description", description.trim());
      if (reporter && reporter.trim()) addField("reporter", reporter.trim());
      if (severity && severity.trim()) addField("severity", severity.trim());
      addField("ldap", identity.ldap);
      addField("identitySource", identity.identitySource);
      addField("appVersion", app.getVersion());
      addField("osInfo", `${os.platform()}-${os.arch()}-${os.release()}`);
      addField("correlationId", correlationId);

      const preamble = Buffer.from(
        parts.join("") +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
      );
      const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`);

      const url = new URL(UPLOAD_ENDPOINT);
      const transport = url.protocol === "https:" ? require("https") : require("http");

      // 60s base + 10s per MB (capped at 5min): a 50 MB ZIP over VPN cannot fit the
      // old fixed 60s budget.
      const timeoutMs = Math.min(60000 + Math.ceil(stat.size / (1024 * 1024)) * 10000, 300000);

      const result = await new Promise((resolve, reject) => {
        const req = transport.request(
          {
            hostname: url.hostname,
            port: url.port || undefined,
            path: url.pathname,
            method: "POST",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": preamble.length + stat.size + fileTail.length,
            },
            timeout: timeoutMs,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed);
              } catch {
                resolve({ success: false, error: `Unexpected response (HTTP ${res.statusCode}): ${data.slice(0, 200)}` });
              }
            });
          }
        );
        req.on("error", (err) => reject(err));
        req.on("timeout", () => {
          req.destroy();
          reject(new Error(`Upload timed out after ${Math.round(timeoutMs / 1000)}s`));
        });

        req.write(preamble);
        const fileStream = fs.createReadStream(zipFile);
        fileStream.on("error", (err) => {
          req.destroy();
          reject(err);
        });
        fileStream.on("end", () => {
          req.write(fileTail);
          req.end();
        });
        fileStream.pipe(req, { end: false });
      });

      console.log("[Main] Debug log upload result:", JSON.stringify(result));
      if (result.success) {
        await appendBugReportReceipt(zipFile, {
          uploadedAt: new Date().toISOString(),
          slug: result.slug || null,
          correlationId: result.correlationId || correlationId,
          ldap: identity.ldap,
          identitySource: identity.identitySource,
          zipFile,
          endpoint: UPLOAD_ENDPOINT,
        });
        if (Notification.isSupported()) {
          new Notification({
            title: "Bug Report Uploaded",
            body: `Upload succeeded: ${result.slug || "unknown"}`,
          }).show();
        }
      }
      return { ...result, ldap: identity.ldap, identitySource: identity.identitySource };
    } catch (error) {
      console.error("[Main] Failed to upload debug logs:", error);
      return { success: false, error: error.message || "Upload failed" };
    }
  });
}

// Resolves who is filing a bug report. Order of trust: cached Okta session from
// guided setup (the real Portico LDAP), then the .env-synced PORTICO_USER_ID, then
// the macOS account name. Failures fall through — identity must never block a
// bug report.
async function resolveBugReportIdentity() {
  try {
    const currentUser = require("./current-user");
    const result = await currentUser.get();
    const id = result?.sessionSummary?.user?.id;
    if (result?.authenticated && typeof id === "string" && id.trim()) {
      return { ldap: id.trim(), identitySource: "okta_cached" };
    }
  } catch (error) {
    console.warn("[Main] Bug report identity: cached session unavailable:", error.message);
  }
  if (typeof process.env.PORTICO_USER_ID === "string" && process.env.PORTICO_USER_ID.trim()) {
    return { ldap: process.env.PORTICO_USER_ID.trim(), identitySource: "env" };
  }
  try {
    return { ldap: os.userInfo().username, identitySource: "os_username" };
  } catch {
    return { ldap: "anonymous", identitySource: "os_username" };
  }
}

// Appends a one-line JSON receipt next to the uploaded ZIP so users (and support)
// can recover the slug/correlationId after the notification is gone.
async function appendBugReportReceipt(zipFile, receipt) {
  try {
    const receiptPath = path.join(path.dirname(zipFile), "bug-report-receipts.jsonl");
    await fs.promises.appendFile(receiptPath, JSON.stringify(receipt) + "\n", "utf8");
  } catch (error) {
    console.warn("[Main] Failed to write bug report receipt:", error.message);
  }
}

// ============================================================================
// WORKSPACE FILE ACCESS HANDLERS
// ============================================================================

function emitChatWorkspaceSelectionUpdated({
  chatId = "",
  flowEntry = null,
  applicationResult = null,
  modalTarget = null,
} = {}) {
  const normalizedChatId = String(chatId || "").trim();
  const selection = applicationResult?.selection || null;
  if (!normalizedChatId || !selection) {
    return;
  }

  const detail = {
    chatId: normalizedChatId,
    selection,
    hostPath: selection.hostPath || flowEntry?.hostPath || null,
    displayPath: selection.displayPath || flowEntry?.displayPath || selection.hostPath || "",
    source: "chat-workspace-consent",
  };

  try {
    const targetViewKey =
      typeof modalTarget?.viewKey === "string" ? modalTarget.viewKey.trim() : "";
    let sent = false;
    if (targetViewKey) {
      sent = owuiViews.sendToView(
        targetViewKey,
        "owui-chat-workspace-selection-updated",
        detail,
      );
    }

    if (!sent) {
      const matchedView = findOwuiViewForChatId(
        normalizedChatId,
        typeof owuiViews.listViews === "function" ? owuiViews.listViews() : [],
      );
      if (matchedView?.viewKey && matchedView.viewKey !== targetViewKey) {
        sent = owuiViews.sendToView(
          matchedView.viewKey,
          "owui-chat-workspace-selection-updated",
          detail,
        );
      }
    }

    if (!sent) {
      owuiViews.broadcastToViews("owui-chat-workspace-selection-updated", detail);
    }
  } catch (error) {
    console.warn(
      "[Workspace Consent] Failed to notify OWUI about workspace selection update:",
      error?.message || error,
    );
  }
}

// Chats that share a root chat's workspace (start_chat links) get their own
// selection-updated pushes when the root's workspace changes, so child chats
// open in other tabs refresh their composer chips live.
function emitLinkedChatWorkspaceFanOutUpdates(fanOut) {
  if (!Array.isArray(fanOut)) {
    return;
  }
  for (const child of fanOut) {
    if (!child?.selection) {
      continue;
    }
    emitChatWorkspaceSelectionUpdated({
      chatId: child.chatId,
      applicationResult: { selection: child.selection },
    });
  }
}

function registerWorkspaceHandlers() {
  function buildCustomWorkspaceSelectionCandidate(chatId, hostPath) {
    const normalizedChatId = String(chatId || "").trim();
    const selectedPath = path.resolve(String(hostPath || ""));
    const { canonicalChatWorkspace } = resolveCanonicalChatWorkspacePath({
      projectRoot: bootstrap.PROJECT_ROOT,
      chatId: normalizedChatId,
    });

    return {
      chatId: normalizedChatId,
      source: "custom",
      isCustom: true,
      isUserSelectedCustom: true,
      hostPath: selectedPath,
      canonicalPath: canonicalChatWorkspace,
      displayPath: collapseHomePath(selectedPath),
    };
  }

  async function chooseChatWorkspaceFolderCandidate(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) {
      throw new Error("chatId is required");
    }

    const previousSelection = getChatWorkspaceSelection({
      projectRoot: bootstrap.PROJECT_ROOT,
      chatId: normalizedChatId,
    });

    const dialogOptions = {
      title: "Choose Workspace Folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const dialogResult = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { canceled: true, selection: previousSelection };
    }

    const selectedPath = path.resolve(dialogResult.filePaths[0]);
    const stats = await fsPromises.stat(selectedPath);
    if (!stats.isDirectory()) {
      throw new Error("Selected workspace path is not a folder");
    }

    return {
      canceled: false,
      selection: buildCustomWorkspaceSelectionCandidate(normalizedChatId, selectedPath),
    };
  }

  ipcMain.handle("get-chat-workspace-selection", async (_event, { chatId } = {}) => {
    try {
      return {
        success: true,
        selection: getChatWorkspaceSelection({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
        }),
      };
    } catch (error) {
      console.error("[Workspace] Failed to get chat workspace selection:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("move-chat-workspace-selection", async (_event, { fromChatId, toChatId } = {}) => {
    try {
      const result = await moveChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        fromChatId,
        toChatId,
      });
      return { success: true, ...result };
    } catch (error) {
      console.error("[Workspace] Failed to move chat workspace selection:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("choose-chat-workspace-folder", async (_event, { chatId } = {}) => {
    try {
      const result = await chooseChatWorkspaceFolderCandidate(chatId);
      if (result.canceled) {
        return {
          success: false,
          canceled: true,
          selection: result.selection,
        };
      }
      return {
        success: true,
        selection: result.selection,
      };
    } catch (error) {
      console.error("[Workspace] Failed to choose chat workspace folder:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("reconcile-chat-workspace-vms", async (_event, { chatId } = {}) => {
    try {
      const normalizedChatId = String(chatId || "").trim();
      if (!normalizedChatId) {
        throw new Error("chatId is required");
      }
      const selection = getChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
      });
      const rebind = await reconcileChatAgentVmWorkspaceBinds(
        normalizedChatId,
        selection.hostPath,
        { env: createEnhancedEnv() },
      );
      return {
        success: true,
        selection,
        rebind,
      };
    } catch (error) {
      console.error("[Workspace] Failed to reconcile chat workspace Agent VMs:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("select-chat-workspace-folder", async (_event, { chatId, hostPath } = {}) => {
    try {
      const normalizedChatId = String(chatId || "").trim();
      if (!normalizedChatId) {
        throw new Error("chatId is required");
      }

      const previousSelection = getChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
      });

      let selectedPath = String(hostPath || "").trim();
      if (!selectedPath) {
        const chooseResult = await chooseChatWorkspaceFolderCandidate(normalizedChatId);
        if (chooseResult.canceled) {
          return { success: false, canceled: true, selection: previousSelection };
        }
        selectedPath = chooseResult.selection.hostPath;
      }

      const applicationResult = await validateAndApplyChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
        hostPath: selectedPath,
        previousSelection,
      });
      emitLinkedChatWorkspaceFanOutUpdates(applicationResult?.fanOut);
      return applicationResult;
    } catch (error) {
      console.error("[Workspace] Failed to select chat workspace folder:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-chat-workspace-folder", async (_event, { chatId } = {}) => {
    try {
      const normalizedChatId = String(chatId || "").trim();
      if (!normalizedChatId) {
        throw new Error("chatId is required");
      }

      const previousSelection = getChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
      });
      const { chatWorkspace } = resolveCanonicalChatWorkspacePath({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
      });
      await fsPromises.mkdir(chatWorkspace, { recursive: true });

      await validateWorkspaceBind(chatWorkspace, { env: createEnhancedEnv() });
      const applicationResult = await applyChatWorkspaceSelection({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId: normalizedChatId,
        hostPath: null,
        previousSelection,
      });
      emitLinkedChatWorkspaceFanOutUpdates(applicationResult?.fanOut);
      return applicationResult;
    } catch (error) {
      console.error("[Workspace] Failed to clear chat workspace folder:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-chat-workspace", async (_event, { chatId } = {}) => {
    try {
      const { chatWorkspace } = await ensureChatWorkspaceDirectories({
        projectRoot: bootstrap.PROJECT_ROOT,
        chatId,
      });

      const openError = await shell.openPath(chatWorkspace);
      if (openError) {
        throw new Error(openError);
      }

      return {
        success: true,
        path: chatWorkspace,
      };
    } catch (error) {
      console.error("[Workspace] Failed to open chat workspace:", error);
      return { success: false, error: error.message };
    }
  });

  // Reveal a workspace file or folder in Finder
  ipcMain.handle(
    "reveal-workspace-file",
    async (event, { chatId, filePath }) => {
      try {
        const { targetPath } = resolveChatWorkspaceEntryPath({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
          relativePath: filePath || "",
        });

        if (!fs.existsSync(targetPath)) {
          throw new Error(`File not found: ${filePath || "workspace"}`);
        }

        // Open Finder and select the file
        shell.showItemInFolder(targetPath);

        return {
          success: true,
          path: targetPath,
          message: `Revealed in Finder: ${path.basename(targetPath)}`,
        };
      } catch (error) {
        console.error("[Workspace] Failed to reveal file:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // List files in a workspace
  ipcMain.handle(
    "list-workspace-files",
    async (event, { chatId, directory }) => {
      try {
        const relativePath = String(directory || "")
          .replace(/\\/g, "/")
          .replace(/^\/+/, "");

        const { targetPath } = resolveChatWorkspaceEntryPath({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
          relativePath,
        });

        if (!fs.existsSync(targetPath)) {
          return {
            success: true,
            files: [],
            message: "Workspace not yet created",
          };
        }

        const entries = await fsPromises.readdir(targetPath, {
          withFileTypes: true,
        });
        const files = await Promise.all(
          entries.map(async (entry) => {
            const entryPath = path.join(targetPath, entry.name);
            const stats = await fsPromises.stat(entryPath);
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              modified: stats.mtime.toISOString(),
              path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
            };
          }),
        );

        return { success: true, files };
      } catch (error) {
        console.error("[Workspace] Failed to list files:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Get download URL for a workspace file
  ipcMain.handle(
    "get-workspace-file-url",
    async (event, { chatId, filePath }) => {
      try {
        if (!chatId || !filePath) {
          throw new Error("chatId and filePath are required");
        }

        const { targetPath } = resolveChatWorkspaceEntryPath({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
          relativePath: filePath,
        });

        if (!fs.existsSync(targetPath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        // Return the localhost URL (file server port stored globally)
        const port = global.workspaceFileServerPort;
        if (!port) {
          throw new Error("Workspace file server not running");
        }

        const url = buildWorkspaceFileUrl({
          chatId,
          filePath,
          host: "localhost",
          port,
        });
        return { success: true, url, fileName: path.basename(filePath) };
      } catch (error) {
        console.error("[Workspace] Failed to get file URL:", error);
        return { success: false, error: error.message };
      }
    },
  );

  console.log("[IPC] Workspace handlers registered");
}

// ============================================================================
// ARTIFACT HANDLERS
// ============================================================================

function registerArtifactHandlers() {
  const { artifactWindows, windows } = require("./shared-state");
  const path = require("path");
  const attachedArtifactViews = new Map();
  const artifactLifecycleOperations = new Map();
  const observedArtifactViewOwners = new Set();

  async function callArtifactTool(toolName, payload, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `http://localhost:8766/artifacts/artifacts_${toolName}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Artifacts backend returned ${response.status}: ${text}`);
      }
      return text ? JSON.parse(text) : { success: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  function hasDetachedArtifactView(artifactId) {
    const info = artifactWindows.get(artifactId);
    return Boolean(info?.window && !info.window.isDestroyed());
  }

  function attachedArtifactLeaseKey(webContentsId, viewKey) {
    return `${webContentsId}:${viewKey}`;
  }

  function hasAttachedArtifactView(artifactId) {
    return (attachedArtifactViews.get(artifactId)?.size || 0) > 0;
  }

  function runArtifactLifecycleOperation(artifactId, operation) {
    const previous = artifactLifecycleOperations.get(artifactId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    artifactLifecycleOperations.set(artifactId, current);
    const cleanup = () => {
      if (artifactLifecycleOperations.get(artifactId) === current) {
        artifactLifecycleOperations.delete(artifactId);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async function stopArtifactRuntimeIfUnused(artifactId) {
    if (!artifactId || hasDetachedArtifactView(artifactId) || hasAttachedArtifactView(artifactId)) {
      return { success: true, stopped: false, reason: "view-active" };
    }
    const result = await callArtifactTool("close_artifact", { artifact_id: artifactId });
    console.log(`[Artifacts] Stopped runtime after final view closed: ${artifactId}`);
    return { ...result, stopped: true };
  }

  async function previewIsReachable(previewUrl) {
    if (!previewUrl) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(previewUrl, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });
      return response.status < 500;
    } catch (_error) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  ipcMain.handle("artifact-retain-view", async (event, { artifactId, viewKey } = {}) => {
    if (!artifactId || !viewKey) {
      return { success: false, error: "artifactId and viewKey are required" };
    }
    const ownerId = event.sender.id;
    const leaseKey = attachedArtifactLeaseKey(ownerId, viewKey);
    const leases = attachedArtifactViews.get(artifactId) || new Set();
    leases.add(leaseKey);
    attachedArtifactViews.set(artifactId, leases);

    if (!observedArtifactViewOwners.has(ownerId)) {
      observedArtifactViewOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        observedArtifactViewOwners.delete(ownerId);
        const prefix = `${ownerId}:`;
        const releasedArtifactIds = [];
        for (const [leasedArtifactId, artifactLeases] of attachedArtifactViews.entries()) {
          let released = false;
          for (const key of artifactLeases) {
            if (key.startsWith(prefix)) {
              artifactLeases.delete(key);
              released = true;
            }
          }
          if (!released) continue;
          releasedArtifactIds.push(leasedArtifactId);
          if (artifactLeases.size === 0) {
            attachedArtifactViews.delete(leasedArtifactId);
          }
        }
        for (const leasedArtifactId of releasedArtifactIds) {
          void runArtifactLifecycleOperation(leasedArtifactId, () =>
            stopArtifactRuntimeIfUnused(leasedArtifactId),
          ).catch((error) => {
            console.error(`[Artifacts] Failed to release destroyed view owner for ${leasedArtifactId}:`, error);
          });
        }
      });
    }
    return { success: true };
  });

  ipcMain.handle("artifact-release-view", async (event, { artifactId, viewKey } = {}) => {
    const leases = attachedArtifactViews.get(artifactId);
    if (leases && viewKey) {
      leases.delete(attachedArtifactLeaseKey(event.sender.id, viewKey));
      if (leases.size === 0) attachedArtifactViews.delete(artifactId);
    }
    return runArtifactLifecycleOperation(artifactId, async () => {
      try {
        return await stopArtifactRuntimeIfUnused(artifactId);
      } catch (error) {
        console.error(`[Artifacts] Failed to release runtime for ${artifactId}:`, error);
        return { success: false, stopped: false, error: error.message };
      }
    });
  });

  ipcMain.handle(
    "artifact-refresh-runtime",
    async (_event, { artifactId, version, detached = false } = {}) => {
      return runArtifactLifecycleOperation(artifactId, async () => {
        try {
          const status = await callArtifactTool("get_artifact_status", {
            artifact_id: artifactId,
          });
          if (
            status.status === "running" &&
            status.current_version === version &&
            await previewIsReachable(status.preview_url)
          ) {
            return { success: true, restarted: false, preview_url: status.preview_url };
          }
          const payload = {
            artifact_id: artifactId,
            detached: Boolean(detached),
            force_restart: true,
          };
          if (Number.isInteger(version)) {
            payload.version = version;
          }
          const result = await callArtifactTool("open_artifact", payload);
          return { ...result, restarted: result.success === true };
        } catch (error) {
          console.error(`[Artifacts] Failed to refresh runtime for ${artifactId}:`, error);
          return { success: false, restarted: false, error: error.message };
        }
      });
    },
  );

  ipcMain.handle(
    "artifact-publish",
    async (event, { artifactId, chatId, name, version } = {}) => {
      console.log(
        `[Artifacts] IPC: artifact-publish called for ${artifactId}, version ${version}`,
      );

      try {
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        let username =
          configData?.env?.PORTICO_USER_ID ||
          configData?.env?.PORTICO_USER_NAME ||
          null;

        try {
          const userResult = await currentUser.get();
          username =
            userResult?.sessionSummary?.user?.id ||
            userResult?.userId ||
            username;
        } catch (error) {
          console.warn(
            `[Artifacts] Could not load current user for publish: ${error.message}`,
          );
        }

        return await publishArtifactToPrototypes({
          artifactId,
          chatId,
          name,
          version,
          projectRoot: bootstrap.PROJECT_ROOT,
          parentWindow,
          username,
        });
      } catch (error) {
        console.error("[Artifacts] Failed to publish artifact:", error);
        return {
          success: false,
          error: error.message || "Failed to publish artifact.",
          status: error.status || null,
        };
      }
    },
  );

  // Detach artifact to separate window
  ipcMain.handle(
    "artifact-detach",
    async (
      event,
      {
        artifactId,
        previewUrl,
        name,
        chatId,
        currentVersion,
        preferredVersion,
      },
    ) => {
      console.log(
        `[Artifacts] IPC: artifact-detach called for ${artifactId}, version ${currentVersion}`,
      );
      try {
        const { BrowserWindow } = require("electron");
        const initialVersion = Number.isInteger(currentVersion)
          ? currentVersion
          : 1;
        const preferredVersionValue = Number.isInteger(preferredVersion)
          ? preferredVersion
          : null;

        // If already detached, focus existing window
        if (artifactWindows.has(artifactId)) {
          const existing = artifactWindows.get(artifactId);
          if (existing.window && !existing.window.isDestroyed()) {
            existing.window.focus();
            return {
              success: true,
              windowId: existing.windowId,
              alreadyDetached: true,
            };
          } else {
            // Clean up stale entry
            artifactWindows.delete(artifactId);
            updateWindowMenu(); // Sync Window menu after stale cleanup
          }
        }

        // Detect current theme: prefer authoritative main-process state
        let currentTheme = state.appState.currentTheme || "dark";
        if (!state.appState.currentTheme) {
          try {
            if (windows.main && !windows.main.isDestroyed()) {
              currentTheme = await windows.main.webContents.executeJavaScript(
                "document.documentElement.getAttribute('data-theme') || 'dark'",
              );
            }
          } catch (e) {
            console.log("[Artifacts] Could not detect theme, defaulting to dark");
          }
        }

        // Create a new detached window for the artifact with preload script
        const detachedWindow = new BrowserWindow({
          width: 900,
          height: 700,
          title: name || "Artifact Preview",
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            preload: path.join(__dirname, "artifact-window-preload.js"),
          },
        });

        // Track the window
        artifactWindows.set(artifactId, {
          windowId: detachedWindow.id,
          window: detachedWindow,
          chatId: chatId,
          name: name,
          previewUrl: previewUrl,
          currentVersion: initialVersion,
        });
        updateWindowMenu(); // Add new artifact window to Window menu

        // Clean up on close
        detachedWindow.on("closed", () => {
          const wasReattached = artifactWindows.get(artifactId)?.reattaching === true;
          artifactWindows.delete(artifactId);
          updateWindowMenu(); // Remove closed window from Window menu
          console.log(
            `[Artifacts] Detached window closed for artifact ${artifactId}`,
          );
          // Notify main window that artifact window was closed
          if (windows.main && !windows.main.isDestroyed()) {
            windows.main.webContents.send("artifact-window-closed", {
              artifactId,
              chatId,
            });
          }
          if (!wasReattached) {
            void runArtifactLifecycleOperation(artifactId, () =>
              stopArtifactRuntimeIfUnused(artifactId),
            ).catch((error) => {
              console.error(`[Artifacts] Failed to stop detached artifact ${artifactId}:`, error);
            });
          }
        });

        // Escape strings for embedding in HTML
        const escapedName = (name || "Artifact")
          .replace(/'/g, "\\'")
          .replace(/"/g, "&quot;");
        const escapedPreviewUrl = previewUrl.replace(/'/g, "\\'");

        // Load HTML page with unified toolbar (matching inline panel style)
        const html = `
<!DOCTYPE html>
<html data-theme="${currentTheme}">
  <head>
    <title>${escapedName}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      /* Dark theme (default) */
      :root {
        --toolbar-bg: #323738;
        --toolbar-border: #3a3f40;
        --text-primary: #e5e5e5;
        --text-secondary: #a3a3a3;
        --bg-elevated: #3a3f40;
        --bg-hover: #4a4f50;
        --border-color: #555;
        --body-bg: #282d2e;
      }

      /* Light theme */
      [data-theme="light"] {
        --toolbar-bg: #f8f9fa;
        --toolbar-border: #e5e7eb;
        --text-primary: #1f2937;
        --text-secondary: #6b7280;
        --bg-elevated: #ffffff;
        --bg-hover: #f3f4f6;
        --border-color: #d1d5db;
        --body-bg: #ffffff;
      }

      body {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: var(--body-bg);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .toolbar {
        height: 40px;
        background: var(--toolbar-bg);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        -webkit-app-region: drag;
        border-bottom: 1px solid var(--toolbar-border);
      }
      .artifact-info {
        display: flex;
        align-items: center;
        gap: 8px;
        -webkit-app-region: no-drag;
      }
      .artifact-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Custom version dropdown */
      .version-dropdown {
        position: relative;
        display: inline-block;
        -webkit-app-region: no-drag;
      }
      .version-dropdown-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        font-size: 12px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        color: var(--text-secondary);
        cursor: pointer;
        transition: all 0.15s ease;
        min-width: 60px;
      }
      .version-dropdown-trigger:hover { background: var(--bg-hover); }
      .version-dropdown-trigger:focus { outline: none; border-color: #4ade80; }
      .version-trigger-indicator {
        flex-shrink: 0;
        font-size: 10px;
        color: #6b7280;
      }
      .version-trigger-indicator.running { color: #22c55e; }
      .version-dropdown-text {
        flex: 1;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }
      .version-dropdown-chevron {
        flex-shrink: 0;
        opacity: 0.7;
        transition: transform 0.15s ease;
      }
      .version-dropdown.open .version-dropdown-chevron { transform: rotate(180deg); }
      .version-dropdown-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        min-width: 100%;
        max-width: 240px;
        max-height: 200px;
        overflow-y: auto;
        background: var(--bg-elevated);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        z-index: 1000;
        padding: 4px;
      }
      .version-dropdown-menu.hidden { display: none; }
      .version-dropdown-option {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        font-size: 12px;
        color: var(--text-secondary);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s ease;
      }
      .version-dropdown-option:hover { background: var(--bg-hover); color: var(--text-primary); }
      .version-dropdown-option.selected { background: rgba(59, 130, 246, 0.15); color: var(--text-primary); }
      .version-indicator { flex-shrink: 0; font-size: 10px; }
      .version-indicator.running { color: #22c55e; }
      .version-indicator.stopped { color: #6b7280; }
      .version-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .controls {
        display: flex;
        align-items: center;
        gap: 4px;
        -webkit-app-region: no-drag;
      }
      .control-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        background: transparent;
        border: none;
        border-radius: 4px;
        color: var(--text-secondary);
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .control-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
      .control-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .control-btn:disabled:hover { background: transparent; color: var(--text-secondary); }
      webview { flex: 1; width: 100%; background: #fff; }
      /* Loading overlay for artifact snapshot restoration */
      .artifact-loading-overlay {
        position: absolute;
        top: 40px;  /* Below toolbar */
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        z-index: 10;
      }
      .artifact-loading-overlay.hidden { display: none; }
      .artifact-loading-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
      }
      .artifact-loading-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid var(--border-color);
        border-top-color: var(--text-secondary);
        border-radius: 50%;
        animation: spinner-spin 0.8s linear infinite;
      }
      @keyframes spinner-spin {
        to { transform: rotate(360deg); }
      }
      .artifact-loading-text {
        font-size: 14px;
        color: var(--text-secondary);
        font-weight: 500;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div class="artifact-info">
        <span class="artifact-name">${escapedName}</span>
        <div class="version-dropdown" id="version-dropdown">
          <button class="version-dropdown-trigger" id="version-dropdown-trigger" title="Select version">
            <span class="version-trigger-indicator" id="version-trigger-indicator">●</span>
            <span class="version-dropdown-text" id="version-dropdown-text">v${initialVersion}</span>
            <svg class="version-dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="version-dropdown-menu hidden" id="version-dropdown-menu"></div>
        </div>
      </div>
      <div class="controls">
        <button class="control-btn" id="refresh-btn" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
        </button>
        <button class="control-btn" id="attach-btn" title="Attach to Main">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        </button>
        <button class="control-btn" id="close-btn" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    <!-- Loading overlay for artifact snapshot restoration (shown by default on open) -->
    <div id="artifact-loading-overlay" class="artifact-loading-overlay">
      <div class="artifact-loading-content">
        <div class="artifact-loading-spinner"></div>
        <div class="artifact-loading-text">Restoring artifact snapshot...</div>
      </div>
    </div>
    <webview id="artifact-webview" partition="persist:artifacts"></webview>
    <script>
      // Artifact data - stored locally since preload can't access window vars due to context isolation
      const ARTIFACT_DATA = {
        artifactId: '${artifactId}',
        chatId: ${chatId ? `'${chatId}'` : "null"},
        currentVersion: ${initialVersion},
        preferredVersion: ${preferredVersionValue ?? "null"},
        previewUrl: '${escapedPreviewUrl}'
      };

      // Suppress expected ERR_ABORTED rejections during rapid version switches
      window.addEventListener('unhandledrejection', (event) => {
        if (event?.reason?.message && event.reason.message.includes('ERR_ABORTED')) {
          event.preventDefault();
          console.log('[Artifacts] Detached: Suppressed ERR_ABORTED');
        }
      });

      // Button handlers - pass data as arguments since preload can't access window vars
      document.getElementById('refresh-btn').onclick = async () => {
        showLoading();
        const result = await window.electronAPI.refreshRuntime(
          ARTIFACT_DATA.artifactId,
          ARTIFACT_DATA.currentVersion,
          ARTIFACT_DATA.previewUrl,
        );
        if (result?.success && result.preview_url) {
          ARTIFACT_DATA.previewUrl = result.preview_url;
          safeLoadUrl(result.preview_url, { forceLoad: true, bypassCache: true });
        } else {
          console.error('[Artifacts] Detached: Runtime refresh failed:', result?.error || result);
          hideLoading();
        }
      };
      document.getElementById('attach-btn').onclick = () => {
        window.electronAPI.attachToMain(ARTIFACT_DATA.artifactId, ARTIFACT_DATA.chatId);
      };
      document.getElementById('close-btn').onclick = () => window.close();

      // Custom dropdown state and elements
      let dropdownOpen = false;
      let versionsData = [];
      let runningVersions = new Map();  // version -> { isRunning: bool }
      const dropdown = document.getElementById('version-dropdown');
      const trigger = document.getElementById('version-dropdown-trigger');
      const triggerIndicator = document.getElementById('version-trigger-indicator');
      const menu = document.getElementById('version-dropdown-menu');
      const textEl = document.getElementById('version-dropdown-text');
      const loadingOverlay = document.getElementById('artifact-loading-overlay');
      const webview = document.getElementById('artifact-webview');
      let activePreviewUrl = '';
      let usingFallbackPreview = false;
      let previewRecoveryPromise = null;

      console.log('[Artifacts] Detached: Elements found - triggerIndicator:', !!triggerIndicator, 'menu:', !!menu, 'textEl:', !!textEl);

      // Show/hide loading overlay for cold version switches
      function showLoading() {
        if (loadingOverlay) {
          loadingOverlay.classList.remove('hidden');
          console.log('[Artifacts] Detached: Showing loading overlay');
        }
      }

      function hideLoading() {
        if (loadingOverlay) {
          loadingOverlay.classList.add('hidden');
        }
      }

      function getFallbackPreviewUrl() {
        if (!ARTIFACT_DATA.chatId || !ARTIFACT_DATA.artifactId) {
          return null;
        }

        return 'http://localhost:9876/artifact-preview/' +
          encodeURIComponent(ARTIFACT_DATA.chatId) + '/' +
          encodeURIComponent(ARTIFACT_DATA.artifactId) + '/';
      }

      function getVersionPreviewUrl(version) {
        const versionNumber = Number(version);
        if (!ARTIFACT_DATA.chatId || !ARTIFACT_DATA.artifactId || !Number.isInteger(versionNumber) || versionNumber < 1) {
          return null;
        }

        return 'http://localhost:9876/artifact-preview/' +
          encodeURIComponent(ARTIFACT_DATA.chatId) + '/' +
          encodeURIComponent(ARTIFACT_DATA.artifactId) + '/versions/' +
          versionNumber + '/';
      }

      function isVersionPreviewUrl(url) {
        if (!url) return false;
        try {
          const parsed = new URL(url);
          return parsed.pathname.includes('/artifact-preview/') && parsed.pathname.includes('/versions/');
        } catch (error) {
          return false;
        }
      }

      function extractPreviewPort(url) {
        if (!url) return null;

        try {
          const parsed = new URL(url);
          if (!parsed.port) return null;
          const port = Number(parsed.port);
          return Number.isFinite(port) ? port : null;
        } catch (error) {
          return null;
        }
      }

      function getLiveUrlForCurrentVersion() {
        const info = runningVersions.get(ARTIFACT_DATA.currentVersion);
        if (info?.host_port) {
          return 'http://localhost:' + info.host_port;
        }
        return null;
      }

      function safeLoadUrl(url, options = {}) {
        if (!url) return;
        activePreviewUrl = url;
        usingFallbackPreview = url === getFallbackPreviewUrl();

        const assignSrc = () => {
          try {
            webview.src = url;
          } catch (srcError) {
            console.error('[Artifacts] Detached: Failed to set webview src:', srcError);
          }
        };

        try {
          if (typeof webview.isLoading === 'function' && webview.isLoading()) {
            webview.stop();
          }
        } catch (e) {
          console.log('[Artifacts] Detached: Webview not ready for isLoading check, will set src directly');
        }

        try {
          if (typeof webview.loadURL === 'function') {
            webview.loadURL(url, options).catch((e) => {
              if (e?.message && e.message.includes('ERR_ABORTED')) {
                console.log('[Artifacts] Detached: Webview load aborted (expected during version switch)');
              } else {
                console.warn('[Artifacts] Detached: Webview loadURL failed, falling back to src:', e?.message || e);
                assignSrc();
              }
            });
          } else {
            assignSrc();
          }
        } catch (e) {
          if (e?.message && e.message.includes('ERR_ABORTED')) {
            console.log('[Artifacts] Detached: Webview load aborted (expected during version switch)');
          } else {
            console.log('[Artifacts] Detached: loadURL threw, falling back to src');
            assignSrc();
          }
        }
      }

      async function recoverPreviewLoad(primaryUrl, fallbackUrl) {
        const liveUrl = getLiveUrlForCurrentVersion();
        if (liveUrl && liveUrl !== primaryUrl) {
          console.log('[Artifacts] Detached: Switching to live URL from running version data:', liveUrl);
          ARTIFACT_DATA.previewUrl = liveUrl;
          safeLoadUrl(liveUrl);
          return;
        }

        const port = extractPreviewPort(primaryUrl);
        if (port && window.electronAPI?.pingServers) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              const result = await window.electronAPI.pingServers([port]);
              const health = result?.health?.[port];
              if (result?.success && health?.running) {
                if (ARTIFACT_DATA.previewUrl === primaryUrl) {
                  console.log('[Artifacts] Detached: Preview became reachable, retrying live load');
                  safeLoadUrl(primaryUrl);
                }
                return;
              }
            } catch (error) {
              console.warn('[Artifacts] Detached: Preview health probe failed:', error);
            }

            await new Promise((resolve) => window.setTimeout(resolve, 500));
          }
        }

        if (fallbackUrl && activePreviewUrl !== fallbackUrl) {
          console.warn('[Artifacts] Detached: Live preview unavailable, falling back to materialized workspace');
          ARTIFACT_DATA.previewUrl = fallbackUrl;
          showLoading();
          safeLoadUrl(fallbackUrl);
        } else {
          hideLoading();
        }
      }

      // Hide loading when webview finishes loading
      webview.addEventListener('did-finish-load', hideLoading);
      webview.addEventListener('dom-ready', hideLoading);
      webview.addEventListener('did-fail-load', async (event) => {
        if (event.errorCode === -3) {
          console.log('[Artifacts] Detached: Webview load aborted (expected during version switch)');
          return;
        }
        if (event.errorCode !== 0) {
          console.warn('[Artifacts] Detached: Webview load failed:', event.errorCode, event.errorDescription);
          if (
            event.errorCode === -102 &&
            activePreviewUrl === ARTIFACT_DATA.previewUrl &&
            !previewRecoveryPromise
          ) {
            const fallbackUrl = getFallbackPreviewUrl();
            previewRecoveryPromise = recoverPreviewLoad(ARTIFACT_DATA.previewUrl, fallbackUrl)
              .finally(() => {
                previewRecoveryPromise = null;
              });
            await previewRecoveryPromise;
            return;
          }
          hideLoading();
        }
      });

      // Toggle dropdown
      function toggleDropdown() {
        dropdownOpen = !dropdownOpen;
        if (dropdownOpen) {
          menu.classList.remove('hidden');
          dropdown.classList.add('open');
        } else {
          menu.classList.add('hidden');
          dropdown.classList.remove('open');
        }
      }

      function closeDropdown() {
        dropdownOpen = false;
        menu.classList.add('hidden');
        dropdown.classList.remove('open');
      }

      // Handle version selection
      async function selectVersion(newVersion, options = {}) {
        const userInitiated = options.userInitiated !== false;
        if (userInitiated) {
          closeDropdown();
        }
        if (newVersion === ARTIFACT_DATA.currentVersion) {
          const versionUrl = getVersionPreviewUrl(newVersion);
          if (versionUrl && ARTIFACT_DATA.previewUrl !== versionUrl) {
            showLoading();
            safeLoadUrl(versionUrl, { forceLoad: true, bypassCache: true });
            ARTIFACT_DATA.previewUrl = versionUrl;
            window.electronAPI.syncDetachedVersion(ARTIFACT_DATA.artifactId, newVersion, userInitiated, ARTIFACT_DATA.previewUrl);
          }
          return;
        }

        console.log('[Artifacts] Detached: Switching to version', newVersion);

        // Check if version is not currently running - will need cold restore
        const versionInfo = runningVersions.get(newVersion);
        const isColdSwitch = !versionInfo || !versionInfo.isRunning;

        // Show loading overlay for cold switches (restoring from snapshot takes time)
        if (isColdSwitch) {
          showLoading();
        }

        try {
          const result = await window.electronAPI.switchVersion(ARTIFACT_DATA.artifactId, newVersion);
          if (result.success) {
            // Log and handle hot vs cold switch
            if (result.from_pool) {
              console.log('[Artifacts] Detached: HOT switch to version', newVersion);
              hideLoading();  // Hide immediately for hot switches
            } else {
              console.log('[Artifacts] Detached: COLD switch to version', newVersion, '(restoring from snapshot)');
              // Loading overlay stays visible until webview fires did-finish-load
            }

            const liveUrl = result.preview_url || (result.host_port ? 'http://localhost:' + result.host_port : null);
            const url = getVersionPreviewUrl(newVersion) || liveUrl;
            if (url) {
              safeLoadUrl(url, { forceLoad: true, bypassCache: true });
              ARTIFACT_DATA.previewUrl = url;
            }
            ARTIFACT_DATA.currentVersion = newVersion;
            // Sync version to main process so re-attach preserves this version
            window.electronAPI.syncDetachedVersion(ARTIFACT_DATA.artifactId, newVersion, userInitiated, ARTIFACT_DATA.previewUrl);
            // Refresh running versions and update display
            await fetchRunningVersions();
            renderVersionMenu();
            updateVersionDisplay();
          } else {
            console.error('[Artifacts] Detached: Failed to switch version:', result.error);
            hideLoading();  // Hide on error
          }
        } catch (e) {
          console.error('[Artifacts] Detached: Error switching version:', e);
          hideLoading();  // Hide on error
        }
      }

      // Fetch running versions from backend
      async function fetchRunningVersions() {
        console.log('[Artifacts] Detached: Fetching running versions for', ARTIFACT_DATA.artifactId);
        try {
          const result = await window.electronAPI.getRunningVersions(ARTIFACT_DATA.artifactId);
          console.log('[Artifacts] Detached: getRunningVersions result:', JSON.stringify(result));
          if (result && result.success && result.running_versions) {
            runningVersions.clear();
            result.running_versions.forEach(v => {
              // Ensure version is stored as integer for consistent lookup
              const versionNum = parseInt(v.version, 10);
              console.log('[Artifacts] Detached: Adding running version', versionNum, '(original:', v.version, 'type:', typeof v.version, ')');
              runningVersions.set(versionNum, { isRunning: true, host_port: v.host_port });
            });
            console.log('[Artifacts] Detached: Found', runningVersions.size, 'running versions, currentVersion:', ARTIFACT_DATA.currentVersion, 'type:', typeof ARTIFACT_DATA.currentVersion);
            console.log('[Artifacts] Detached: Map has currentVersion?', runningVersions.has(ARTIFACT_DATA.currentVersion));

            const liveUrl = getLiveUrlForCurrentVersion();
            if (liveUrl && liveUrl !== ARTIFACT_DATA.previewUrl && !isVersionPreviewUrl(ARTIFACT_DATA.previewUrl)) {
              console.log('[Artifacts] Detached: Updating preview URL from running version data:', liveUrl);
              ARTIFACT_DATA.previewUrl = liveUrl;
            }
          } else {
            console.log('[Artifacts] Detached: No running versions data or request failed, result:', result);
          }
        } catch (e) {
          console.error('[Artifacts] Detached: Failed to fetch running versions:', e);
        }
      }

      // Render dropdown menu options
      function renderVersionMenu() {
        console.log('[Artifacts] Detached renderVersionMenu - runningVersions size:', runningVersions.size,
          'keys:', [...runningVersions.keys()],
          'versionsData:', versionsData.map(v => v.version));

        menu.innerHTML = '';
        versionsData.forEach(v => {
          const btn = document.createElement('button');
          btn.className = 'version-dropdown-option';
          const isCurrentVersion = v.version === ARTIFACT_DATA.currentVersion;
          if (isCurrentVersion) btn.classList.add('selected');

          const indicator = document.createElement('span');
          const info = runningVersions.get(v.version);
          // Current version is always running since we're displaying it
          const isRunning = isCurrentVersion || (info && info.isRunning);
          console.log('[Artifacts] Detached renderVersionMenu - version', v.version, 'isCurrentVersion:', isCurrentVersion, 'info:', info, 'isRunning:', isRunning);
          if (isRunning) {
            indicator.className = 'version-indicator running';
            indicator.textContent = '\u25CF';  // Filled circle (green)
          } else {
            indicator.className = 'version-indicator stopped';
            indicator.textContent = '\u25CB';  // Empty circle (gray)
          }

          const text = document.createElement('span');
          text.className = 'version-text';
          text.textContent = v.version_note ? 'v' + v.version + ' - ' + v.version_note : 'v' + v.version;

          btn.appendChild(indicator);
          btn.appendChild(text);
          btn.onclick = (e) => { e.stopPropagation(); selectVersion(v.version); };
          menu.appendChild(btn);
        });
      }

      // Update trigger indicator and text
      function updateVersionDisplay() {
        const current = versionsData.find(v => v.version === ARTIFACT_DATA.currentVersion);
        const info = runningVersions.get(ARTIFACT_DATA.currentVersion);

        // The current version is ALWAYS running since we're displaying it
        // Health check failures for pool versions shouldn't affect the currently displayed version
        const isCurrentRunning = true;
        console.log('[Artifacts] Detached: updateVersionDisplay - currentVersion:', ARTIFACT_DATA.currentVersion, 'isCurrentRunning:', isCurrentRunning, 'info:', info);

        // Update trigger indicator (styled element)
        if (triggerIndicator) {
          if (isCurrentRunning) {
            triggerIndicator.classList.add('running');
            console.log('[Artifacts] Detached: Added running class to trigger indicator');
          } else {
            triggerIndicator.classList.remove('running');
          }
        }

        // Update trigger text (no indicator character - it's in a separate element)
        if (current) {
          textEl.textContent = current.version_note
            ? 'v' + current.version + ' - ' + current.version_note
            : 'v' + current.version;
        } else {
          textEl.textContent = 'v' + ARTIFACT_DATA.currentVersion;
        }
      }

      // Dropdown event handlers
      trigger.onclick = (e) => { e.stopPropagation(); toggleDropdown(); };
      document.addEventListener('click', (e) => {
        if (dropdownOpen && !dropdown.contains(e.target)) closeDropdown();
      });

      // Load full version list from backend
      async function loadVersions() {
        if (!ARTIFACT_DATA.chatId) {
          console.log('[Artifacts] Detached: No chat ID, skipping version list load');
          return;
        }
        try {
          const list = await window.electronAPI.getVersionList(ARTIFACT_DATA.chatId);
          if (list && list.artifacts) {
            const artifact = list.artifacts.find(a => a.artifact_id === ARTIFACT_DATA.artifactId);
            if (artifact && artifact.versions) {
              versionsData = artifact.versions.sort((a, b) => b.version - a.version);
              // Fetch running versions before rendering
              await fetchRunningVersions();
              renderVersionMenu();
              updateVersionDisplay();
              console.log('[Artifacts] Detached: Loaded', versionsData.length, 'versions');
            }
          }
        } catch (e) {
          console.error('[Artifacts] Detached: Failed to load versions:', e);
        }
      }

      // Check if attach button should be enabled
      async function checkAttach() {
        try {
          const result = await window.electronAPI.canAttach(ARTIFACT_DATA.chatId, ARTIFACT_DATA.artifactId);
          const btn = document.getElementById('attach-btn');
          btn.disabled = !result.canAttach;
          btn.title = result.canAttach ? 'Attach to Main' : (result.reason || 'Main panel is occupied');
        } catch (e) {
          console.error('[Artifacts] Detached: Failed to check attach:', e);
        }
      }

      // Listen for panel state changes from main window (immediate update when panel closes)
      window.electronAPI.onPanelStateChanged(() => {
        console.log('[Artifacts] Detached: Panel state changed, checking attach status');
        checkAttach();
      });

      // Listen for artifact-open events from backend (server became ready)
      // This handles the case where the window was created before the server was running
      window.electronAPI.onArtifactOpen?.((data) => {
        if (data.artifact_id === ARTIFACT_DATA.artifactId) {
          console.log('[Artifacts] Detached: Received artifact-open for this artifact, reloading webview');
          const url = data.host_port
            ? 'http://localhost:' + data.host_port
            : (data.preview_url || ARTIFACT_DATA.previewUrl);
          if (url) {
            showLoading();
            safeLoadUrl(url);
            ARTIFACT_DATA.previewUrl = url;
          }
        }
      });

      // Initialize - fetch running versions immediately to show correct indicator
      async function init() {
        console.log('[Artifacts] Detached: Initializing with artifactId:', ARTIFACT_DATA.artifactId, 'chatId:', ARTIFACT_DATA.chatId);
        // Fetch running versions first to show correct indicator
        await fetchRunningVersions();
        const initialUrl = isVersionPreviewUrl(ARTIFACT_DATA.previewUrl)
          ? ARTIFACT_DATA.previewUrl
          : (getLiveUrlForCurrentVersion() || ARTIFACT_DATA.previewUrl || getFallbackPreviewUrl());
        if (initialUrl) {
          ARTIFACT_DATA.previewUrl = initialUrl;
          safeLoadUrl(initialUrl);
        } else {
          hideLoading();
        }
        updateVersionDisplay();
        // Then load full version list
        await loadVersions();
        if (Number.isInteger(ARTIFACT_DATA.preferredVersion) &&
          ARTIFACT_DATA.preferredVersion !== ARTIFACT_DATA.currentVersion) {
          console.log('[Artifacts] Detached: Auto-switching to preferred version:', ARTIFACT_DATA.preferredVersion);
          await selectVersion(ARTIFACT_DATA.preferredVersion, { userInitiated: false });
        } else if (!Number.isInteger(ARTIFACT_DATA.preferredVersion) && versionsData.length > 0) {
          const latestVersion = versionsData[0].version;
          if (latestVersion && latestVersion !== ARTIFACT_DATA.currentVersion) {
            console.log('[Artifacts] Detached: Auto-switching to latest version:', latestVersion);
            await selectVersion(latestVersion, { userInitiated: false });
          }
        }
        // Check attach button state
        checkAttach();
      }
      init();
      setInterval(checkAttach, 2000);
    </script>
  </body>
</html>
      `;

        detachedWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        );

        // Notify main window that artifact window was opened
        console.log(
          "[Artifacts] Sending artifact-window-opened event to main window",
        );
        if (windows.main && !windows.main.isDestroyed()) {
          windows.main.webContents.send("artifact-window-opened", {
            artifactId,
            chatId,
            name,
            previewUrl,
            windowId: detachedWindow.id,
          });
          console.log(
            "[Artifacts] artifact-window-opened event sent successfully",
          );
        } else {
          console.log(
            "[Artifacts] Main window not available for artifact-window-opened event",
          );
        }

        console.log(
          `[Artifacts] Detached artifact ${artifactId} to window ${detachedWindow.id}`,
        );
        return { success: true, windowId: detachedWindow.id };
      } catch (error) {
        console.error("[Artifacts] Failed to detach:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Attach (pop back in) artifact from detached window to main panel
  ipcMain.handle("artifact-attach", async (event, { artifactId, chatId }) => {
    try {
      const windowInfo = artifactWindows.get(artifactId);

      if (!windowInfo) {
        console.warn(
          `[Artifacts] Cannot attach - window not found for artifact ${artifactId}`,
        );
        return { success: false, error: "Window not found" };
      }

      const targetChatId = chatId || windowInfo.chatId || null;
      // Per-tab multi-chat gate: docking back into a tab that is showing a
      // tiled layout is refused (windowed-only there); other tabs attach fine.
      if (owuiViews.isMultiChatActiveForChatId(targetChatId)) {
        return {
          success: false,
          error: "Chat tab is tiled (artifacts are windowed-only there)",
          canAttach: false,
        };
      }
      if (windows.main && !windows.main.isDestroyed()) {
        const attachState = await windows.main.webContents.executeJavaScript(
          `window.artifactPanel?.canAttachArtifactToChat?.(${JSON.stringify(targetChatId)}, ${JSON.stringify(artifactId)}) ?? true`,
        );
        if (attachState === false) {
          return {
            success: false,
            error: "Tab artifact panel is occupied",
            canAttach: false,
          };
        }
      }

      // Send signal to main window to open panel
      if (windows.main && !windows.main.isDestroyed()) {
        windows.main.webContents.send("artifact-open", {
          artifact_id: artifactId,
          preview_url: windowInfo.previewUrl,
          name: windowInfo.name,
          chat_id: targetChatId,
          version: windowInfo.currentVersion, // Preserve version from detached window
          reattached: true,
        });
        console.log(
          `[Artifacts] Sent reattach signal for artifact ${artifactId} at version ${windowInfo.currentVersion}`,
        );
      }

      // Close the detached window (this will trigger cleanup via the 'closed' event)
      if (windowInfo.window && !windowInfo.window.isDestroyed()) {
        windowInfo.reattaching = true;
        windowInfo.window.close();
      }

      return { success: true };
    } catch (error) {
      console.error("[Artifacts] Failed to attach:", error);
      return { success: false, error: error.message };
    }
  });

  // Get list of detached artifact windows
  ipcMain.handle("artifact-get-detached-windows", async () => {
    const detachedWindows = [];
    for (const [artifactId, info] of artifactWindows.entries()) {
      if (info.window && !info.window.isDestroyed()) {
        detachedWindows.push({
          artifactId,
          windowId: info.windowId,
          chatId: info.chatId,
          name: info.name,
          previewUrl: info.previewUrl,
        });
      }
    }
    return { success: true, windows: detachedWindows };
  });

  // Check if main panel is currently showing an artifact (for smart Attach button)
  ipcMain.handle("artifact-can-attach", async (event, payload = {}) => {
    console.log(
      "[Artifacts] IPC: artifact-can-attach - checking target tab artifact slot",
    );
    try {
      const artifactId = payload?.artifactId || null;
      const chatId =
        payload?.chatId ||
        (artifactId && artifactWindows.get(artifactId)?.chatId) ||
        null;
      // Per-tab multi-chat gate: the window's Attach button disables while
      // the owning tab is tiled instead of silently failing on click.
      if (owuiViews.isMultiChatActiveForChatId(chatId)) {
        return {
          success: true,
          canAttach: false,
          reason: "Chat tab is tiled (windowed-only)",
        };
      }
      if (windows.main && !windows.main.isDestroyed()) {
        const canAttach = await windows.main.webContents.executeJavaScript(
          `window.artifactPanel?.canAttachArtifactToChat?.(${JSON.stringify(chatId)}, ${JSON.stringify(artifactId)}) ?? true`,
        );
        console.log(`[Artifacts] Target tab can attach: ${canAttach}`);
        return { success: true, canAttach: Boolean(canAttach) };
      }
      return { success: true, canAttach: true };
    } catch (e) {
      console.error("[Artifacts] Error checking panel status:", e);
      return { success: false, canAttach: true, error: e.message };
    }
  });

  // Notify all detached windows of panel state change (called when panel opens/closes)
  // This enables immediate button state updates without polling delay
  ipcMain.handle("artifact-notify-panel-state", async (event, { isOpen, chatId, artifactId }) => {
    console.log(
      `[Artifacts] IPC: artifact-notify-panel-state - panel isOpen: ${isOpen}, chatId: ${chatId}, artifactId: ${artifactId}`,
    );
    try {
      let notified = 0;
      const attachedArtifactId = artifactId || null;
      artifactWindows.forEach((windowInfo) => {
        const win = windowInfo.window || windowInfo;
        if (win && !win.isDestroyed()) {
          win.webContents.send("artifact-panel-state-changed", {
            isOpen,
            chatId,
            artifactId: attachedArtifactId,
          });
          notified++;
        }
      });
      console.log(
        `[Artifacts] Notified ${notified} detached windows of panel state change`,
      );
      return { success: true, notified };
    } catch (e) {
      console.error("[Artifacts] Error notifying detached windows:", e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("window-set-artifact-layout-active", async (event, payload = {}) => {
    try {
      const targetWindow =
        BrowserWindow.fromWebContents(event.sender) ||
        (windows.main && !windows.main.isDestroyed() ? windows.main : null);
      if (!targetWindow || targetWindow.isDestroyed()) {
        return { success: false, error: "Window not available" };
      }

      const active = payload?.active === true;
      const minWidth = Math.max(640, Math.round(Number(payload?.minWidth) || 640));
      const [currentMinWidth, currentMinHeight] = targetWindow.getMinimumSize();
      const nextMinHeight = Math.max(1, Math.round(Number(currentMinHeight) || 700));
      const nextMinWidth = active ? minWidth : 640;

      if (currentMinWidth !== nextMinWidth || currentMinHeight !== nextMinHeight) {
        targetWindow.setMinimumSize(nextMinWidth, nextMinHeight);
      }

      if (active) {
        const bounds = targetWindow.getBounds();
        if (bounds.width < nextMinWidth) {
          targetWindow.setBounds({
            ...bounds,
            width: nextMinWidth,
          });
        }
      }

      return { success: true, minWidth: nextMinWidth, minHeight: nextMinHeight };
    } catch (error) {
      console.error("[Artifacts] Failed to update artifact layout window minimum:", error);
      return { success: false, error: error.message };
    }
  });

  // Sync version state from detached window (when user switches versions in detached window)
  // This ensures re-attach preserves the version that was active in the detached window
  ipcMain.handle(
    "artifact-sync-detached-version",
    async (event, { artifactId, version, userInitiated, previewUrl = null }) => {
      console.log(
        `[Artifacts] Syncing detached window version: artifact ${artifactId} -> v${version}`,
      );
      try {
        const windowInfo = artifactWindows.get(artifactId);
        if (windowInfo) {
          windowInfo.currentVersion = version;
          if (previewUrl) {
            windowInfo.previewUrl = previewUrl;
          }
          console.log(
            `[Artifacts] Updated tracked version for artifact ${artifactId} to v${version}`,
          );
          if (userInitiated && windows.main && !windows.main.isDestroyed()) {
            windows.main.webContents.send("artifact-session-version-selected", {
              artifact_id: artifactId,
              version,
            });
          }
          return { success: true };
        } else {
          console.warn(
            `[Artifacts] Cannot sync version - window not found for artifact ${artifactId}`,
          );
          return { success: false, error: "Window not found" };
        }
      } catch (e) {
        console.error("[Artifacts] Error syncing detached version:", e);
        return { success: false, error: e.message };
      }
    },
  );

  // Close all detached artifact windows for a specific chat
  // Called when user changes chat or starts a new chat
  ipcMain.handle("artifact-close-all-for-chat", async (event, { chatId }) => {
    console.log(`[Artifacts] Closing all detached windows for chat: ${chatId}`);
    let closed = 0;

    for (const [artifactId, info] of artifactWindows.entries()) {
      if (info.chatId === chatId && info.window && !info.window.isDestroyed()) {
        info.window.close(); // This triggers 'closed' event which handles cleanup and menu update
        closed++;
      }
    }

    console.log(
      `[Artifacts] Closed ${closed} detached windows for chat ${chatId}`,
    );
    return { success: true, closed };
  });

  // Get list of artifacts for a chat (proxies to MCP server via MCPO-core)
  ipcMain.handle("artifact-get-list", async (event, { chatId }) => {
    console.log(`[Artifacts] artifact-get-list called for chatId: ${chatId}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const requestBody = { chat_id: chatId, include_all_versions: true };
      console.log(
        "[Artifacts] Calling MCPO-core list_artifacts:",
        JSON.stringify(requestBody),
      );

      // Use MCPO-core (port 8766) with the correct endpoint format
      const response = await fetch(
        "http://localhost:8766/artifacts/artifacts_list_artifacts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );

      clearTimeout(timeout);

      console.log(`[Artifacts] MCPO-core response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Artifacts] MCPO-core error response: ${errorText}`);
        throw new Error(`MCPO-core returned ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      console.log("[Artifacts] MCPO-core result:", JSON.stringify(result));
      return { success: true, artifacts: result.artifacts || [] };
    } catch (error) {
      console.error("[Artifacts] Failed to get list:", error.message);
      // Return empty list on error (MCP server may not be running)
      return { success: true, artifacts: [] };
    }
  });

  // Switch artifact to a different version (restores snapshot and restarts server)
  ipcMain.handle(
    "artifact-switch-version",
    async (event, { artifactId, version }) => {
      try {
        console.log(
          `[Artifacts] Switching artifact ${artifactId} to version ${version}`,
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for version switch

        // Use MCPO-core (port 8766) with the correct endpoint format
        const response = await fetch(
          "http://localhost:8766/artifacts/artifacts_switch_artifact_version",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artifact_id: artifactId, version: version }),
            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`MCPO-core returned ${response.status}`);
        }

        const result = await response.json();
        return result;
      } catch (error) {
        console.error("[Artifacts] Failed to switch version:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Get running versions for an artifact (from server pool)
  ipcMain.handle(
    "artifact-get-running-versions",
    async (event, { artifactId }) => {
      try {
        console.log(
          `[Artifacts] Getting running versions for artifact ${artifactId}`,
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        // Use MCPO-core (port 8766) with the correct endpoint format
        const response = await fetch(
          "http://localhost:8766/artifacts/artifacts_get_artifact_running_versions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artifact_id: artifactId }),
            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`MCPO-core returned ${response.status}`);
        }

        const result = await response.json();
        console.log("[Artifacts] Running versions:", JSON.stringify(result));
        return result;
      } catch (error) {
        console.error("[Artifacts] Failed to get running versions:", error);
        return { success: false, error: error.message, running_versions: [] };
      }
    },
  );

  // Ping servers to check health (for green/gray indicators)
  ipcMain.handle("artifact-ping-servers", async (event, { ports }) => {
    try {
      const results = {};

      // Ping each port in parallel
      const pingPromises = ports.map(async (port) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000); // 2s timeout per ping

          const response = await fetch(`http://localhost:${port}/`, {
            method: "HEAD",
            signal: controller.signal,
          });

          clearTimeout(timeout);
          results[port] = {
            running: response.ok || response.status < 500,
            status: response.status,
          };
        } catch (err) {
          results[port] = { running: false, error: err.message };
        }
      });

      await Promise.all(pingPromises);

      return { success: true, health: results };
    } catch (error) {
      console.error("[Artifacts] Failed to ping servers:", error);
      return { success: false, error: error.message };
    }
  });

  // Smart window management for opening artifacts
  ipcMain.handle(
    "artifact-open-smart",
    async (event, { artifactId, chatId }) => {
      try {
        console.log(
          `[Artifacts] Smart open for artifact ${artifactId}, chat ${chatId}`,
        );

        // Check if window already exists for this artifact
        const detachedWindowsResult = await ipcMain.emit(
          "artifact-get-detached-windows",
        );

        // For now, emit the open-artifact event which the renderer handles
        // The renderer will check if the artifact is already open in a window or panel
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("artifact-smart-open", {
            artifactId,
            chatId,
          });
        }

        return { success: true };
      } catch (error) {
        console.error("[Artifacts] Failed smart open:", error);
        return { success: false, error: error.message };
      }
    },
  );

  console.log("[Artifacts] IPC handlers registered");
}

// ============================================================================
// PREREQUISITES HANDLERS
// ============================================================================

/**
 * Register prerequisites IPC handlers
 * Enables renderer to start/cancel/monitor prerequisites installation
 */
function registerPrerequisitesHandlers() {
  const prerequisitesService = require("./prerequisites-service");
  const { BrowserWindow } = require("electron");

  function normalizeSelectedServerIds(selectedServerIds = []) {
    if (!Array.isArray(selectedServerIds)) {
      return [];
    }

    return [...new Set(
      selectedServerIds
        .map((serverId) => (typeof serverId === "string" ? serverId.trim() : ""))
        .filter(Boolean),
    )];
  }

  function resolvePrereqOptions(event, options = {}) {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    const onboardingMode =
      options.onboardingMode === "basic" || options.onboardingMode === "power"
        ? options.onboardingMode
        : undefined;
    return {
      targetWindow,
      buildNumber:
        typeof options.buildNumber === "string"
          ? options.buildNumber
          : undefined,
      onboardingMode,
      purpose:
        typeof options.purpose === "string" && options.purpose.trim().length > 0
          ? options.purpose.trim()
          : undefined,
      previousFailureCode:
        typeof options.previousFailureCode === "string" && options.previousFailureCode.trim().length > 0
          ? options.previousFailureCode.trim()
          : undefined,
      skipHomebrewAuthOnRetry: options.skipHomebrewAuthOnRetry === true,
      hasHostSelections: options.hasHostSelections === true,
      selectedServerIds: normalizeSelectedServerIds(options.selectedServerIds),
    };
  }

  ipcMain.handle("prerequisites-start-background-prefetch", async (event, options = {}) => {
    try {
      const resolved = resolvePrereqOptions(event, options);
      return await prerequisitesService.prerequisitesStartBackgroundPrefetch(resolved);
    } catch (error) {
      console.error("[IPC] Background prereq prefetch error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prerequisites-resume-interactive", async (event, options = {}) => {
    try {
      const resolved = resolvePrereqOptions(event, options);
      return await prerequisitesService.prerequisitesResumeInteractive(resolved);
    } catch (error) {
      console.error("[IPC] Interactive prereq resume error:", error);
      return { success: false, error: error.message };
    }
  });

  // Backward-compatible alias for older renderer paths.
  ipcMain.handle("prerequisites-run", async (event, options = {}) => {
    try {
      const resolved = resolvePrereqOptions(event, options);
      return await prerequisitesService.prerequisitesResumeInteractive(resolved);
    } catch (error) {
      console.error("[IPC] Prerequisites start error:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prerequisites-get-status", async () => {
    try {
      const status = prerequisitesService.getPrerequisitesStatus();
      return { success: true, ...status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prerequisites-get-detailed-status", async () => {
    try {
      const status = prerequisitesService.getPrerequisitesDetailedStatus();
      return { success: true, ...status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Cancel running prerequisites
  ipcMain.handle("prerequisites-cancel", async () => {
    try {
      await prerequisitesService.cancelPrerequisites();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prerequisites-check-authorize-readiness", async () => {
    try {
      const readiness = await prerequisitesService.checkAuthorizeReadiness();
      return { success: true, ...readiness };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("prerequisites-check-finalize-readiness", async (event, options = {}) => {
    try {
      const readiness = await prerequisitesService.checkFinalizeReadiness(
        resolvePrereqOptions(event, options),
      );
      return { success: true, ...readiness };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log("[Prerequisites] IPC handlers registered");
}

// ============================================================================
// MAIN REGISTRATION FUNCTION
// ============================================================================

/**
 * Register all IPC handlers
 * Call this once during app initialization
 */
function registerServerLifecycleBroadcast() {
  state.serverLifecycleEmitter.on("transition", (event) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send("server-lifecycle-transition", event);
      }
    });
  });

  ipcMain.handle("get-server-lifecycle", (event, serverId) => {
    if (serverId) {
      return state.serverLifecycle.get(serverId) || null;
    }
    return Object.fromEntries(state.serverLifecycle);
  });
}

// ============================================================================
// AI Marketplace IPC handlers (Chat UI + Agent Skills + IPC layers)
// All endpoints are user-action-triggered; no timers/polling.
// ============================================================================

function registerAiMarketplaceHandlers() {
  const aiMarketplaceClient = require("./ai-marketplace-client");
  const aiMarketplaceInstall = require("./ai-marketplace-install");
  const aiMarketplaceOperations = require("./ai-marketplace-operations");
  const aiMarketplaceAgentAccessRepair = require("./ai-marketplace-agent-access-repair");
  const aiMarketplaceLinks = require("./ai-marketplace-agent-links");
  const aiMarketplaceSkillLinks = require("./ai-marketplace-skill-links");
  const marketplaceService = require("./marketplace-service");
  const dockerMcp = require("./docker-mcp");

  function failure(error) {
    const message = error?.message || String(error);
    const code = error?.code || null;
    const status = typeof error?.status === "number" ? error.status : null;
    const body = error?.body !== undefined ? error.body : null;
    const remediation = error?.remediation || null;
    return { success: false, error: message, code, status, remediation, body };
  }

  function marketplaceSecretOptions() {
    return {
      env: process.env,
      managedRoot: process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
      projectRoot: bootstrap.PROJECT_ROOT,
      resourcesPath: process.resourcesPath,
    };
  }

  async function readApiKeyOrNull() {
    try {
      return resolveAiMarketplaceApiKey(marketplaceSecretOptions());
    } catch (error) {
      console.warn(
        "[IPC] resolveAiMarketplaceApiKey failed:",
        error.message,
      );
      return "";
    }
  }

  function normalizeMarketplaceViewerIdentity(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  async function resolveMarketplaceViewerIdentity() {
    try {
      const userResult = await currentUser.get();
      return normalizeMarketplaceViewerIdentity(
        userResult?.sessionSummary?.user?.email || "",
      );
    } catch (error) {
      console.warn(
        `[IPC] Could not resolve marketplace viewer identity: ${error.message}`,
      );
      return "";
    }
  }

  ipcMain.handle("ai-marketplace-search", async (_event, params) => {
    try {
      const viewerEmail = await resolveMarketplaceViewerIdentity();
      const data = await aiMarketplaceClient.search(params || {}, { viewerEmail });
      return { success: true, data };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-get-solution", async (_event, id) => {
    try {
      const viewerEmail = await resolveMarketplaceViewerIdentity();
      const data = await aiMarketplaceClient.getSolution(id, { viewerEmail });
      return { success: true, data };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-get-bundle", async (_event, id) => {
    try {
      const viewerEmail = await resolveMarketplaceViewerIdentity();
      const data = await aiMarketplaceClient.getSolutionBundle(id, { viewerEmail });
      return { success: true, data };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-list-published", async (_event, type = null) => {
    try {
      const data = await aiMarketplaceOperations.listPublished({ type });
      return { success: true, data };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-install", async (_event, id, options = {}) => {
    const marketplaceDiag = require("./marketplace-diagnostics");
    try {
      const progressSolutionId = typeof id === "string" ? id.trim() : id;
      marketplaceDiag.logMarketplaceDiag("install", "request", {
        solutionId: progressSolutionId,
        hasExistingAgentId: Boolean(options?.existingAgentId),
        refreshInstalledSkillId: options?.refreshInstalledSkillId || "",
      });
      const result = await aiMarketplaceOperations.install(id, {
        // Control-plane installs may pop interactive auth (e.g. GitLab PKCE)
        // when a dependency's git marketplace needs it; the agentic HTTP
        // route stays headless and fails such deps per-dependency instead.
        interactiveAuth: true,
        existingAgentId:
          typeof options?.existingAgentId === "string"
            ? options.existingAgentId.trim()
            : "",
        refreshInstalledSkillId:
          typeof options?.refreshInstalledSkillId === "string"
            ? options.refreshInstalledSkillId.trim()
            : "",
        // Sender-scoped per-dependency progress for the install modal.
        // Bounded to one event per dependent skill plus one agent-phase
        // marker per explicit install — no recurring broadcasts.
        onProgress: (event) => {
          try {
            if (!_event.sender.isDestroyed()) {
              _event.sender.send("ai-marketplace-install-progress", {
                solutionId: progressSolutionId,
                ...event,
              });
            }
          } catch {
            // The invoking window is gone; the install itself proceeds.
          }
        },
      });
      marketplaceDiag.logMarketplaceDiag("install", "success", {
        solutionId: progressSolutionId,
        type: result?.type || "",
        mutation: result?.mutation || "",
        agentId: result?.created?.id || "",
        installedSkillCount: Array.isArray(result?.installedSkills)
          ? result.installedSkills.length
          : 0,
        addedMarketplaceIds: Array.isArray(result?.addedMarketplaces)
          ? result.addedMarketplaces.map((entry) => entry?.id).filter(Boolean)
          : [],
      });
      return { success: true, data: result };
    } catch (error) {
      marketplaceDiag.logMarketplaceDiag(
        "install",
        "failure",
        { solutionId: typeof id === "string" ? id.trim() : id, ...marketplaceDiag.safeErrorMeta(error) },
        "error",
      );
      return failure(error);
    }
  });

  // The renderer never computes visibility policy: it forwards the publishing
  // agent's audience (an email array), null for "no agent context", or leaves
  // it undefined; ai-marketplace-acl.js decides the effective allowed_emails.
  const sanitizeAclAudience = (value) =>
    Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string")
      : value === null
        ? null
        : undefined;

  ipcMain.handle("ai-marketplace-publish", async (_event, solutionInput, options = {}) => {
    try {
      console.log("[IPC][ai-marketplace-publish] request", {
        name: solutionInput?.name || "",
        type: solutionInput?.type || "",
        hasBundle: Boolean(solutionInput?.bundle),
        detailUrl: solutionInput?.detail_url || "",
      });
      const { data: publishData, publishStatus } =
        await aiMarketplaceOperations.publishSolution(solutionInput, {
          localAgentId:
            typeof options?.localAgentId === "string"
              ? options.localAgentId.trim()
              : "",
          localSkillId:
            typeof options?.localSkillId === "string"
              ? options.localSkillId.trim()
              : "",
          aclAudience: sanitizeAclAudience(options?.aclAudience),
        });
      console.log("[IPC][ai-marketplace-publish] success", {
        id: publishStatus.id,
        status: publishStatus.status,
        hasBundle: publishStatus.has_bundle,
      });
      return { success: true, data: publishData, publishStatus };
    } catch (error) {
      console.error(
        "[IPC][ai-marketplace-publish] failed",
        JSON.stringify(require("./marketplace-diagnostics").safeErrorMeta(error)),
      );
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-update", async (_event, id, patch, options = {}) => {
    try {
      console.log("[IPC][ai-marketplace-update] request", {
        id,
        name: patch?.name || "",
        type: patch?.type || "",
        hasBundle: Boolean(patch?.bundle),
        detailUrl: patch?.detail_url || "",
      });
      const { data, publishStatus } =
        await aiMarketplaceOperations.updatePublishedSolution(id, patch, {
          localAgentId:
            typeof options?.localAgentId === "string"
              ? options.localAgentId.trim()
              : "",
          localSkillId:
            typeof options?.localSkillId === "string"
              ? options.localSkillId.trim()
              : "",
          aclAudience: sanitizeAclAudience(options?.aclAudience),
        });
      console.log("[IPC][ai-marketplace-update] success", {
        id,
        status: publishStatus.status,
        hasBundle: publishStatus.has_bundle,
      });
      return { success: true, data, publishStatus };
    } catch (error) {
      console.error(
        "[IPC][ai-marketplace-update] failed",
        JSON.stringify({
          id,
          ...require("./marketplace-diagnostics").safeErrorMeta(error),
        }),
      );
      return failure(error);
    }
  });

  ipcMain.handle(
    "ai-marketplace-preflight-publish-listings",
    async (_event, payload = {}) => {
      try {
        const data = await aiMarketplaceOperations.preflightDependentSkillListings({
          solutionIds: Array.isArray(payload?.solutionIds)
            ? payload.solutionIds
            : [],
          aclAudience: sanitizeAclAudience(payload?.aclAudience) ?? null,
        });
        return { success: true, data };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle(
    "ai-marketplace-probe-install-refs",
    async (_event, payload = {}) => {
      try {
        const data = await aiMarketplaceOperations.probeInstallRefVisibility({
          solutionIds: Array.isArray(payload?.solutionIds)
            ? payload.solutionIds
            : [],
        });
        return { success: true, data };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle(
    "ai-marketplace-sync-solution-acl",
    async (_event, id, options = {}) => {
      try {
        const data = await aiMarketplaceOperations.syncSolutionAclForAudience(id, {
          aclAudience: sanitizeAclAudience(options?.aclAudience) ?? null,
          localSkillId:
            typeof options?.localSkillId === "string"
              ? options.localSkillId.trim()
              : "",
        });
        return { success: true, data };
      } catch (error) {
        console.error(
          "[IPC][ai-marketplace-sync-solution-acl] failed",
          JSON.stringify({
            id,
            ...require("./marketplace-diagnostics").safeErrorMeta(error),
          }),
        );
        return failure(error);
      }
    },
  );

  ipcMain.handle("ai-marketplace-delete", async (_event, id) => {
    try {
      const { data } = await aiMarketplaceOperations.deletePublishedSolution(id);
      return { success: true, data };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(
    "ai-marketplace-build-publish-bundle",
    async (_event, args) => {
      try {
        console.log("[IPC][ai-marketplace-build-publish-bundle] request", {
          type: args?.type || "",
          hasAgent: Boolean(args?.agent),
          hasSkill: Boolean(args?.skill),
          hasServer: Boolean(args?.server),
          agentName: args?.agent?.name || "",
          skillName: args?.skill?.name || "",
          serverName:
            args?.server?.name || args?.server?.display_name || args?.server?.id || "",
        });
        const bundle = await aiMarketplaceInstall.buildPublishBundle({
          ...(args || {}),
          projectRoot: bootstrap.PROJECT_ROOT,
        });
        console.log("[IPC][ai-marketplace-build-publish-bundle] success", {
          type: bundle?.type || "",
          payloadName: bundle?.payload?.name || "",
        });
        return { success: true, data: bundle };
      } catch (error) {
        console.error(
          "[IPC][ai-marketplace-build-publish-bundle] failed",
          JSON.stringify(require("./marketplace-diagnostics").safeErrorMeta(error)),
        );
        return failure(error);
      }
    },
  );

  ipcMain.handle("ai-marketplace-has-api-key", async () => {
    try {
      const ok = Boolean(await readApiKeyOrNull());
      return { success: true, hasKey: ok };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-set-api-key", async (_event, value) => {
    try {
      const normalizedValue = String(value || "").trim();
      upsertRuntimeSecret(
        "AI_MARKETPLACE_API_KEY",
        normalizedValue,
        marketplaceSecretOptions(),
      );
      process.env.AI_MARKETPLACE_API_KEY = normalizedValue;
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-clear-api-key", async () => {
    try {
      deleteRuntimeSecret(
        "AI_MARKETPLACE_API_KEY",
        marketplaceSecretOptions(),
      );
      delete process.env.AI_MARKETPLACE_API_KEY;
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-base-url", () => {
    return { success: true, baseUrl: aiMarketplaceClient.getBaseUrl() };
  });

  // ── Local <-> marketplace link registry (State & Persistence layer) ───────
  ipcMain.handle("ai-marketplace-link-list", async () => {
    try {
      const links = await aiMarketplaceLinks.listLinks();
      return { success: true, links };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-link-get", async (_event, localAgentId) => {
    try {
      const link = await aiMarketplaceLinks.getLink(localAgentId);
      return { success: true, link };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-link-clear", async (_event, localAgentId) => {
    try {
      const removed = await aiMarketplaceLinks.clearLink(localAgentId);
      return { success: true, removed };
    } catch (error) {
      return failure(error);
    }
  });

  // Deleted-agent pruning, soft-miss edition: the renderer reports which
  // linked agents the latest inventory read did and did not contain; the
  // store flags/heals/deletes per its confirmation policy (a single missed
  // sighting NEVER deletes — 2026-08-08 access-flap incident).
  ipcMain.handle(
    "ai-marketplace-link-report-sightings",
    async (_event, sightings) => {
      try {
        const result = await aiMarketplaceLinks.applyLinkSightings(
          sightings || {},
        );
        return { success: true, ...result };
      } catch (error) {
        return failure(error);
      }
    },
  );

  // Event-driven "unpublished changes" marker: renderer calls this after a
  // local save of a linked agent that did not sync to the marketplace.
  ipcMain.handle("ai-marketplace-link-mark-dirty", async (_event, localAgentId) => {
    try {
      const link = await aiMarketplaceLinks.markLinkDirty(localAgentId);
      return { success: true, link };
    } catch (error) {
      return failure(error);
    }
  });

  // Update-available baseline: the listing's updated_at as last observed by
  // the session freshness check (or install). Observation-only — never touches
  // lastUpdatedAt or the dirty flag.
  ipcMain.handle(
    "ai-marketplace-link-set-remote-updated-at",
    async (_event, localAgentId, remoteUpdatedAt) => {
      try {
        const link = await aiMarketplaceLinks.setLinkRemoteUpdatedAt(
          localAgentId,
          remoteUpdatedAt,
        );
        return { success: true, link };
      } catch (error) {
        return failure(error);
      }
    },
  );

  // One-shot, user-action-triggered conversion of a self-authored installed
  // Marketplace copy into the author-side editable copy (link flips
  // installed→published; the reconcile pass normalizes the model metas).
  ipcMain.handle("ai-marketplace-reclaim-agent", async (_event, localAgentId) => {
    try {
      const data = await aiMarketplaceOperations.reclaimInstalledAgent(localAgentId);
      return { success: true, data };
    } catch (error) {
      console.error(
        "[IPC][ai-marketplace-reclaim-agent] failed",
        JSON.stringify(require("./marketplace-diagnostics").safeErrorMeta(error)),
      );
      return failure(error);
    }
  });

  // Skills parity: detach a self-authored solutions-installed skill copy into
  // skills-user and relink it to its listing so Published state survives.
  ipcMain.handle("ai-marketplace-reclaim-skill", async (_event, localSkillId) => {
    try {
      const data = await aiMarketplaceOperations.reclaimInstalledSkill(localSkillId);
      return { success: true, data };
    } catch (error) {
      console.error(
        "[IPC][ai-marketplace-reclaim-skill] failed",
        JSON.stringify(require("./marketplace-diagnostics").safeErrorMeta(error)),
      );
      return failure(error);
    }
  });

  ipcMain.handle("ai-marketplace-repair-linked-agent-access", async (_event, options = {}) => {
    try {
      const result = await aiMarketplaceAgentAccessRepair.repairMarketplaceLinkedAgentAccess({
        projectRoot: bootstrap.PROJECT_ROOT,
        reason:
          typeof options?.reason === "string" && options.reason.trim()
            ? options.reason.trim()
            : "ipc",
      });
      // Access just healed → previously invisible foreign agents may have
      // reappeared without their links; force only on an actual repair.
      maybeRunAgentLinkAdoptionSweep({ force: (result?.repaired || 0) > 0 });
      return { success: true, result };
    } catch (error) {
      return failure(error);
    }
  });

  // ── Local <-> marketplace skill link registry ─────────────────────────────
  ipcMain.handle("ai-marketplace-skill-link-get", async (_event, localSkillName) => {
    try {
      const link = await aiMarketplaceSkillLinks.getLink(localSkillName);
      return { success: true, link };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(
    "ai-marketplace-skill-link-set",
    async (_event, localSkillName, solutionId) => {
      try {
        const link = await aiMarketplaceSkillLinks.setLink(
          localSkillName,
          solutionId,
        );
        return { success: true, link };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle(
    "ai-marketplace-skill-link-clear",
    async (_event, localSkillName) => {
      try {
        const removed = await aiMarketplaceSkillLinks.clearLink(localSkillName);
        return { success: true, removed };
      } catch (error) {
        return failure(error);
      }
    },
  );

  // One call per skills load so cards can badge publish state without N
  // per-skill link lookups.
  ipcMain.handle("ai-marketplace-skill-link-list", async () => {
    try {
      const links = await aiMarketplaceSkillLinks.listLinks();
      return { success: true, links };
    } catch (error) {
      return failure(error);
    }
  });

  // Event-driven "unpublished changes" marker: renderer calls this after a
  // local save of a linked skill's contents.
  ipcMain.handle(
    "ai-marketplace-skill-link-mark-dirty",
    async (_event, localSkillName) => {
      try {
        const link = await aiMarketplaceSkillLinks.markLinkDirty(localSkillName);
        return { success: true, link };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle(
    "ai-marketplace-installed-skill-source-get",
    async (_event, localSkillName) => {
      try {
        const source =
          await marketplaceService.getInstalledAiMarketplaceSkillSource({
            projectRoot: bootstrap.PROJECT_ROOT,
            skillId: localSkillName,
          });
        return { success: true, source };
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerAllIpcHandlers() {
  console.log("[IPC] Registering IPC handlers...");

  registerConfigHandlers();
  registerUtilityHandlers();
  registerSetupAuthHandlers();
  registerCurrentUserHandlers();
  registerGitLabMarketplaceAuthHandlers();
  registerOAuthHandlers();
  registerHealthHandlers();
  registerUpdateCheckHandlers();
  registerMcpServerHandlers();
  registerDockerHandlers();
  registerHostMcpoHandlers();
  registerPerServerMcpoHandlers();
  registerWindowHandlers();
  registerOwuiHandlers();
  registerArtifactViewHandlers();
  registerProcessHandlers();
  registerMarketplaceHandlers();
  registerCostReportingHandlers();
  registerDebugHandlers();
  registerWorkspaceHandlers();
  registerArtifactHandlers();
  registerPrerequisitesHandlers();
  registerServerLifecycleBroadcast();
  registerAiMarketplaceHandlers();

  console.log("[IPC] IPC handlers registered successfully");
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main registration function
  registerAllIpcHandlers,

  // Dependency injection
  setHandlerDependencies,

  // Individual registration functions (for selective use)
  registerConfigHandlers,
  registerUtilityHandlers,
  registerSetupAuthHandlers,
  registerCurrentUserHandlers,
  registerGitLabMarketplaceAuthHandlers,
  registerOAuthHandlers,
  registerHealthHandlers,
  registerUpdateCheckHandlers,
  registerMcpServerHandlers,
  registerDockerHandlers,
  registerHostMcpoHandlers,
  registerPerServerMcpoHandlers,
  registerWindowHandlers,
  registerOwuiHandlers,
  registerArtifactViewHandlers,
  registerProcessHandlers,
  registerMarketplaceHandlers,
  registerCostReportingHandlers,
  registerDebugHandlers,
  registerWorkspaceHandlers,
  registerPrerequisitesHandlers,
  registerAiMarketplaceHandlers,

  // Helper function
  scanMcpConfigDirectory,
  ensureBundledMarketplaceDefaultsAtStartup,
  ensureOfficialMarketplaceInstalled,

  _test: {
    notifyNativeInputTerminal,
    openTerminalWithCopiedCommand,
    createKonamiReconcileError,
    getKonamiFailureInfo,
    isKonamiStartupTransientFailure,
    resolveKonamiStartupHydrationFailure,
    createDebouncedReadyInvalidator,
  },
};
