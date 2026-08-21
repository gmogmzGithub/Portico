// Shared state module - centralized mutable state for the main process
// All modules import from this single source of truth to avoid circular dependencies

const { EventEmitter } = require('events');

/**
 * Window references - set by windows.js, accessed by all modules
 */
const windows = {
  main: null,
  chat: null,
  loading: null,
  guidedSetup: null,
  mcpTooltip: null,
  updatePrepTooltip: null,
  artifactVersionMenu: null,
  artifactDividerOverlay: null,
};

/**
 * Host MCPO process management
 */
const hostMcpo = {
  process: null,
  port: 8890,
  logs: [], // Keeps last 1000 lines
  startupPromise: null, // Background health polling promise (non-blocking startup)
  stdoutBuffer: "",
  stderrBuffer: "",
  startup: {
    phase: "idle",
    startedAt: 0,
    deadlineAt: 0,
    lastReadyAt: 0,
    lastExitAt: 0,
  },
};

/**
 * Host MCP Bridge process management
 */
const hostMcpBridge = {
  process: null,
  port: 8891,
  logs: [],
  startupPromise: null,
  stdoutBuffer: "",
  stderrBuffer: "",
  startup: {
    phase: "idle",
    startedAt: 0,
    deadlineAt: 0,
    lastReadyAt: 0,
    lastExitAt: 0,
  },
};

/**
 * Docker status - updated by polling in docker-mcp.js
 */
const dockerStatus = {
  running: false,
  containers: {},
  lastCheck: null,
  healthCheckCompleted: false,
  error: null,
};

/**
 * Health check state
 */
const healthCheck = {
  interval: null,
  lastStatus: null,
};

/**
 * Docker status polling interval ID
 */
let statusCheckInterval = null;

/**
 * Configuration data - loaded from .env and MCP configs
 */
const configData = {
  env: {},
  mcpServers: {},
  selectedServers: [],
  mode: "advanced",
};

/**
 * Application state flags
 */
const appState = {
  isManagerMode: true, // Default to manager mode, not config wizard
  isInitializing: false,
  configurationSaved: false,
  forceRestart: false, // Skip smart startup check when user explicitly requests restart
  currentUpdateInfo: null, // Stores update info during update process for post-restart timestamp saving
  guidedSetupInitialBounds: null,
  currentTheme: 'dark', // Authoritative theme ('dark' | 'light'); defaults to dark on first run
  konamiUnlocked: false,
  mcpRuntimeMutationRelease: null,
};

/**
 * Release the long-lived MCP runtime mutation lease held across a Docker
 * start/restart handoff, if one is outstanding.
 *
 * docker-start / docker-restart acquire the global single-writer lease and
 * park the release closure on appState so it survives past the IPC handler,
 * because the mutation genuinely spans the whole runtime bring-up. Every path
 * that ends that bring-up -- successful initialization, a handoff to guided
 * setup, or the loading window going away -- must call this, or the lease is
 * orphaned and every later MCP mutation fails with MCP_OPERATION_BUSY until
 * the app restarts.
 *
 * Safe to call unconditionally: it is a no-op when no lease is held.
 */
function releasePendingMcpRuntimeMutation(reason = 'unspecified') {
  const release = appState.mcpRuntimeMutationRelease;
  // Clear the slot before invoking so a re-entrant call cannot double-release.
  appState.mcpRuntimeMutationRelease = null;
  if (typeof release !== 'function') {
    return false;
  }
  const released = release() !== false;
  if (released) {
    console.log(
      `[MCP] Released pending runtime mutation lease (reason=${reason})`,
    );
  }
  return released;
}

/**
 * OAuth flow tracking - tracks dismissed flows for LLM-triggered OAuth
 */
const dismissedOAuthFlows = new Set();

/**
 * OAuth wizard completion signals — the renderer notifies the main process
 * when tokens have been persisted for a backend-managed server so the
 * backend polling loop can break out without waiting for the main-stack
 * aggregator (which hasn't been restarted yet).
 */
const completedOAuthFlows = new Set();

/**
 * Active OAuth flow sessions keyed by server ID.
 * Each entry stores the shared result promise for a backend-managed OAuth flow
 * so repeated authorize calls can attach to the existing session instead of
 * failing with FLOW_IN_PROGRESS.
 */
const oauthFlowSessions = new Map();

/**
 * Completed OAuth flow results keyed by flow ID.
 * When a non-blocking OAuth flow finishes, its result is stored here so the
 * Rust handler can poll /api/oauth-flow-status/:flowId to retrieve it.
 * Map<flowId, { serverId, status, result, completedAt }>
 * Entries are cleaned up after 5 minutes.
 */
const oauthFlowResults = new Map();

/**
 * User question flow results keyed by flow ID.
 * Each entry stores the normalized questions, lifecycle timestamps, timeout
 * handle, and the terminal result once the user submits, dismisses, or the
 * flow times out.
 * Map<flowId, { flowId, status, chatId, questions, timeoutSeconds, result, startedAt, completedAt, timeoutHandle, cleanupHandle, ownerWindowId, matchedViewKey, presentation }>
 */
const userQuestionFlowResults = new Map();

/**
 * Tracks active inline user-question flows. Multiple chats/windows can have
 * independent agentic question flows waiting on the user at the same time.
 * `activeFlowId` is kept as a best-effort legacy pointer for older callers.
 */
const userQuestionFlowState = {
  activeFlowIds: new Set(),
  activeFlowId: null,
};

/**
 * Sensitive information flow results keyed by flow ID.
 * Submitted values live only in this process until the backend polls the
 * completed flow, then the entry is replaced with a sanitized consumed result.
 * Map<flowId, { flowId, status, chatId, prompt, label, placeholder, timeoutSeconds, result, startedAt, completedAt, timeoutHandle, cleanupHandle, ownerWindowId, matchedViewKey, presentation }>
 */
const sensitiveInfoFlowResults = new Map();

/**
 * Chat workspace consent flow results keyed by flow ID.
 * Workspace changes are applied only after the renderer reports approval.
 * Map<flowId, { flowId, status, chatId, hostPath, displayPath, timeoutSeconds, result, startedAt, completedAt, timeoutHandle, cleanupHandle, ownerWindowId, matchedViewKey, presentation }>
 */
const chatWorkspaceConsentFlowResults = new Map();

/**
 * AI Marketplace publish confirmation flow results keyed by flow ID.
 * Marketplace writes (publish agent/skill, unpublish) happen only after the
 * renderer modal reports approval.
 * Map<flowId, { flowId, status, mode, agent, summary, result, startedAt, completedAt, timeoutHandle, cleanupHandle, ownerWindowId, presentation }>
 */
const marketplacePublishFlowResults = new Map();

/**
 * Guided setup flow tracking - tracks completion of LLM-triggered server configuration
 * Map<server_id, { success: boolean, timestamp: number }>
 */
const guidedSetupResults = new Map();

/**
 * Guided setup waiters - Promise resolvers for API handlers awaiting setup completion
 * Map<server_id, { resolve: Function }>
 */
const guidedSetupWaiters = new Map();

/**
 * Guided setup success cooldown - prevents re-triggering guided setup immediately after success.
 * Map<server_id, { timestamp: number, readiness_phase: string }>
 */
const guidedSetupSuccessCooldown = new Map();

/**
 * Guided setup launch context - records why the wizard was opened so the
 * renderer can distinguish manual re-entry from required setup flows.
 */
const guidedSetupLaunchContext = {
  source: "unknown",
  trigger: "unknown",
  startedAt: 0,
  setupMode: null,
  setupReason: null,
  setupRequirementId: null,
  safeErrorCode: null,
  setupOperationId: null,
  seedDefaults: false,
};

/**
 * Circuit breaker - tracks consecutive failed flow attempts per server.
 * Rejects further attempts after 2 consecutive failures within a 5-minute window.
 * Map<server_id, { count: number, lastFailedAt: number }>
 */
const failedFlowAttempts = new Map();

/**
 * Permanent session block for servers where contractor permissions denial was
 * shown.  Blocks LLM auto-retries via authorize_integration.  Cleared when the
 * user re-enables the server from the control panel (toggle route).
 * Set<server_id>
 */
const contractorDeniedServers = new Set();

/**
 * Artifact window tracking - tracks detached artifact preview windows
 * Map<artifactId, { windowId, window, chatId, name, previewUrl }>
 */
const artifactWindows = new Map();

/**
 * Conversation window tracking - tracks detached subagent windows
 * Map<conversationId, { windowId, window, url }>
 */
const conversationWindows = new Map();

/**
 * Initialization logging state
 */
const initLogs = {
  file: null, // Current log file path
  stream: null, // File write stream
  saved: [], // Cached init logs for debug collection
  controlPanel: [], // Cached control panel logs
};

/**
 * PORTICO-443: the running address-space telemetry monitor.
 *
 * This binding only supplies the initial null -- the exports object below copies
 * the value once. main.js assigns the live monitor onto `state.addressSpaceMonitor`
 * and debug collection reads it from there. Declared here so that property has a
 * documented home rather than appearing from nowhere.
 */
let addressSpaceMonitor = null;

/**
 * Build information - loaded from build-info.json
 */
const buildInfo = {
  buildNumber: "dev-build",
  date: "unknown",
  fullSha: "unknown",
  channel: "portico",
  timestamp: null,
};

/**
 * Project root path - set during initialization
 * This is the main project directory containing docker-compose.yml, scripts/, etc.
 */
let PROJECT_ROOT = null;

/**
 * Server lifecycle state machine — single source of truth for each server's
 * current phase.  Consumers (readiness endpoint, renderer control panel,
 * Rust polling) read cached state instead of querying the aggregator.
 * Map<server_id, { phase, healthy, updatedAt, deploymentType, flowId, error }>
 */
const serverLifecycle = new Map();
const serverLifecycleEmitter = new EventEmitter();
serverLifecycleEmitter.setMaxListeners(50);

function updateServerPhase(serverId, phase, metadata = {}) {
  const prev = serverLifecycle.get(serverId);
  const incomingRevision = Number.isSafeInteger(metadata.desiredRevision)
    ? metadata.desiredRevision
    : null;
  const incomingSequence = Number.isSafeInteger(metadata.transitionSequence)
    ? metadata.transitionSequence
    : null;
  const previousRevision = Number.isSafeInteger(prev?.desiredRevision)
    ? prev.desiredRevision
    : null;
  const previousSequence = Number.isSafeInteger(prev?.transitionSequence)
    ? prev.transitionSequence
    : null;
  const previousOperationIsActive =
    prev?.operationId &&
    (prev?.operationStatus === "queued" || prev?.operationStatus === "running");
  const isSameSequenceTerminalMetadataRefresh = Boolean(
    prev &&
      previousOperationIsActive &&
      metadata.operationId &&
      metadata.operationId === prev.operationId &&
      incomingRevision !== null &&
      incomingRevision === previousRevision &&
      incomingSequence !== null &&
      incomingSequence === previousSequence &&
      phase === prev.phase &&
      metadata.healthy === prev.healthy &&
      (metadata.error ?? null) === (prev.error ?? null) &&
      (metadata.toolsCount ?? prev.toolsCount ?? 0) ===
        (prev.toolsCount ?? 0) &&
      metadata.operationStatus &&
      !["queued", "running"].includes(metadata.operationStatus),
  );

  // Operation-scoped lifecycle changes are revision owned. A late result from a
  // superseded operation, or an unscoped periodic health sample while an
  // operation owns the server, must not overwrite the user's newer intent.
  if (
    prev &&
    ((incomingRevision !== null &&
      previousRevision !== null &&
      incomingRevision < previousRevision) ||
      (incomingRevision !== null &&
        previousRevision === incomingRevision &&
        metadata.operationId &&
        prev.operationId &&
        metadata.operationId !== prev.operationId) ||
      (incomingRevision !== null &&
        previousRevision === incomingRevision &&
        metadata.operationId === prev.operationId &&
        incomingSequence !== null &&
        previousSequence !== null &&
        incomingSequence <= previousSequence &&
        !isSameSequenceTerminalMetadataRefresh) ||
      (incomingRevision === null &&
        previousOperationIsActive &&
        metadata.allowUnscopedOperationOverride !== true))
  ) {
    return prev;
  }

  if (
    prev &&
    prev.phase === phase &&
    prev.healthy === (metadata.healthy ?? prev.healthy) &&
    prev.error === (metadata.error ?? null) &&
    prev.toolsCount === (metadata.toolsCount ?? prev.toolsCount ?? 0) &&
    prev.operationId === (metadata.operationId ?? prev.operationId ?? null) &&
    prev.desiredRevision ===
      (incomingRevision ?? prev.desiredRevision ?? null) &&
    prev.transitionSequence ===
      (incomingSequence ?? prev.transitionSequence ?? null) &&
    prev.operationStatus ===
      (metadata.operationStatus ?? prev.operationStatus ?? null)
  ) {
    return prev;
  }
  const next = {
    phase,
    healthy: metadata.healthy ?? false,
    updatedAt: Date.now(),
    deploymentType: metadata.deploymentType ?? prev?.deploymentType ?? null,
    flowId: metadata.flowId ?? prev?.flowId ?? null,
    error: metadata.error ?? null,
    toolsCount: metadata.toolsCount ?? prev?.toolsCount ?? 0,
    operationId: metadata.operationId ?? prev?.operationId ?? null,
    desiredRevision: incomingRevision ?? prev?.desiredRevision ?? null,
    transitionSequence: incomingSequence ?? prev?.transitionSequence ?? null,
    operationStatus:
      metadata.operationStatus ?? prev?.operationStatus ?? null,
    targetEnabled: metadata.targetEnabled ?? prev?.targetEnabled ?? null,
    lifecycleSessionId:
      metadata.lifecycleSessionId ?? prev?.lifecycleSessionId ?? null,
    source: metadata.source ?? prev?.source ?? null,
    observedAt: metadata.observedAt ?? prev?.observedAt ?? null,
  };
  serverLifecycle.set(serverId, next);
  const event = { serverId, from: prev?.phase ?? null, to: phase, ...next };
  serverLifecycleEmitter.emit('transition', event);
  return next;
}

function waitForServerPhase(serverId, targetPhases, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const phases = new Set(Array.isArray(targetPhases) ? targetPhases : [targetPhases]);
    const current = serverLifecycle.get(serverId);
    if (current && phases.has(current.phase)) {
      return resolve(current);
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`waitForServerPhase(${serverId}): timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (event) => {
      if (event.serverId === serverId && phases.has(event.to)) {
        cleanup();
        resolve(event);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      serverLifecycleEmitter.off('transition', handler);
    };
    serverLifecycleEmitter.on('transition', handler);
  });
}

function getActiveUserQuestionFlow() {
  const activeIds = userQuestionFlowState.activeFlowIds || new Set();
  for (const flowId of [...activeIds]) {
    const entry = userQuestionFlowResults.get(flowId);
    if (entry && entry.status === 'in_progress') {
      userQuestionFlowState.activeFlowId = flowId;
      return entry;
    }
    activeIds.delete(flowId);
  }

  userQuestionFlowState.activeFlowId = null;
  return null;
}

function startUserQuestionFlow(entry) {
  if (!entry || !entry.flowId) {
    throw new Error('startUserQuestionFlow requires an entry with flowId');
  }

  userQuestionFlowResults.set(entry.flowId, entry);
  if (!userQuestionFlowState.activeFlowIds) {
    userQuestionFlowState.activeFlowIds = new Set();
  }
  userQuestionFlowState.activeFlowIds.add(entry.flowId);
  userQuestionFlowState.activeFlowId = entry.flowId;
  return entry;
}

function setUserQuestionFlowPresentation(flowId, presentation, ownerWindowId = null) {
  const entry = userQuestionFlowResults.get(flowId);
  if (!entry || entry.status !== 'in_progress') {
    return null;
  }
  if (!['visible', 'hidden'].includes(presentation)) {
    throw new Error(`Unsupported user-question presentation: ${presentation}`);
  }
  if (
    ownerWindowId !== null &&
    Number.isFinite(Number(entry.ownerWindowId)) &&
    Number(entry.ownerWindowId) !== Number(ownerWindowId)
  ) {
    return null;
  }
  entry.presentation = presentation;
  return entry;
}

const NATIVE_INPUT_FLOW_KINDS = Object.freeze({
  USER_QUESTION: 'user_question',
  SENSITIVE_INFO: 'sensitive_info',
  CHAT_WORKSPACE_CONSENT: 'chat_workspace_consent',
  MARKETPLACE_PUBLISH: 'marketplace_publish',
});

function nativeInputFlowMap(kind) {
  switch (kind) {
    case NATIVE_INPUT_FLOW_KINDS.USER_QUESTION:
      return userQuestionFlowResults;
    case NATIVE_INPUT_FLOW_KINDS.SENSITIVE_INFO:
      return sensitiveInfoFlowResults;
    case NATIVE_INPUT_FLOW_KINDS.CHAT_WORKSPACE_CONSENT:
      return chatWorkspaceConsentFlowResults;
    case NATIVE_INPUT_FLOW_KINDS.MARKETPLACE_PUBLISH:
      return marketplacePublishFlowResults;
    default:
      return null;
  }
}

function getNativeInputFlow(kind, flowId) {
  return nativeInputFlowMap(kind)?.get(flowId) || null;
}

function setNativeInputFlowPresentation(kind, flowId, presentation, ownerWindowId = null) {
  const entry = getNativeInputFlow(kind, flowId);
  if (!entry || entry.status !== 'in_progress') {
    return null;
  }
  if (!['visible', 'hidden'].includes(presentation)) {
    throw new Error(`Unsupported native-input presentation: ${presentation}`);
  }
  if (
    ownerWindowId !== null &&
    Number.isFinite(Number(entry.ownerWindowId)) &&
    Number(entry.ownerWindowId) !== Number(ownerWindowId)
  ) {
    return null;
  }
  entry.presentation = presentation;
  return entry;
}

function buildNativeInputPresentationSnapshot(ownerWindowId = null) {
  const flows = [];
  for (const [kind, entries] of [
    [NATIVE_INPUT_FLOW_KINDS.USER_QUESTION, userQuestionFlowResults],
    [NATIVE_INPUT_FLOW_KINDS.SENSITIVE_INFO, sensitiveInfoFlowResults],
    [NATIVE_INPUT_FLOW_KINDS.CHAT_WORKSPACE_CONSENT, chatWorkspaceConsentFlowResults],
    [NATIVE_INPUT_FLOW_KINDS.MARKETPLACE_PUBLISH, marketplacePublishFlowResults],
  ]) {
    for (const entry of entries.values()) {
      if (
        !entry ||
        entry.status !== 'in_progress' ||
        (ownerWindowId !== null && Number(entry.ownerWindowId) !== Number(ownerWindowId))
      ) {
        continue;
      }
      const carriesInlineQuestions =
        kind === NATIVE_INPUT_FLOW_KINDS.USER_QUESTION && Array.isArray(entry.questions);
      flows.push({
        kind,
        flow_id: entry.flowId,
        chat_id: entry.chatId,
        presentation: entry.presentation === 'hidden' ? 'hidden' : 'visible',
        item_count: carriesInlineQuestions ? entry.questions.length : 1,
        // PORTICO-348: questions render inline in the owning chat's transcript, so
        // the snapshot carries their content. Only user_question is expanded --
        // sensitive_info and consent flows keep their payloads host-side.
        ...(carriesInlineQuestions
          ? {
              questions: entry.questions.map((question) => ({
                id: question.id,
                header: question.header,
                question: question.question,
                freeform_placeholder: question.freeform_placeholder || null,
                options: Array.isArray(question.options)
                  ? question.options.map((option) => ({
                      id: option.id,
                      label: option.label,
                      description: option.description || '',
                      // Per-option picker seeds: selecting this option reveals
                      // the components prefilled with these ids (an explicit []
                      // entry means "reveal that picker empty").
                      component_defaults:
                        option.component_defaults &&
                        typeof option.component_defaults === 'object' &&
                        !Array.isArray(option.component_defaults)
                          ? option.component_defaults
                          : null,
                    }))
                  : [],
                // PORTICO-348: curated capability pickers (skill / MCP server /
                // model / reasoning effort). Without these the inline card
                // silently drops them and agent-building questions lose their
                // controls entirely.
                components: Array.isArray(question.components)
                  ? question.components.map((component) => ({
                      id: component.id,
                      type: component.type,
                      label: component.label || null,
                      multiple: component.multiple !== false,
                      // Seed applied when the picker shows ungated (or the
                      // revealing option has no component_defaults entry for it).
                      default_selected: Array.isArray(component.default_selected)
                        ? component.default_selected
                        : null,
                    }))
                  : [],
                // Pickers stay hidden until this option is selected.
                components_gated_by_option_id:
                  typeof question.components_gated_by_option_id === 'string' &&
                  question.components_gated_by_option_id
                    ? question.components_gated_by_option_id
                    : null,
              })),
            }
          : {}),
        started_at: Number(entry.startedAt) || 0,
      });
    }
  }
  flows.sort((left, right) => left.started_at - right.started_at);
  return {
    version: 1,
    flows: flows.map(({ started_at: _startedAt, ...flow }) => flow),
  };
}

function completeUserQuestionFlow(flowId, result) {
  const entry = userQuestionFlowResults.get(flowId);
  if (!entry) {
    return null;
  }

  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }

  if (entry.cleanupHandle) {
    clearTimeout(entry.cleanupHandle);
    entry.cleanupHandle = null;
  }

  entry.status = 'completed';
  entry.presentation = 'completed';
  entry.result = result;
  entry.completedAt = Date.now();

  userQuestionFlowState.activeFlowIds?.delete?.(flowId);
  if (userQuestionFlowState.activeFlowId === flowId) {
    const nextActive = userQuestionFlowState.activeFlowIds?.values?.().next?.();
    userQuestionFlowState.activeFlowId =
      nextActive && !nextActive.done ? nextActive.value : null;
  }

  entry.cleanupHandle = setTimeout(() => {
    const current = userQuestionFlowResults.get(flowId);
    if (current && current.cleanupHandle === entry.cleanupHandle) {
      userQuestionFlowResults.delete(flowId);
    }
  }, 5 * 60 * 1000);

  return entry;
}

function startSensitiveInfoFlow(entry) {
  if (!entry || !entry.flowId) {
    throw new Error('startSensitiveInfoFlow requires an entry with flowId');
  }
  sensitiveInfoFlowResults.set(entry.flowId, entry);
  return entry;
}

function completeSensitiveInfoFlow(flowId, result) {
  const entry = sensitiveInfoFlowResults.get(flowId);
  if (!entry) {
    return null;
  }

  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }

  if (entry.cleanupHandle) {
    clearTimeout(entry.cleanupHandle);
    entry.cleanupHandle = null;
  }

  entry.status = 'completed';
  entry.presentation = 'completed';
  entry.result = result;
  entry.completedAt = Date.now();

  entry.cleanupHandle = setTimeout(() => {
    const current = sensitiveInfoFlowResults.get(flowId);
    if (current && current.cleanupHandle === entry.cleanupHandle) {
      sensitiveInfoFlowResults.delete(flowId);
    }
  }, 5 * 60 * 1000);

  return entry;
}

function startChatWorkspaceConsentFlow(entry) {
  if (!entry || !entry.flowId) {
    throw new Error('startChatWorkspaceConsentFlow requires an entry with flowId');
  }
  chatWorkspaceConsentFlowResults.set(entry.flowId, entry);
  return entry;
}

function startMarketplacePublishFlow(entry) {
  if (!entry || !entry.flowId) {
    throw new Error('startMarketplacePublishFlow requires an entry with flowId');
  }
  marketplacePublishFlowResults.set(entry.flowId, entry);
  return entry;
}

function completeMarketplacePublishFlow(flowId, result) {
  const entry = marketplacePublishFlowResults.get(flowId);
  if (!entry) {
    return null;
  }

  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }

  if (entry.cleanupHandle) {
    clearTimeout(entry.cleanupHandle);
    entry.cleanupHandle = null;
  }

  entry.status = 'completed';
  entry.presentation = 'completed';
  entry.result = result;
  entry.completedAt = Date.now();

  entry.cleanupHandle = setTimeout(() => {
    const current = marketplacePublishFlowResults.get(flowId);
    if (current && current.cleanupHandle === entry.cleanupHandle) {
      marketplacePublishFlowResults.delete(flowId);
    }
  }, 5 * 60 * 1000);

  return entry;
}

function completeChatWorkspaceConsentFlow(flowId, result) {
  const entry = chatWorkspaceConsentFlowResults.get(flowId);
  if (!entry) {
    return null;
  }

  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }

  if (entry.cleanupHandle) {
    clearTimeout(entry.cleanupHandle);
    entry.cleanupHandle = null;
  }

  entry.status = 'completed';
  entry.presentation = 'completed';
  entry.result = result;
  entry.completedAt = Date.now();

  entry.cleanupHandle = setTimeout(() => {
    const current = chatWorkspaceConsentFlowResults.get(flowId);
    if (current && current.cleanupHandle === entry.cleanupHandle) {
      chatWorkspaceConsentFlowResults.delete(flowId);
    }
  }, 5 * 60 * 1000);

  return entry;
}

// Export all state
module.exports = {
  // Window references
  windows,

  // Process management
  hostMcpo,
  hostMcpBridge,

  // Status tracking
  dockerStatus,
  healthCheck,
  get statusCheckInterval() {
    return statusCheckInterval;
  },
  set statusCheckInterval(val) {
    statusCheckInterval = val;
  },

  // Configuration
  configData,
  get PROJECT_ROOT() {
    return PROJECT_ROOT;
  },
  set PROJECT_ROOT(val) {
    PROJECT_ROOT = val;
  },

  // App state
  appState,
  releasePendingMcpRuntimeMutation,

  // OAuth
  dismissedOAuthFlows,
  completedOAuthFlows,
  oauthFlowSessions,
  oauthFlowResults,
  userQuestionFlowResults,
  userQuestionFlowState,
  getActiveUserQuestionFlow,
  startUserQuestionFlow,
  setUserQuestionFlowPresentation,
  NATIVE_INPUT_FLOW_KINDS,
  getNativeInputFlow,
  setNativeInputFlowPresentation,
  buildNativeInputPresentationSnapshot,
  completeUserQuestionFlow,
  sensitiveInfoFlowResults,
  startSensitiveInfoFlow,
  completeSensitiveInfoFlow,
  chatWorkspaceConsentFlowResults,
  startChatWorkspaceConsentFlow,
  completeChatWorkspaceConsentFlow,
  marketplacePublishFlowResults,
  startMarketplacePublishFlow,
  completeMarketplacePublishFlow,

  // Guided setup
  guidedSetupLaunchContext,
  guidedSetupResults,
  guidedSetupWaiters,
  guidedSetupSuccessCooldown,

  // Circuit breaker
  failedFlowAttempts,
  contractorDeniedServers,

  // Artifacts
  artifactWindows,
  conversationWindows,

  // Logging
  initLogs,
  addressSpaceMonitor,

  // Build info
  buildInfo,

  // Server lifecycle state machine
  serverLifecycle,
  serverLifecycleEmitter,
  updateServerPhase,
  waitForServerPhase,
};
