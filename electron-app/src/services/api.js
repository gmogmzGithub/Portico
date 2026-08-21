// api.js - Express REST API server for MCP infrastructure management
// Provides endpoints for health checks, MCP restart, OAuth flow coordination,
// and workspace file serving for agent VMs.

const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { app, BrowserWindow, dialog } = require('electron');
const { schedulePostToggleHealthSync } = require('./toggle-health-sync');
const { shouldLogOnlyOnFailure } = require('./api-request-log-policy');
const {
  refreshMcpControlPlane,
  regenerateMcpInfrastructure,
} = require('./mcp-infra-regeneration');
const {
  DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
  DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS,
  resolveEnableToggleLifecycleResult,
  buildStartingToggleReadiness,
  detectToggleEnablePreflightIssue,
  isConfigurationRequiredPreflightIssue,
  isSavedSecretUnavailableIssue,
} = require("./toggle-lifecycle-fast-fail");
const { detectToggleLifecycleNoop } = require("./toggle-lifecycle-noop");
const {
  evaluateHardDisableToggleGate,
  hardDisabledToggleRefusal,
} = require("./mcp-hard-disable-gate");
const {
  buildOAuthDismissedResponse,
  broadcastOAuthFlowCompleted,
  createOAuthRequestLifecycle,
  waitForOAuthFlowOutcome,
  waitForSameServerFlow,
  withTrackedSetupFlow,
} = require("./oauth-flow-lifecycle");
const {
  startOAuthSession,
  waitForOAuthSessionForRequest,
} = require("./oauth-session-manager");
const { waitForToggleFlowGate } = require("./toggle-flow-gating");
const {
  restartHostMcpoWithFreshConfig,
} = require("./host-mcp-lifecycle");
const { getMcpServerLogs } = require("./mcp-server-logs");
const { deleteUserMcpServer } = require("./mcp-server-delete");
const { buildForceRemoveContainerCommand } = require("./docker-compose-command");
const marketplaceService = require("./marketplace-service");
const aiMarketplaceOperations = require("./ai-marketplace-operations");
const aiMarketplaceSkillLinks = require("./ai-marketplace-skill-links");
const agentSkillUsageGuard = require("./agent-skill-usage-guard");
const agentAttributionContext = require("./agent-attribution-context");
const creatorIdentity = require("./creator-identity");
const userSkillService = require("./user-skill-service");
const {
  normalizeUserQuestionRequest,
  buildUserQuestionTimeoutResult,
  buildUserQuestionCancelledResult,
  buildUserQuestionErrorResult,
} = require("./user-question-flows");
const {
  normalizeSensitiveInfoRequest,
  buildSensitiveInfoTimeoutResult,
  buildSensitiveInfoCancelledResult,
} = require("./sensitive-info-flows");
const {
  normalizeChatWorkspaceConsentRequest,
  buildChatWorkspaceConsentTimeoutResult,
  buildChatWorkspaceConsentCancelledResult,
} = require("./chat-workspace-consent-flows");
const {
  MARKETPLACE_PUBLISH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS,
  MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS,
  MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS,
  marketplacePublishDecisionFromResult,
  normalizeMarketplacePublishConfirmRequest,
  buildMarketplacePublishCancelledResult,
  buildMarketplacePublishTimeoutResult,
  buildMarketplacePublishUnknownOutcomeResult,
  buildMarketplacePublishOutcomeBroadcast,
} = require("./marketplace-publish-confirm-flows");
const { resolveMarketplaceAutoApprove } = require("./marketplace-auto-approve");
const {
  sendModalRequestToChatWindow,
} = require("./chat-modal-routing");
const owuiViews = require("./owui-views");
const { collectSystemInformation } = require("./system-info");
const { registerWorkspaceFileRoute } = require("./workspace-file-serving");
const {
  resolveArtifactPreviewFile,
  resolveArtifactVersionPreviewFile,
} = require("./artifact-preview");
const { createRuntimeShellEnv } = require("./runtime-shell-env");
const { listMcpServerCatalog } = require("./mcp-server-catalog");

// Import shared state
const state = require('./shared-state');
const {
  dismissedOAuthFlows,
  completedOAuthFlows,
  guidedSetupResults,
  guidedSetupWaiters,
  guidedSetupSuccessCooldown,
  failedFlowAttempts,
  contractorDeniedServers,
  oauthFlowSessions,
  startUserQuestionFlow,
  completeUserQuestionFlow,
  startSensitiveInfoFlow,
  completeSensitiveInfoFlow,
  startChatWorkspaceConsentFlow,
  completeChatWorkspaceConsentFlow,
  startMarketplacePublishFlow,
  completeMarketplacePublishFlow,
  updateServerPhase,
  serverLifecycle,
} = state;

// Concurrency guard: prevents parallel/duplicate setup and OAuth flows.
// Key = server_id, Value = flow type ('oauth' | 'guided-setup')
const activeSetupFlows = new Map();

// Import bootstrap utilities
const bootstrap = require('./bootstrap');
const { killProcessOnPort, sendInitLog } = bootstrap;
const {
  buildHealthSummary,
  shouldReconcileHealthStatusFromReadiness,
  reconcileHealthStatusFromReadiness,
} = require('./readiness-health-sync');
const {
  disabledReadinessSeed,
  isServerEffectivelyEnabled,
} = require("./readiness-policy");

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
const {
  clearStartupFailure,
  isInstalledMcpServerId,
  loadStartupFailures,
} = require("./mcp-startup-failures");
const {
  getGeneratedMcpConfigStatusForServer,
  isRuntimeFileNotConfiguredStatus,
} = require("./runtime-file-status");
const {
  getOAuthTriggerDisposition,
  serverUsesOAuthConfig,
} = require("./oauth-trigger-policy");
const {
  checkPersistedOAuthTokens,
  clearLegacyOAuthFiles,
  invalidateSecureOAuthRecord,
  loadOAuthRecord,
  migrateLegacyOAuthRecord,
  persistOAuthRecord,
} = require("./oauth-token-storage");
const {
  loadGeneratedMcpServerConfig,
} = require("./oauth-broker-server-config");
const {
  discoverSensitiveRequiredEnvVarDescriptors,
  discoverSensitiveRuntimeFiles,
  readSensitiveRuntimeFilePersistedBytes,
  resolveMcpSensitiveEnvSecrets,
  resolveMcpSensitiveRuntimeFileSecrets,
  sensitiveRuntimeFileSecretName,
} = require("../config/runtime-secrets-config");
const { canonicalizeReadinessPhase } = require("./readiness-phase");
const {
  configureMcpClients,
  detectMcpClients,
  DEFAULT_BRIDGE_URL,
  sanitizeConfigError,
} = require("./host-mcp-bridge-auto-config");
const {
  buildBridgeErrorTelemetry,
  classifyBridgeError,
  emitBridgeClientResultEvents,
  emitBridgeLogRepoEvent,
  summarizeBridgeClientInventory,
  summarizeBridgeClientResults,
} = require("./host-mcp-bridge-telemetry");

// Import docker-mcp functions
const dockerMcp = require('./docker-mcp');
const { runMcpInitialization, queueFullHealthCheck, mutateMcpToggles, runHealthCheckAndBroadcast, checkSingleServerHealth, restartMcpoServer, isHostDeployedServer, isCoreServer, getConfiguredMcpoRuntimeTarget, stopHostMcpo, startHostMcpo, ensureHostMcpBridgeReady, stopHostMcpBridge, readHostMcpBridgePreferences, setHostMcpBridgeDesiredEnabled, checkDockerStatus, executeWithStreaming, broadcastHealthStatusUpdate } = dockerMcp;
const { persistMcpToggleState } = require('./mcp-toggle-persistence');
const mcpOperationService = require('./mcp-operation-service');

// Default API port
const API_PORT = 9876;
const TOOL_READY_TIMEOUT_MS = 30000;
const TOOL_READY_POLL_INTERVAL_MS = 1000;
const AGGREGATOR_REQUEST_TIMEOUT_MS = 3000;
const TOGGLE_ENABLE_READINESS_REQUEST_TIMEOUT_MS = 1000;
const SERVER_READINESS_BULK_ITEM_TIMEOUT_MS = 5000;
const READINESS_PHASE_TOOL_READY = 'tool_ready';
const READINESS_PHASE_STARTING = 'starting';
const READINESS_PHASE_CHECKING_TOKENS = 'checking_tokens';
const READINESS_PHASE_NEEDS_OAUTH = 'needs_oauth';
const READINESS_PHASE_WAITING_CALLBACK = 'waiting_callback';
const READINESS_PHASE_FAILED = 'failed';
const READINESS_PHASE_DISABLED = 'disabled';
const READINESS_PHASE_NOT_CONFIGURED = 'not_configured';
const OAUTH_READY_PHASES = new Set([
  READINESS_PHASE_TOOL_READY,
  READINESS_PHASE_CHECKING_TOKENS,
  READINESS_PHASE_NEEDS_OAUTH,
  READINESS_PHASE_WAITING_CALLBACK,
]);

function mcpOperationClientRequestId(req, prefix) {
  const supplied = String(
    req.body?.clientRequestId ||
      req.body?.client_request_id ||
      req.get?.("x-client-request-id") ||
      "",
  ).trim();
  return supplied || `${prefix}:${randomUUID()}`;
}

function mcpOperationErrorStatus(error) {
  if (error?.code === "MCP_OPERATION_BUSY") return 409;
  if (error?.code === "MCP_OPERATION_NOT_FOUND") return 404;
  if (error?.code === "MCP_OPERATION_COORDINATOR_UNAVAILABLE") return 503;
  if (error?.code === "MCP_OPERATION_WAIT_TIMEOUT") return 504;
  if (error instanceof TypeError) return 400;
  return 500;
}

function sendMcpOperationError(res, error) {
  const activeOperation =
    error?.activeOperation ||
    (error?.code === "MCP_OPERATION_BUSY" &&
    mcpOperationService.hasMcpOperationCoordinator()
      ? mcpOperationService.getActiveMcpOperation()
      : null);
  const operation = error?.operation || activeOperation || null;
  return res.status(mcpOperationErrorStatus(error)).json({
    success: false,
    operationId: error?.operationId || operation?.operationId || null,
    operation,
    activeOperation: activeOperation || undefined,
    activeMutation: error?.activeMutation || undefined,
    results: [],
    errors: [error?.message || String(error)],
    errorCode: error?.code || "MCP_OPERATION_FAILED",
    error: error?.message || String(error),
  });
}

function firstMcpOperationResult(operationResult, serverId) {
  return (
    operationResult.results.find((entry) => entry.serverId === serverId) ||
    operationResult.results[0] ||
    null
  );
}

function operationResultHttpStatus(operationResult) {
  if (operationResult.success) return 200;
  if (operationResult.results.some((entry) => entry.errorCode === "MCP_READINESS_TIMEOUT")) {
    return 504;
  }
  return 500;
}

function startCompatibilityMcpOperation(req, kind, serverIds, options = {}) {
  const operation = mcpOperationService.startMcpOperation({
    clientRequestId: mcpOperationClientRequestId(req, `rest:${kind}`),
    kind,
    serverIds,
    metadata: options.metadata || undefined,
  });
  options.onStarted?.(operation);
  return mcpOperationService.buildLegacyMcpOperationResult(operation);
}

function savedSecretUnavailableToggleResponse(serverId, issue) {
  return {
    success: false,
    operationId: null,
    operation: null,
    results: [],
    errors: [],
    server_id: serverId,
    enabled: true,
    started: false,
    healthy: false,
    readiness_phase: READINESS_PHASE_NOT_CONFIGURED,
    uiStatus: READINESS_PHASE_NOT_CONFIGURED,
    errorCode: issue.errorCode,
    configurationIssue: issue.configurationIssue,
    requiresConfiguration: true,
    requiresSecretReplacement: true,
    requiredAction: issue.requiredAction,
    severity: issue.severity,
    error: issue.error,
    message: issue.message,
    recoveryPrompt: issue.recoveryPrompt,
    recoveryLabel: issue.recoveryLabel,
  };
}

function broadcastMcpRestartComplete(payload) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('mcp-restart-complete', payload);
    }
  });
}

function broadcastMcpRestartCompletionWhenTerminal(operationId) {
  void mcpOperationService
    .waitForMcpOperation(operationId)
    .then((operation) => {
      const result = mcpOperationService.buildLegacyMcpOperationResult(operation);
      broadcastMcpRestartComplete({
        success: result.success,
        operationId,
        error: result.error || undefined,
      });
    })
    .catch((error) => {
      broadcastMcpRestartComplete({
        success: false,
        operationId,
        error: error.message,
      });
    });
}

const CIRCUIT_BREAKER_MAX_FAILURES = 2;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const CONTRACTOR_JIRA_URL = 'https://portico.atlassian.net/secure/CreateIssueDetails!init.jspa?pid=11182&issuetype=11076';

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerTokenFromRequest(req) {
  const value = String(req.headers?.authorization || "").trim();
  if (!value.startsWith("Bearer ")) {
    return "";
  }
  return value.slice("Bearer ".length).trim();
}

function isValidScopedServerId(serverId) {
  return (
    typeof serverId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(serverId) &&
    !serverId.includes("..")
  );
}

function requireElectronBrokerAuth(req, res) {
  const expected = String(process.env.HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN || "").trim();
  if (!expected) {
    res.status(503).json({ success: false, error: "Electron OAuth broker auth is not configured" });
    return false;
  }
  if (!timingSafeStringEqual(bearerTokenFromRequest(req), expected)) {
    res.status(401).json({ success: false, error: "Electron OAuth broker requires a bearer token" });
    return false;
  }
  return true;
}

function normalizeBrokerServerId(req) {
  const serverId = String(req.body?.server_id || "").trim();
  if (!isValidScopedServerId(serverId)) {
    throw new Error("invalid server_id");
  }
  return serverId;
}

function isValidScopedSecretName(secretName) {
  return (
    typeof secretName === "string" &&
    /^[A-Za-z0-9_-]+$/.test(secretName) &&
    !secretName.includes("..")
  );
}

function normalizeBrokerSecretName(req) {
  const secretName = String(req.body?.secret_name || "").trim();
  if (!isValidScopedSecretName(secretName)) {
    throw new Error("invalid secret_name");
  }
  return secretName;
}

function normalizeOAuthBrokerRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("OAuth record is unavailable");
  }
  const token = record.token && typeof record.token === "object"
    ? { ...record.token }
    : {
        access_token: record.access_token,
        token_type: record.token_type,
        expires_in: record.expires_in,
        refresh_token: record.refresh_token,
        scope: record.scope,
        expires_at: record.expires_at || record.expiry || record.expiresAt,
      };
  if (typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw new Error("OAuth access token is unavailable");
  }

  const clientInfoSource =
    record.client_info ||
    record.clientInfo ||
    record.client ||
    record.oauth_client ||
    {};
  const clientInfo = {
    ...clientInfoSource,
  };
  if (!clientInfo.client_id && record.client_id) {
    clientInfo.client_id = record.client_id;
  }
  if (!clientInfo.client_secret && record.client_secret) {
    clientInfo.client_secret = record.client_secret;
  }
  if (!clientInfo.token_endpoint_auth_method && record.token_endpoint_auth_method) {
    clientInfo.token_endpoint_auth_method = record.token_endpoint_auth_method;
  }
  if (!clientInfo.client_id || typeof clientInfo.client_id !== "string") {
    throw new Error("OAuth client metadata is unavailable");
  }

  return {
    token,
    client_info: clientInfo,
  };
}

function resolveStaticSecretBrokerBytes(serverId, secretName) {
  const projectRoot = bootstrap.PROJECT_ROOT;
  const envDescriptor = discoverSensitiveRequiredEnvVarDescriptors({
    projectRoot,
  }).find(
    (descriptor) =>
      descriptor.serverId === serverId && descriptor.secretName === secretName,
  );
  if (envDescriptor) {
    const resolvedSecrets = resolveMcpSensitiveEnvSecrets({
      env: process.env,
      projectRoot,
      resourcesPath: process.resourcesPath,
    });
    const value = String(resolvedSecrets[envDescriptor.key] || "");
    if (!value) {
      throw new Error("static secret is unavailable");
    }
    return Buffer.from(value, "utf8");
  }

  const runtimeFile = discoverSensitiveRuntimeFiles({
    projectRoot,
  }).find(
    (candidate) =>
      candidate.serverId === serverId &&
      sensitiveRuntimeFileSecretName(candidate.serverId, candidate.target) ===
        secretName,
  );
  if (runtimeFile) {
    resolveMcpSensitiveRuntimeFileSecrets({
      env: process.env,
      projectRoot,
    });
    const bytes = readSensitiveRuntimeFilePersistedBytes({
      serverId,
      target: runtimeFile.target,
      env: process.env,
    });
    if (!bytes || bytes.length === 0) {
      throw new Error("static runtime file is unavailable");
    }
    return bytes;
  }

  throw new Error("static secret is not declared for server");
}

function marketplaceErrorStatusCode(errorCode) {
  if (!errorCode) {
    return 500;
  }

  if (
    errorCode === "duplicate_marketplace" ||
    errorCode === "skill_already_installed" ||
    errorCode === "immutable_marketplace" ||
    errorCode === "ootb_skill_immutable" ||
    errorCode === "marketplace_skill_dirty" ||
    errorCode === "skill_in_use_by_agents"
  ) {
    return 409;
  }

  if (errorCode === "agent_inventory_unavailable") {
    return 503;
  }

  if (
    errorCode === "marketplace_not_found" ||
    errorCode === "skill_not_installed"
  ) {
    return 404;
  }

  return 400;
}

function sendMarketplaceError(res, error) {
  return res.status(marketplaceErrorStatusCode(error?.code)).json({
    success: false,
    error: error?.message || "Marketplace request failed",
    ...(error?.code ? { errorCode: error.code } : {}),
    ...(error?.remediation ? { remediation: error.remediation } : {}),
    ...(error?.body !== undefined ? { body: error.body } : {}),
  });
}

// MCP-assistant tool calls expose servers to the LLM with a `server:` prefix
// (e.g. "server:google_workspace") to disambiguate from raw tool names. The
// rest of the Electron app (YAML lookup, appState, readiness, persisted
// tokens) keys off the bare canonical id ("google_workspace"). When LLM-side
// requests reach OAuth/guided-setup endpoints with the prefix still attached,
// downstream lookups silently miss — findServerYaml returns null
// (→ NOT_OAUTH_SERVER), and the renderer's `appState.servers.find(s.id===…)`
// returns nothing (→ guided setup signals success=false → response is shaped
// as `dismissed: true` even though the user never dismissed anything).
//
// Normalize once at the API boundary so every downstream consumer sees the
// canonical id.
const ASSISTANT_SERVER_PREFIX = "server:";
function stripAssistantServerPrefix(id) {
  if (typeof id !== "string") return id;
  return id.startsWith(ASSISTANT_SERVER_PREFIX)
    ? id.slice(ASSISTANT_SERVER_PREFIX.length)
    : id;
}

function normalizeOptionalChatId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeBridgeEnableTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30000;
  }
  return Math.min(parsed, 120000);
}

function uniqueStringArray(values) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeBridgeEnableClientIds(body = {}, clients = []) {
  const explicitIds = Array.isArray(body.clientIds)
    ? body.clientIds
    : Array.isArray(body.client_ids)
      ? body.client_ids
      : [];
  const requested = uniqueStringArray(explicitIds);
  if (requested.length > 0) {
    return requested;
  }

  return clients
    .filter((client) => client?.detected === true || client?.configured === true)
    .map((client) => client.id);
}

async function probeHostMcpBridgeHealth(port = 8891, timeoutMs = 1000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeBridgeClientState(client) {
  return {
    id: client.id,
    displayName: client.displayName,
    detected: client.detected === true,
    configured: client.configured === true,
    selectable: client.selectable === true,
    status: client.status || "unknown",
    statusText: client.statusText || "",
  };
}

function bridgeScriptAction({ bridgeReady, configuredClients, detectedClients }) {
  const hasConfiguredClients = configuredClients.length > 0;
  const hasDetectedClients = detectedClients.length > 0;

  if (bridgeReady && hasConfiguredClients) {
    return "ready";
  }
  if (hasConfiguredClients || hasDetectedClients) {
    return "enable_bridge";
  }
  return "fallback_toolhive";
}

function requireProgrammaticBridgeHeader(req, res) {
  const value = String(req.headers?.["x-portico-programmatic-bridge"] || "").trim().toLowerCase();
  if (value === "1" || value === "true") {
    return true;
  }
  res.status(403).json({
    success: false,
    error:
      "Programmatic Host MCP Bridge configuration requires X-PORTICO-Programmatic-Bridge: 1",
  });
  return false;
}

function currentAppVersion() {
  try {
    return typeof app.getVersion === "function" ? app.getVersion() : "";
  } catch (_) {
    return "";
  }
}

function bridgeRequestCaller(req) {
  return (
    req?.headers?.["x-portico-bridge-caller"] ||
    req?.headers?.["x-portico-caller"] ||
    req?.body?.caller ||
    req?.query?.caller ||
    "unknown"
  );
}

function bridgeRequestTelemetryFields(req, requestSource, extra = {}) {
  const programmaticHeader = String(
    req?.headers?.["x-portico-programmatic-bridge"] || "",
  ).trim().toLowerCase();
  return {
    event_scope: "summary",
    request_source: requestSource,
    caller: bridgeRequestCaller(req),
    programmatic: programmaticHeader === "1" || programmaticHeader === "true",
    app_version: currentAppVersion(),
    bridge_port: state.hostMcpBridge.port,
    ...extra,
  };
}

function logProgrammaticBridgeError(stage, error, requestId) {
  const safeError = sanitizeConfigError(error);
  const errorCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
    ? error.code
    : null;
  console.error("[Host MCP Bridge API] operation failed", JSON.stringify({
    stage,
    requestId,
    errorCategory: classifyBridgeError(safeError),
    errorCode,
    error: safeError,
  }));
  return safeError;
}

function sendBackendModalRequest(channel, payload = {}, options = {}) {
  const chatId = normalizeOptionalChatId(payload.chat_id);
  console.log(
    `[API] Sending ${channel}${chatId ? ` for chat ${chatId}` : " with main-window fallback"}`,
  );
  const result = sendModalRequestToChatWindow({
    channel,
    payload,
    chatId,
    BrowserWindow,
    mainWindow: state.windows.main,
    owuiViews,
    app,
    activateFallback: options.activateFallback !== false,
    allowAlternateFallback: options.allowAlternateFallback !== false,
    logger: console,
  });
  if (result.sent) {
    console.log(
      `[API] Sent ${channel} to window ${result.windowId} via ${result.reason}${result.matchedViewKey ? ` (${result.matchedViewKey})` : ""}`,
    );
  }
  return result;
}


function broadcastOAuthFlowRequested(payload) {
  console.log(
    `[API] Routing oauth-flow-requested${payload.resume_existing ? " (resume existing)" : ""}`,
  );
  sendBackendModalRequest("oauth-flow-requested", payload);
}

function broadcastUserQuestionRequested(payload) {
  console.log(
    `[API] Routing user-question-requested for flow ${payload.flow_id}`,
  );
  return sendBackendModalRequest("user-question-requested", payload, {
    activateFallback: false,
    allowAlternateFallback: false,
  });
}

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

// Shared teardown for native-input flows: completes the flow entry (which
// clears its timers and drops it from the presentation snapshot, unlocking
// the composer), and refreshes the waiting bar.
// Used by both the flow-level timeout handlers and the cancel endpoints that
// the Rust tools call when a tool call errors out or times out early.
// The one teardown body. Each flow family supplies only what differs: the
// results map it lives in, its completion function, and its kind constant.
function terminateNativeInputFlow({ results, complete, kind }, flowId, result) {
  const latest = results.get(flowId);
  if (!latest || latest.status !== "in_progress") {
    return null;
  }
  const ownerWindowId = latest.ownerWindowId;
  complete(flowId, result);
  notifyNativeInputTerminal(ownerWindowId, kind, flowId, result.status);
  broadcastNativeInputPresentationSnapshot(ownerWindowId);
  return latest;
}

function terminateUserQuestionFlow(flowId, result) {
  return terminateNativeInputFlow(
    {
      results: state.userQuestionFlowResults,
      complete: completeUserQuestionFlow,
      kind: state.NATIVE_INPUT_FLOW_KINDS.USER_QUESTION,
    },
    flowId,
    result,
  );
}

function terminateSensitiveInfoFlow(flowId, result) {
  return terminateNativeInputFlow(
    {
      results: state.sensitiveInfoFlowResults,
      complete: completeSensitiveInfoFlow,
      kind: state.NATIVE_INPUT_FLOW_KINDS.SENSITIVE_INFO,
    },
    flowId,
    result,
  );
}

function terminateChatWorkspaceConsentFlow(flowId, result) {
  return terminateNativeInputFlow(
    {
      results: state.chatWorkspaceConsentFlowResults,
      complete: completeChatWorkspaceConsentFlow,
      kind: state.NATIVE_INPUT_FLOW_KINDS.CHAT_WORKSPACE_CONSENT,
    },
    flowId,
    result,
  );
}

function broadcastSensitiveInfoRequested(payload) {
  console.log(
    `[API] Routing sensitive-info-requested for flow ${payload.flow_id}`,
  );
  return sendBackendModalRequest("sensitive-info-requested", payload, {
    activateFallback: false,
  });
}

function terminateMarketplacePublishFlow(flowId, result) {
  const latest = terminateNativeInputFlow(
    {
      results: state.marketplacePublishFlowResults,
      complete: completeMarketplacePublishFlow,
      kind: state.NATIVE_INPUT_FLOW_KINDS.MARKETPLACE_PUBLISH,
    },
    flowId,
    result,
  );
  if (!latest) {
    return null;
  }
  // Publish is the only family with a waiting caller to unblock.
  if (typeof latest.resolveDecision === "function") {
    latest.resolveDecision(marketplacePublishDecisionFromResult(result));
  }
  return latest;
}

function broadcastChatWorkspaceConsentRequested(payload) {
  console.log(
    `[API] Routing chat-workspace-consent-requested for flow ${payload.flow_id}`,
  );
  return sendBackendModalRequest("chat-workspace-consent-requested", payload, {
    activateFallback: false,
  });
}

function broadcastAiMarketplacePublishConfirmRequested(payload) {
  console.log(
    `[API] Routing ai-marketplace-publish-confirm-requested for flow ${payload.flow_id}`,
  );
  return sendBackendModalRequest("ai-marketplace-publish-confirm-requested", payload);
}

// Flow-keyed outcome push for the chat batch modal: after a route continuation
// stashes its final envelope (the poll contract for the MCP proxy), tell the
// renderer the same outcome so approved main-side items (unpublish,
// publish-skill) can hold a busy state and settle with the real result.
// Owner window first (it hosts the modal); all-windows fallback covers a gone
// owner — the modal filters by flow id, so extra deliveries are inert.
function broadcastAiMarketplacePublishOutcome(flowId, envelope) {
  const payload = buildMarketplacePublishOutcomeBroadcast(flowId, envelope);
  if (!payload) {
    return;
  }
  try {
    const entry = state.marketplacePublishFlowResults.get(flowId);
    const ownerWindowId = Number(entry?.ownerWindowId);
    const ownerWindow = Number.isFinite(ownerWindowId)
      ? BrowserWindow.fromId(ownerWindowId)
      : null;
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      ownerWindow.webContents.send("ai-marketplace-publish-outcome", payload);
      return;
    }
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send("ai-marketplace-publish-outcome", payload);
      }
    });
  } catch (error) {
    console.warn(
      "[API] ai-marketplace-publish-outcome broadcast failed:",
      error.message,
    );
  }
}

// Fired after a SUCCESSFUL marketplace write (publish/republish/unpublish) so
// an already-visible control-plane view can drop stale Published badges
// without waiting for the next navigation. One-shot, user-gated events only.
function broadcastMarketplaceLinksChanged(kind) {
  try {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send("marketplace-links-changed", { kind: kind || "unknown" });
      }
    });
  } catch (error) {
    console.warn("[API] marketplace-links-changed broadcast failed:", error.message);
  }
}

function broadcastOwuiModelRefreshRequested(payload = {}) {
  const detail = {
    reason: payload.reason || "model-sync",
    timestamp: Date.now(),
  };
  try {
    owuiViews.broadcastToViews("owui-models-refresh-requested", detail);
  } catch (error) {
    console.warn("[API] Failed to broadcast OWUI model refresh request:", error);
  }
  BrowserWindow.getAllWindows().forEach((window) => {
    try {
      if (!window.isDestroyed() && !window.webContents?.isDestroyed()) {
        window.webContents.send("owui-models-refresh-requested", detail);
      }
    } catch (error) {
      console.warn("[API] Failed to send OWUI model refresh request:", error);
    }
  });
}

function startTrackedOAuthSession(serverId, options) {
  return startOAuthSession(serverId, {
    oauthFlowSessions,
    activeSetupFlows,
    forceAuth: options.forceAuth,
    runSession: () => runTrackedOAuthFlowSession(serverId, options),
    logger: console,
  });
}

function prepareFreshOAuthFlow(serverId) {
  const clearResult = clearLegacyOAuthFiles(serverId, {
    projectRoot: bootstrap.PROJECT_ROOT,
    isCoreServer,
  });
  const tokenFilesCleared = Array.isArray(clearResult.tokenFiles)
    ? clearResult.tokenFiles.length
    : 0;
  const clientFilesCleared = Array.isArray(clearResult.clientFiles)
    ? clearResult.clientFiles.length
    : 0;
  console.log(
    `[API] Prepared fresh OAuth flow for ${serverId}: preservedSecureRecord=true cleared=${clearResult.cleared} tokenFiles=${tokenFilesCleared} clientFiles=${clientFilesCleared} scope=${clearResult.storageScope}`,
  );
  return clearResult;
}

function migrateLegacyOAuthRecordIfNeeded(serverId) {
  const migration = migrateLegacyOAuthRecord(serverId, {
    projectRoot: bootstrap.PROJECT_ROOT,
    isCoreServer,
  });
  if (migration.imported) {
    console.log(
      `[API] Imported legacy OAuth record for ${serverId} into secure storage from ${migration.sourceRoot || "legacy store"}; removedLegacyFiles=${migration.removedLegacyFiles || 0}`,
    );
  }
  return migration;
}

function oauthMigrationRequiresReauth(migration) {
  return (
    migration?.state === "requires_reauth" ||
    migration?.reason === "legacy_oauth_store_requires_reauth"
  );
}

function sendOAuthAuthRequired(res, serverId, details = {}) {
  res.status(428).json({
    success: false,
    auth_required: true,
    server_id: serverId,
    error: "OAuth authorization required",
    reason: details.reason || "secure_record_missing",
    migration_error_class: details.errorClass || undefined,
  });
}

async function attachToOAuthSession(session, req, res) {
  const requestLifecycle = createOAuthRequestLifecycle(req, res, {
    logger: console,
    serverId: session.serverId,
  });

  try {
    const outcome = await waitForOAuthSessionForRequest(session, {
      requestLifecycle,
      pollIntervalMs: 500,
    });

    if (outcome.type === "client_disconnected") {
      console.warn(
        `[API] OAuth waiter disconnected for ${session.serverId}; keeping shared session alive`,
      );
      return;
    }

    if (requestLifecycle.canRespond()) {
      return res.json(outcome.result);
    }
    return;
  } finally {
    requestLifecycle.detach();
  }
}

async function runTrackedOAuthFlowSession(serverId, options) {
  updateServerPhase(serverId, READINESS_PHASE_WAITING_CALLBACK);
  console.log(`[API] Waiting for OAuth wizard completion signal for ${serverId}`);
  const outcome = await waitForOAuthFlowOutcome({
    serverId,
    skipAggregatorPoll: true,
    dismissedOAuthFlows,
    completedOAuthFlows,
    logger: console,
  });

  if (outcome.type === "dismissed") {
    const isContractorDenied = contractorDeniedServers.has(serverId);
    const reason = isContractorDenied ? "contractor_denied" : "dismissed";
    console.log(`[API] OAuth flow ${reason} for ${serverId}`);
    recordFlowFailure(serverId);
    broadcastOAuthFlowCompleted(BrowserWindow.getAllWindows(), {
      server_id: serverId,
      success: false,
      reason,
    });
    if (isContractorDenied) {
      return {
        success: false,
        errorCode: 'CONTRACTOR_PERMISSIONS_DENIED',
        error: `Authorization denied — contractor account lacks required permissions for ${serverId}.`,
        message: `Your contractor account needs additional permissions for ${serverId}. `
          + `To request access, create a Jira ticket here: ${CONTRACTOR_JIRA_URL} `
          + `— or reach out in #help-llm for assistance. `
          + `Once permissions are granted, you can retry.`,
      };
    }
    return buildOAuthDismissedResponse(serverId);
  }

  if (outcome.type === "completed") {
    console.log(`[API] OAuth completed for ${serverId} — running post-auth recovery`);

    // Resolve deploymentType lazily: only needed after OAuth completes for
    // production MCPO cache invalidation and server recovery.
    const deploymentType = await getDeploymentTypeForServer(serverId);

    updateServerPhase(serverId, READINESS_PHASE_CHECKING_TOKENS, { deploymentType });
    clearFlowFailures(serverId);
    broadcastOAuthFlowCompleted(BrowserWindow.getAllWindows(), {
      server_id: serverId,
      success: true,
    });

    const postOauthInvalidate = await invalidateAggregatorCaches(serverId, {
      deploymentType,
      reason: "oauth-complete",
    });
    if (!postOauthInvalidate.success && !postOauthInvalidate.skipped) {
      console.warn(
        `[API] Aggregator cache invalidation failed after OAuth for ${serverId}: ${postOauthInvalidate.error || "unknown error"}`,
      );
    }

    const postOauthReady = await waitForPostOauthServerRecovery(serverId, {
      deploymentType,
      maxWaitMs: TOOL_READY_TIMEOUT_MS,
      pollIntervalMs: TOOL_READY_POLL_INTERVAL_MS,
    });
    safeQueueFullHealthCheck(`oauth-complete:${serverId}`);
    const serverHealthy = Boolean(postOauthReady.healthy);
    const readinessPhase =
      postOauthReady.readinessPhase ||
      (serverHealthy ? READINESS_PHASE_TOOL_READY : READINESS_PHASE_STARTING);
    return {
      success: true,
      completed: true,
      healthy: serverHealthy,
      readiness_phase: readinessPhase,
      server_id: serverId,
      waited_seconds: postOauthReady.waitedSeconds,
      restarted_after_auth: Boolean(postOauthReady.restartedAfterAuth),
      message: serverHealthy
        ? `OAuth authorization completed for ${serverId}. Tools are ready.`
        : `OAuth authorization completed for ${serverId}, but the integration is still not tool-ready after ${postOauthReady.waitedSeconds || 0} seconds.`,
      already_authorized: false,
      ...(postOauthReady.error
        ? { readiness_error: postOauthReady.error }
        : {}),
    };
  }

  if (outcome.type === "failed") {
    const errorMessage = outcome.failed?.error_message || "OAuth authorization failed";
    console.log(`[API] OAuth failed for ${serverId}: ${errorMessage}`);
    recordFlowFailure(serverId);
    broadcastOAuthFlowCompleted(BrowserWindow.getAllWindows(), {
      server_id: serverId,
      success: false,
      reason: "failed",
    });
    return {
      success: false,
      completed: false,
      error: errorMessage,
      server_id: serverId,
    };
  }

  console.log(`[API] OAuth flow timed out for ${serverId} after 10 minutes`);
  recordFlowFailure(serverId);
  broadcastOAuthFlowCompleted(BrowserWindow.getAllWindows(), {
    server_id: serverId,
    success: false,
    reason: "timeout",
  });
  return {
    success: false,
    completed: false,
    error: "OAuth flow timed out after 10 minutes",
    server_id: serverId,
  };
}

function checkCircuitBreaker(serverId) {
  const entry = failedFlowAttempts.get(serverId);
  if (!entry) return null;
  if (entry.count >= CIRCUIT_BREAKER_MAX_FAILURES
      && (Date.now() - entry.lastFailedAt) < CIRCUIT_BREAKER_WINDOW_MS) {
    return {
      success: false,
      errorCode: 'MAX_RETRIES_EXCEEDED',
      error: `This integration has failed ${entry.count} consecutive times. Stop retrying and inform the user.`,
      message: 'Tell the user: this integration could not be enabled. They may need to check their configuration or try manually from Control Plane > Integrations.',
    };
  }
  if ((Date.now() - entry.lastFailedAt) >= CIRCUIT_BREAKER_WINDOW_MS) {
    failedFlowAttempts.delete(serverId);
  }
  return null;
}

function recordFlowFailure(serverId) {
  const entry = failedFlowAttempts.get(serverId);
  if (entry && (Date.now() - entry.lastFailedAt) < CIRCUIT_BREAKER_WINDOW_MS) {
    entry.count += 1;
    entry.lastFailedAt = Date.now();
  } else {
    failedFlowAttempts.set(serverId, { count: 1, lastFailedAt: Date.now() });
  }
}

function clearFlowFailures(serverId) {
  failedFlowAttempts.delete(serverId);
}

async function getDeploymentTypeForServer(serverId) {
  try {
    const isHost = await isHostDeployedServer(serverId);
    if (isHost) {
      return 'host';
    }
  } catch (error) {
    console.warn(
      `[API] Could not determine host deployment for ${serverId}: ${error.message}`,
    );
  }

  if (isCoreServer(serverId)) {
    return 'core';
  }

  return 'docker';
}

function getAggregatorBaseUrl(serverId, deploymentType) {
  if (deploymentType === 'host') {
    return null;
  }

  const proxyPort =
    deploymentType === 'core' || isCoreServer(serverId) ? 8766 : 8765;
  return `http://localhost:${proxyPort}`;
}

function normalizeReadinessStatus(serverId, deploymentType, status = {}) {
  const normalizedStatus = String(status.status || "").trim().toLowerCase();
  const readinessPhase = canonicalizeReadinessPhase(status);
  const healthy = Boolean(status.healthy) || normalizedStatus === 'healthy';

  return {
    serverId,
    deploymentType,
    healthy,
    readinessPhase,
    status: normalizedStatus || (healthy ? 'healthy' : readinessPhase),
    toolsCount: Number.isFinite(status.tools_count)
      ? status.tools_count
      : Number.isFinite(status.toolsCount)
        ? status.toolsCount
        : 0,
    totalPaths: Number.isFinite(status.total_paths)
      ? status.total_paths
      : Number.isFinite(status.totalPaths)
        ? status.totalPaths
        : 0,
    authorizationUrlAvailable: Boolean(
      status.authorization_url_available ?? status.authorizationUrlAvailable,
    ),
    oauthState: status.oauth_state || status.oauthState || null,
    openapiAvailable:
      typeof status.openapi_available === 'boolean'
        ? status.openapi_available
        : typeof status.openapiAvailable === 'boolean'
          ? status.openapiAvailable
          : undefined,
    discovered:
      typeof status.discovered === 'boolean' ? status.discovered : undefined,
    proxyProbeOk:
      typeof status.proxy_probe_ok === 'boolean'
        ? status.proxy_probe_ok
        : typeof status.proxyProbeOk === 'boolean'
          ? status.proxyProbeOk
          : undefined,
    proxyProbeStatus:
      status.proxy_probe_status ?? status.proxyProbeStatus ?? null,
    proxyProbeToolPath:
      status.proxy_probe_tool_path ?? status.proxyProbeToolPath ?? null,
    proxyProbeError:
      status.proxy_probe_error ?? status.proxyProbeError ?? null,
    toolName: status.toolName,
    probeStatus: status.probeStatus,
    startupFailure: status.startup_failure || status.startupFailure || null,
    startupFailureSource:
      status.startup_failure_source || status.startupFailureSource || null,
    startupFailureStage:
      status.startup_failure_stage || status.startupFailureStage || null,
    startupFailureTimestamp:
      status.startup_failure_timestamp ||
      status.startupFailureTimestamp ||
      null,
    configPath: status.config_path || status.configPath || null,
    containerName: status.container_name || status.containerName || null,
    error: status.error,
  };
}

function disabledReadinessStatus(serverId, deploymentType) {
  return normalizeReadinessStatus(
    serverId,
    deploymentType,
    disabledReadinessSeed(),
  );
}


function formatElapsedSeconds(elapsedMs) {
  return Number((Math.max(0, elapsedMs) / 1000).toFixed(1));
}

function getHealthStatusFilePath() {
  const projectRoot =
    bootstrap.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
  return path.join(projectRoot, 'health-status', 'health_status.json');
}

function getLoopbackPortForDeployment(deploymentType) {
  if (deploymentType === 'host') {
    return 8890;
  }
  if (deploymentType === 'core') {
    return 8766;
  }
  return 8765;
}

async function syncHealthStatusFileFromReadinessEntries(entries) {
  const filteredEntries = (entries || []).filter(([serverId, status]) => {
    return (
      serverId &&
      shouldReconcileHealthStatusFromReadiness(status, {
        toolReadyPhase: READINESS_PHASE_TOOL_READY,
      })
    );
  });
  if (filteredEntries.length === 0) {
    return null;
  }
  const healthStatusFile = getHealthStatusFilePath();
  let raw;
  try {
    raw = await fsPromises.readFile(healthStatusFile, 'utf8');
  } catch {
    return null;
  }

  let nextData = JSON.parse(raw);
  for (const [serverId, status] of filteredEntries) {
    const deploymentType = status.deploymentType || status.deployment_type;
    nextData = reconcileHealthStatusFromReadiness(serverId, status, {
      healthData: nextData,
      host: 'localhost',
      port: getLoopbackPortForDeployment(deploymentType),
      toolReadyPhase: READINESS_PHASE_TOOL_READY,
    });
    if (!nextData) {
      return null;
    }
  }

  if (!nextData) {
    return null;
  }

  nextData.summary = buildHealthSummary(nextData.servers);
  await fsPromises.writeFile(healthStatusFile, JSON.stringify(nextData, null, 2), 'utf8');

  try {
    broadcastHealthStatusUpdate(nextData, { mode: 'readiness-sync' });
  } catch (_) {}

  return nextData;
}

async function syncHealthStatusFileFromReadiness(serverId, status) {
  return syncHealthStatusFileFromReadinessEntries([[serverId, status]]);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message || 'timeout')), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function isReadinessVisibleForStartup(status = {}) {
  const toolsCount = Number.isFinite(status.toolsCount)
    ? status.toolsCount
    : Number.isFinite(status.tools_count)
      ? status.tools_count
      : 0;
  const totalPaths = Number.isFinite(status.totalPaths)
    ? status.totalPaths
    : Number.isFinite(status.total_paths)
      ? status.total_paths
      : 0;

  if (
    status.deploymentType === 'host' ||
    status.deployment_type === 'host'
  ) {
    return true;
  }

  return (
    status.discovered === true ||
    status.openapiAvailable === true ||
    status.openapi_available === true ||
    toolsCount > 0 ||
    totalPaths > 0 ||
    status.probeStatus != null ||
    status.proxyProbeStatus != null ||
    status.proxy_probe_status != null ||
    status.proxyProbeError != null ||
    status.proxy_probe_error != null
  );
}

function isVisibleWaitableStartup(status = {}) {
  const readinessPhase = canonicalizeReadinessPhase(status);
  return (
    isReadinessVisibleForStartup(status) &&
    (readinessPhase === READINESS_PHASE_STARTING ||
      readinessPhase === READINESS_PHASE_CHECKING_TOKENS)
  );
}

function shouldRestartAfterOauth(status = {}) {
  const readinessPhase = canonicalizeReadinessPhase(status);
  const oauthState = status.oauthState || status.oauth_state || null;
  const authorizationUrlAvailable = Boolean(
    status.authorizationUrlAvailable ?? status.authorization_url_available,
  );

  if (isVisibleWaitableStartup(status)) {
    return true;
  }

  return (
    readinessPhase === READINESS_PHASE_NEEDS_OAUTH ||
    readinessPhase === READINESS_PHASE_WAITING_CALLBACK ||
    (readinessPhase === READINESS_PHASE_FAILED &&
      (oauthState === 'failed' || oauthState === 'timeout')) ||
    status.status === READINESS_PHASE_NEEDS_OAUTH ||
    status.status === READINESS_PHASE_WAITING_CALLBACK ||
    status.status === 'timeout' ||
    (authorizationUrlAvailable &&
      (oauthState === 'active' || oauthState === 'waiting_callback')) ||
    status.error === 'not_discovered' ||
    status.status === 'unavailable' ||
    status.error === 'aggregator_unavailable'
  );
}

async function invalidateAggregatorCaches(serverId, options = {}) {
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));
  const aggregatorBaseUrl = getAggregatorBaseUrl(serverId, deploymentType);

  if (!aggregatorBaseUrl) {
    return {
      success: false,
      skipped: true,
      deploymentType,
      serverId,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGGREGATOR_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${aggregatorBaseUrl}/internal/cache/invalidate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: serverId,
          reason: options.reason || 'api',
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return {
        success: false,
        deploymentType,
        serverId,
        error: `http_${response.status}`,
      };
    }

    return {
      success: true,
      deploymentType,
      serverId,
      ...(await response.json()),
    };
  } catch (error) {
    return {
      success: false,
      deploymentType,
      serverId,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const OAUTH_RELOAD_TIMEOUT_MS = 30_000;
const POST_OAUTH_RECORD_VISIBILITY_TIMEOUT_MS = 3_000;
const POST_OAUTH_RECORD_VISIBILITY_POLL_MS = 250;

async function waitForOAuthRecordVisible(serverId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : POST_OAUTH_RECORD_VISIBILITY_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs)
    ? options.pollMs
    : POST_OAUTH_RECORD_VISIBILITY_POLL_MS;
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start <= timeoutMs) {
    try {
      const record = loadOAuthRecord(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
      });
      if (record) {
        normalizeOAuthBrokerRecord(record);
        return {
          visible: true,
          waitedMs: Date.now() - start,
        };
      }
      lastError = "secure OAuth record missing";
    } catch (error) {
      lastError = error?.message || String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    visible: false,
    waitedMs: Date.now() - start,
    error: lastError || "secure OAuth record unavailable",
  };
}

async function reloadOAuthTokens(serverId, deploymentType) {
  const aggregatorBaseUrl = getAggregatorBaseUrl(serverId, deploymentType);
  if (!aggregatorBaseUrl) {
    return { success: false, error: 'no_aggregator', elapsedMs: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OAUTH_RELOAD_TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(
      `${aggregatorBaseUrl}/oauth/reload/${encodeURIComponent(serverId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      },
    );

    const elapsedMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `http_${response.status}`, detail: text, elapsedMs };
    }

    const body = await response.json();
    return { ...body, elapsedMs };
  } catch (error) {
    return {
      success: false,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
      elapsedMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function syncLifecycleFromReadiness(serverId, normalized) {
  updateServerPhase(serverId, normalized.readinessPhase, {
    healthy: normalized.healthy,
    deploymentType: normalized.deploymentType,
    toolsCount: normalized.toolsCount,
    error: normalized.error,
  });
}

function getPersistedStartupFailure(serverId) {
  try {
    const projectRoot =
      bootstrap.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
    if (!isInstalledMcpServerId(projectRoot, serverId, { logger: console })) {
      clearStartupFailure(projectRoot, serverId, { logger: console });
      return null;
    }
    const generatedConfigStatus = getGeneratedMcpConfigStatusForServer(
      projectRoot,
      serverId,
      { logger: console },
    );
    if (isRuntimeFileNotConfiguredStatus(generatedConfigStatus)) {
      clearStartupFailure(projectRoot, serverId, { logger: console });
      return null;
    }
    return loadStartupFailures(projectRoot, { logger: console })[serverId] || null;
  } catch (error) {
    console.warn(
      `[API] Could not load startup failure for ${serverId}: ${error.message}`,
    );
    return null;
  }
}

function startupFailureReadinessStatus(serverId, deploymentType, failure) {
  const phase = failure.stage === 'timeout' ? 'timeout' : READINESS_PHASE_FAILED;
  return normalizeReadinessStatus(serverId, deploymentType, {
    healthy: false,
    readiness_phase: phase,
    status: phase,
    error: failure.error || 'Startup failed',
    startup_failure: failure,
    startup_failure_source: failure.source || 'runtime',
    startup_failure_stage: failure.stage || phase,
    startup_failure_timestamp: failure.timestamp || null,
    config_path: failure.configPath || null,
    container_name: failure.containerName || null,
  });
}

async function getServerReadinessStatus(serverId, options = {}) {
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));
  const dockerMcpImpl = options.dockerMcpImpl || dockerMcp;
  const assumeEnabled = options.assumeEnabled === true;

  const startupFailure = getPersistedStartupFailure(serverId);
  if (startupFailure) {
    const result = startupFailureReadinessStatus(
      serverId,
      deploymentType,
      startupFailure,
    );
    syncLifecycleFromReadiness(serverId, result);
    return result;
  }

  if (!assumeEnabled && !isServerEffectivelyEnabled(serverId, dockerMcpImpl)) {
    const result = disabledReadinessStatus(serverId, deploymentType);
    syncLifecycleFromReadiness(serverId, result);
    return result;
  }

  // Fast path: return cached lifecycle state when it is fresh enough.
  // This avoids hitting the aggregator on every 250ms–2s poll from Rust/renderer.
  const LIFECYCLE_CACHE_FRESH_MS = 3000;
  const cached = serverLifecycle.get(serverId);
  if (
    cached &&
    cached.phase &&
    Date.now() - cached.updatedAt < LIFECYCLE_CACHE_FRESH_MS &&
    !options.skipCache
  ) {
    return normalizeReadinessStatus(serverId, deploymentType, {
      healthy: cached.healthy,
      readiness_phase: cached.phase,
      status: cached.healthy ? 'healthy' : cached.phase,
      tools_count: cached.toolsCount,
      error: cached.error,
    });
  }

  if (deploymentType === 'host') {
    try {
      const healthResult = await checkSingleServerHealth(serverId, deploymentType);
      const result = normalizeReadinessStatus(serverId, deploymentType, {
        healthy: Boolean(healthResult?.healthy),
        readiness_phase: healthResult?.healthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING,
        status: healthResult?.healthy ? 'healthy' : 'starting',
        tools_count: healthResult?.toolsCount,
        total_paths: healthResult?.totalPaths,
        toolName: healthResult?.toolName,
        probeStatus: healthResult?.probeStatus,
        error: healthResult?.error,
      });
      syncLifecycleFromReadiness(serverId, result);
      return result;
    } catch (error) {
      const result = normalizeReadinessStatus(serverId, deploymentType, {
        healthy: false,
        readiness_phase: READINESS_PHASE_STARTING,
        status: 'starting',
        error: error.message,
      });
      syncLifecycleFromReadiness(serverId, result);
      return result;
    }
  }

  const aggregatorBaseUrl = getAggregatorBaseUrl(serverId, deploymentType);
  if (!aggregatorBaseUrl) {
    const result = normalizeReadinessStatus(serverId, deploymentType, {
      healthy: false,
      readiness_phase: READINESS_PHASE_STARTING,
      status: 'starting',
      error: 'aggregator_unavailable',
    });
    syncLifecycleFromReadiness(serverId, result);
    return result;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(options.requestTimeoutMs)
      ? options.requestTimeoutMs
      : AGGREGATOR_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${aggregatorBaseUrl}/servers/${encodeURIComponent(serverId)}/status`,
      { signal: controller.signal },
    );

    if (response.ok) {
      const normalized = normalizeReadinessStatus(
        serverId,
        deploymentType,
        await response.json(),
      );
      syncLifecycleFromReadiness(serverId, normalized);
      if (options.syncHealthStatus !== false) {
        try {
          await syncHealthStatusFileFromReadiness(serverId, normalized);
        } catch (syncError) {
          console.warn(
            `[API] Could not sync health status file from readiness for ${serverId}: ${syncError.message}`,
          );
        }
      }
      return normalized;
    }

    if (response.status === 404) {
      const result = normalizeReadinessStatus(serverId, deploymentType, {
        healthy: false,
        readiness_phase: READINESS_PHASE_STARTING,
        status: 'starting',
        error: 'not_discovered',
      });
      syncLifecycleFromReadiness(serverId, result);
      return result;
    }

    const result = normalizeReadinessStatus(serverId, deploymentType, {
      healthy: false,
      readiness_phase: READINESS_PHASE_STARTING,
      status: 'starting',
      error: `http_${response.status}`,
    });
    syncLifecycleFromReadiness(serverId, result);
    return result;
  } catch (error) {
    const result = normalizeReadinessStatus(serverId, deploymentType, {
      healthy: false,
      readiness_phase: READINESS_PHASE_STARTING,
      status: 'starting',
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    });
    syncLifecycleFromReadiness(serverId, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerReadinessPhase(
  serverId,
  acceptablePhases,
  options = {},
) {
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? options.maxWaitMs
    : TOOL_READY_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : TOOL_READY_POLL_INTERVAL_MS;
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));
  const phases = new Set(
    (acceptablePhases || [READINESS_PHASE_TOOL_READY]).filter(Boolean),
  );
  const requiredConsecutiveMatches = Number.isFinite(
    options.requiredConsecutiveMatches,
  )
    ? Math.max(1, Math.trunc(options.requiredConsecutiveMatches))
    : phases.size === 1 && phases.has(READINESS_PHASE_TOOL_READY)
      ? 2
      : 1;
  const startTime = Date.now();
  let consecutiveMatches = 0;
  let lastMatchedPhase = null;
  let lastStatus = normalizeReadinessStatus(serverId, deploymentType, {
    healthy: false,
    readiness_phase: READINESS_PHASE_STARTING,
    status: 'starting',
  });

  console.log(
    `[API] Waiting for ${serverId} readiness phases (${[...phases].join(', ')}) (deployment=${deploymentType}, max ${maxWaitMs}ms, consecutive=${requiredConsecutiveMatches})...`,
  );

  while (Date.now() - startTime < maxWaitMs) {
    const status = await getServerReadinessStatus(serverId, {
      deploymentType,
    });
    lastStatus = status;

    if (phases.has(status.readinessPhase)) {
      consecutiveMatches =
        status.readinessPhase === lastMatchedPhase
          ? consecutiveMatches + 1
          : 1;
      lastMatchedPhase = status.readinessPhase;
      console.log(
        `[API] ${serverId} readiness phase ${status.readinessPhase} matched ${consecutiveMatches}/${requiredConsecutiveMatches} after ${Date.now() - startTime}ms`,
      );
      if (consecutiveMatches >= requiredConsecutiveMatches) {
        return {
          ...status,
          elapsedMs: Date.now() - startTime,
          matched: true,
        };
      }
    } else {
      if (status.readinessPhase === READINESS_PHASE_DISABLED) {
        console.log(
          `[API] ${serverId} is disabled — exiting readiness poll early (use toggle_integration to enable)`,
        );
        return {
          ...status,
          elapsedMs: Date.now() - startTime,
          matched: false,
          error: 'Server is disabled. Call toggle_integration to enable it first.',
        };
      }
      if (status.readinessPhase === READINESS_PHASE_FAILED) {
        console.log(
          `[API] ${serverId} has failed — exiting readiness poll early`,
        );
        return {
          ...status,
          elapsedMs: Date.now() - startTime,
          matched: false,
          error: 'Server has failed. It will not recover without a restart.',
        };
      }
      if (consecutiveMatches > 0) {
        console.log(
          `[API] ${serverId} readiness phase reset after ${consecutiveMatches} match(es): ${status.readinessPhase}`,
        );
      }
      consecutiveMatches = 0;
      lastMatchedPhase = null;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    ...lastStatus,
    elapsedMs: Date.now() - startTime,
    matched: false,
    error: lastStatus?.error || 'timeout',
  };
}

function safeQueueFullHealthCheck(reason) {
  try {
    queueFullHealthCheck(reason, { immediate: true });
  } catch (error) {
    console.warn(
      `[API] Failed to queue full health check (${reason}): ${error.message}`,
    );
  }
}

async function waitForServerToolReadySafely(serverId, options = {}) {
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));

  try {
    let readyResult = await waitForServerReadinessPhase(
      serverId,
      [READINESS_PHASE_TOOL_READY],
      {
        deploymentType,
        maxWaitMs: Number.isFinite(options.maxWaitMs)
          ? options.maxWaitMs
          : TOOL_READY_TIMEOUT_MS,
        pollIntervalMs: Number.isFinite(options.pollIntervalMs)
          ? options.pollIntervalMs
          : TOOL_READY_POLL_INTERVAL_MS,
      },
    );

    return {
      ...readyResult,
      deploymentType,
      readinessPhase:
        readyResult.readinessPhase ||
        (readyResult.healthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING),
    };
  } catch (error) {
    console.warn(
      `[API] Error waiting for ${serverId} tool readiness: ${error.message}`,
    );
    return {
      healthy: false,
      deploymentType,
      readinessPhase: READINESS_PHASE_STARTING,
      error: error.message,
    };
  }
}

async function waitForPostOauthServerRecovery(serverId, options = {}) {
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? options.maxWaitMs
    : TOOL_READY_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : TOOL_READY_POLL_INTERVAL_MS;
  const startTime = Date.now();

  const recordVisibility = await waitForOAuthRecordVisible(serverId);
  if (recordVisibility.visible) {
    console.log(
      `[API] ${serverId} secure OAuth record visible after callback in ${recordVisibility.waitedMs}ms; starting post-auth recovery`,
    );
  } else {
    console.warn(
      `[API] ${serverId} secure OAuth record was not visible after ${recordVisibility.waitedMs}ms during post-auth recovery: ${recordVisibility.error || 'unknown error'}`,
    );
  }

  const reloadResult = await reloadOAuthTokens(serverId, deploymentType);

  if (reloadResult.success && reloadResult.reloaded) {
    console.log(
      `[API] ${serverId} OAuth token hot-reload succeeded in ${reloadResult.elapsedMs}ms; waiting for tool readiness`,
    );

    await invalidateAggregatorCaches(serverId, {
      deploymentType,
      reason: 'oauth-token-reload',
    });

    const readyAfterReload = await waitForServerToolReadySafely(serverId, {
      deploymentType,
      maxWaitMs: Math.max(pollIntervalMs, maxWaitMs - (reloadResult.elapsedMs || 0)),
      pollIntervalMs,
    });

    return {
      serverId,
      deploymentType,
      healthy: Boolean(readyAfterReload.healthy),
      readinessPhase:
        readyAfterReload.readinessPhase ||
        (readyAfterReload.healthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING),
      error: readyAfterReload.error,
      waitedSeconds: formatElapsedSeconds(Date.now() - startTime),
      restartedAfterAuth: false,
      mode: 'hot-reload',
    };
  }

  console.log(
    `[API] ${serverId} OAuth hot-reload not available during post-auth recovery (${reloadResult.error || 'reload_not_supported'}); checking current readiness`,
  );

  const quickCheck = await waitForServerToolReadySafely(serverId, {
    deploymentType,
    maxWaitMs: Math.min(5000, maxWaitMs),
    pollIntervalMs,
  });

  if (quickCheck.healthy) {
    return {
      ...quickCheck,
      deploymentType,
      waitedSeconds: formatElapsedSeconds(Date.now() - startTime),
      restartedAfterAuth: false,
    };
  }

  if (shouldRestartAfterOauth(quickCheck)) {
    const elapsedSoFar = Date.now() - startTime;
    const remainingMs = Math.max(pollIntervalMs, maxWaitMs - elapsedSoFar);

    console.warn(
      `[API] ${serverId} still recovering after OAuth (phase=${quickCheck.readinessPhase || 'unknown'}); restarting container`,
    );

    const restartResult = await restartServerAndWaitReady(serverId, {
      deploymentType,
      restartReason: 'oauth-complete-recovery',
      healthReason: `oauth-complete-recovery:${serverId}`,
      maxWaitMs: remainingMs,
      pollIntervalMs,
    });

    return {
      serverId,
      deploymentType,
      healthy: Boolean(restartResult.healthy),
      readinessPhase:
        restartResult.readinessPhase ||
        (restartResult.healthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING),
      error: restartResult.error || restartResult.readinessError,
      waitedSeconds: formatElapsedSeconds(Date.now() - startTime),
      restartedAfterAuth: true,
      mode: restartResult.mode,
    };
  }

  return {
    ...quickCheck,
    deploymentType,
    waitedSeconds: formatElapsedSeconds(Date.now() - startTime),
    restartedAfterAuth: false,
  };
}

async function restartServerAndWaitReady(serverId, options = {}) {
  const deploymentType =
    options.deploymentType || (await getDeploymentTypeForServer(serverId));
  const restartReason = options.restartReason || 'restart-mcp-server';
  const healthReason = options.healthReason || restartReason;
  let releaseMutation = null;

  try {
    if (mcpOperationService.hasMcpOperationCoordinator()) {
      releaseMutation = mcpOperationService.acquireMcpMutationLease({
        kind: 'restart_mcp_server',
        source: restartReason,
      });
    }
    const restartResult = await restartMcpoServer(serverId);
    if (!restartResult?.success) {
      return {
        success: false,
        deploymentType,
        error: restartResult?.error || 'restart_failed',
        errorCode: restartResult?.errorCode,
        errorDetails: restartResult?.errorDetails,
        mode: restartResult?.mode || 'docker',
      };
    }

    try {
      const invalidateResult = await invalidateAggregatorCaches(serverId, {
        deploymentType,
        reason: restartReason,
      });
      if (!invalidateResult.success && !invalidateResult.skipped) {
        console.warn(
          `[API] Aggregator cache invalidation failed after restarting ${serverId}: ${invalidateResult.error || 'unknown error'}`,
        );
      }
    } catch (error) {
      console.warn(
        `[API] Aggregator invalidation threw after restarting ${serverId}: ${error.message}`,
      );
    }

    const readyResult = await waitForServerToolReadySafely(serverId, {
      deploymentType,
      maxWaitMs: Number.isFinite(options.maxWaitMs)
        ? options.maxWaitMs
        : TOOL_READY_TIMEOUT_MS,
      pollIntervalMs: Number.isFinite(options.pollIntervalMs)
        ? options.pollIntervalMs
        : TOOL_READY_POLL_INTERVAL_MS,
    });

    safeQueueFullHealthCheck(healthReason);

    return {
      success: true,
      deploymentType,
      mode: restartResult.mode || 'docker',
      healthy: Boolean(readyResult.healthy),
      elapsedMs: readyResult.elapsedMs,
      readinessPhase:
        readyResult.readinessPhase ||
        (readyResult.healthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING),
      readinessError: readyResult.error,
    };
  } catch (error) {
    console.error(
      `[API] Unexpected error restarting ${serverId}: ${error.message}`,
    );
    return {
      success: false,
      deploymentType,
      error: error.message,
      errorCode: error.code || 'MCP_SERVER_RESTART_FAILED',
      mode: 'docker',
    };
  } finally {
    releaseMutation?.();
  }
}

function readinessStatusToApiPayload(serverId, status) {
  return {
    success: true,
    server_id: serverId,
    deployment_type: status.deploymentType,
    healthy: status.healthy,
    readiness_phase: status.readinessPhase,
    status: status.status,
    tools_count: status.toolsCount,
    total_paths: status.totalPaths,
    authorization_url_available: status.authorizationUrlAvailable,
    oauth_state: status.oauthState,
    openapi_available: status.openapiAvailable,
    discovered: status.discovered,
    proxy_probe_ok: status.proxyProbeOk,
    proxy_probe_status: status.proxyProbeStatus,
    proxy_probe_tool_path: status.proxyProbeToolPath,
    proxy_probe_error: status.proxyProbeError,
    probe_status: status.probeStatus,
    startup_failure: status.startupFailure,
    startup_failure_source: status.startupFailureSource,
    startup_failure_stage: status.startupFailureStage,
    startup_failure_timestamp: status.startupFailureTimestamp,
    config_path: status.configPath,
    container_name: status.containerName,
    error: status.error,
  };
}

/**
 * Create and configure the Express REST API server
 * @returns {Object} - Express app instance
 */
function createApiServer() {
  const apiApp = express();
  apiApp.use(express.json({ limit: '3mb' }));

  // ============================================================================
  // MIDDLEWARE
  // ============================================================================

  // CORS middleware - allow requests from the Electron app:// shell and local webviews
  apiApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Logging middleware - send to loading window and init log file
  apiApp.use((req, res, next) => {
    const logRequest = () => {
      const logMessage = `[API] ${req.method} ${req.path}\n`;
      console.log(logMessage);
      sendInitLog(logMessage, 'info');
    };
    // PORTICO-443: see api-request-log-policy.js for which routes and why.
    if (shouldLogOnlyOnFailure(req.path)) {
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          logRequest();
        }
      });
      return next();
    }
    logRequest();
    next();
  });

  // Only allow localhost connections
  apiApp.use((req, res, next) => {
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && !remoteAddress?.includes('127.0.0.1')) {
      const warnMsg = `[API] Rejected request from non-localhost: ${remoteAddress}\n`;
      console.warn(warnMsg);
      sendInitLog(warnMsg, 'warning');
      return res.status(403).json({ error: 'API only accessible from localhost' });
    }
    next();
  });

  // ============================================================================
  // HEALTH ENDPOINT
  // ============================================================================

  // GET /api/health - Health check endpoint
  apiApp.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Shared creator identity for app-owned local resources. The agent-specific
  // endpoint below remains as a compatibility alias for existing runtimes.
  apiApp.get('/api/creator-identity/current-user', async (_req, res) => {
    try {
      return res.json(await creatorIdentity.getCurrentCreatorIdentity());
    } catch (error) {
      const status = error?.code === 'missing_user_identity' ? 503 : 500;
      return res.status(status).json({
        error: error?.message || 'Creator identity is unavailable',
        code: error?.code || 'creator_identity_failed',
      });
    }
  });

  // App-owned creator identity. The Subagents server uses this instead of
  // trusting an LLM-supplied create_agent argument.
  apiApp.get('/api/agent-attribution/current-user', async (_req, res) => {
    try {
      return res.json(await agentAttributionContext.getCurrentUserAttribution());
    } catch (error) {
      const status = error?.code === 'missing_user_identity' ? 503 : 500;
      return res.status(status).json({
        error: error?.message || 'Agent attribution identity is unavailable',
        code: error?.code || 'agent_attribution_failed',
      });
    }
  });

  // Strict context for startup/install reconciliation. A malformed registry
  // is an error rather than an empty set so linked agents are never backfilled
  // as local by accident.
  apiApp.get('/api/agent-attribution/context', async (_req, res) => {
    try {
      return res.json(await agentAttributionContext.getAgentAttributionContext());
    } catch (error) {
      const status = error?.code === 'missing_user_identity' ? 503 : 500;
      return res.status(status).json({
        error: error?.message || 'Agent attribution context is unavailable',
        code: error?.code || 'agent_attribution_failed',
      });
    }
  });

  function userSkillErrorStatus(error) {
    if (error?.code === 'missing_user_identity') return 503;
    if (error?.code === 'skill_not_found') return 404;
    if (
      error?.code === 'skill_already_exists' ||
      error?.code === 'system_skill_collision' ||
      error?.code === 'ambiguous_skill_source'
    ) {
      return 409;
    }
    if (
      error?.code === 'invalid_skill_name' ||
      error?.code === 'invalid_skill_content' ||
      error?.code === 'skill_content_too_large' ||
      error?.code === 'malformed_skill_frontmatter' ||
      error?.code === 'unsafe_skill_path'
    ) {
      return 400;
    }
    return 500;
  }

  function userSkillErrorRemediation(error) {
    if (error?.code === 'missing_user_identity') {
      return 'Sign in to Portico, then retry.';
    }
    if (error?.code === 'skill_not_found') {
      return 'Use list_skills and choose an existing local skill id.';
    }
    if (
      error?.code === 'skill_already_exists' ||
      error?.code === 'system_skill_collision'
    ) {
      return 'Choose a unique skill name.';
    }
    if (error?.code === 'published_skill_rename_blocked') {
      return 'Unpublish the skill first (unpublish_skill with its solution id from list_published_skills), then rename it and republish under the new name.';
    }
    if (error?.code === 'skill_link_conflict') {
      return 'A stale marketplace link occupies the new name; republish or unpublish that listing (or clear the link) before reusing the name.';
    }
    if (error?.code === 'same_skill_name') {
      return 'Pick a name that differs from the current one (names are ASCII kebab-case and compared case-insensitively).';
    }
    if (error?.code === 'ambiguous_skill_source') {
      return 'Resolve the duplicate local skill sources before copying.';
    }
    if (
      error?.code === 'invalid_skill_name' ||
      error?.code === 'invalid_skill_content' ||
      error?.code === 'skill_content_too_large' ||
      error?.code === 'malformed_skill_frontmatter' ||
      error?.code === 'unsafe_skill_path'
    ) {
      return 'Use a valid local skill id and safe skill content, then retry.';
    }
    return 'Retry after checking the local Agent Skills service.';
  }

  // The Skills MCP proxies creation and updates through these localhost-only
  // routes. Legacy caller-supplied `author` values are intentionally ignored;
  // creator attribution comes exclusively from the authenticated app session.
  apiApp.post('/api/user-skills/create', async (req, res) => {
    try {
      return res.json(await userSkillService.createSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        skillName: req.body?.skill_name,
        skillContent: req.body?.skill_content,
      }));
    } catch (error) {
      return res.status(userSkillErrorStatus(error)).json({
        success: false,
        error: error?.message || 'Could not create user skill',
        code: error?.code || 'user_skill_create_failed',
        remediation: userSkillErrorRemediation(error),
      });
    }
  });

  apiApp.post('/api/user-skills/copy', async (req, res) => {
    try {
      return res.json(await userSkillService.copySkillById({
        projectRoot: bootstrap.PROJECT_ROOT,
        sourceSkillId: req.body?.source_skill_id,
        newSkillName: req.body?.new_skill_name,
      }));
    } catch (error) {
      return res.status(userSkillErrorStatus(error)).json({
        success: false,
        error: error?.message || 'Could not copy skill',
        code: error?.code || 'user_skill_copy_failed',
        remediation: userSkillErrorRemediation(error),
      });
    }
  });

  apiApp.post('/api/user-skills/update', async (req, res) => {
    try {
      return res.json(await userSkillService.updateSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        skillName: req.body?.skill_name,
        skillContent: req.body?.skill_content,
      }));
    } catch (error) {
      return res.status(userSkillErrorStatus(error)).json({
        success: false,
        error: error?.message || 'Could not update user skill',
        code: error?.code || 'user_skill_update_failed',
        remediation: userSkillErrorRemediation(error),
      });
    }
  });

  // Agent-edit change marker: agentic update_agent writes go straight to the
  // OWUI model store (never through the renderer, whose save path is what
  // marks agent links dirty), so the Subagents MCP server reports successful
  // edits here. markLinkDirty no-ops for unlinked agents, and installed
  // copies never reach this (the read-only guard rejects their updates).
  apiApp.post('/api/ai-marketplace/mark-agent-link-dirty', async (req, res) => {
    try {
      const agentId = String(req.body?.agent_id || "").trim();
      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: "agent_id is required",
          code: "invalid_argument",
        });
      }
      const aiMarketplaceAgentLinks = require("./ai-marketplace-agent-links");
      const link = await aiMarketplaceAgentLinks.markLinkDirty(agentId);
      return res.json({ success: true, marked: Boolean(link), link: link || null });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || 'Could not mark the agent link dirty',
        code: error?.code || 'agent_link_mark_dirty_failed',
      });
    }
  });

  // Rename an editable user skill (skills_rename_skill). Guarded like delete:
  // an agent referencing the old name would silently lose the skill, so
  // renames of agent-attached skills fail closed with the agents named.
  // Marketplace error envelopes stay HTTP 200 so the MCP proxy surfaces the
  // structured code/remediation instead of a transport failure.
  apiApp.post('/api/user-skills/rename', async (req, res) => {
    try {
      const result = await userSkillService.renameSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        skillName: req.body?.skill_name,
        newSkillName: req.body?.new_skill_name,
        assertRenamable: (canonicalName) =>
          agentSkillUsageGuard.assertSkillDeletable({ leafName: canonicalName }),
      });
      broadcastMarketplaceLinksChanged("skill");
      return res.json(result);
    } catch (error) {
      if (error?.code === "skill_in_use_by_agents" || error?.code === "agent_inventory_unavailable") {
        return sendAiMarketplaceError(res, error);
      }
      return res.status(userSkillErrorStatus(error)).json({
        success: false,
        error: error?.message || 'Could not rename user skill',
        code: error?.code || 'user_skill_rename_failed',
        remediation: userSkillErrorRemediation(error),
      });
    }
  });

  // Bundle-content change marker: reference/script mutations happen in the
  // Skills MCP server's own filesystem writes (they never pass through
  // /api/user-skills/update), so the server reports them here to keep the
  // published-link dirty state truthful. markLinkDirty no-ops for unlinked
  // skills, so this is safe to call for every user-skill content change.
  apiApp.post('/api/user-skills/mark-dirty', async (req, res) => {
    try {
      const skillName = String(req.body?.skill_name || "").trim();
      if (!skillName) {
        return res.status(400).json({
          success: false,
          error: "skill_name is required",
          code: "invalid_argument",
        });
      }
      const link = await aiMarketplaceSkillLinks.markLinkDirty(skillName);
      return res.json({ success: true, marked: Boolean(link), link: link || null });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || 'Could not mark the skill link dirty',
        code: error?.code || 'skill_link_mark_dirty_failed',
      });
    }
  });

  apiApp.get('/api/mcp/bridge/status', async (req, res) => {
    try {
      const requestId = randomUUID();
      const authorization = String(req.headers?.authorization || "").trim();
      if (authorization && !requireElectronBrokerAuth(req, res)) {
        return;
      }
      const bridgeReady = await probeHostMcpBridgeHealth(state.hostMcpBridge.port);
      const bridgePreferences = readHostMcpBridgePreferences({
        userDataPath: app.getPath("userData"),
      });
      const bridgeEnabled = bridgePreferences.data.enabled !== false;
      const brokerAuthReady = authorization
        ? true
        : Boolean(String(process.env.HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN || "").trim());

      void emitBridgeLogRepoEvent("bridge_status_checked", {
        ...bridgeRequestTelemetryFields(req, "api_status", { request_id: requestId }),
        outcome: "success",
        bridge_ready: bridgeReady,
        bridge_enabled: bridgeEnabled,
        broker_auth_ready: brokerAuthReady,
      });

      res.json({
        success: true,
        bridgeReady,
        bridgeEnabled,
        brokerAuthReady,
      });
    } catch (error) {
      const requestId = randomUUID();
      const errorMessage = logProgrammaticBridgeError("status", error, requestId);
      void emitBridgeLogRepoEvent("bridge_status_checked", {
        ...bridgeRequestTelemetryFields(req, "api_status", { request_id: requestId }),
        outcome: "failed",
        bridge_ready: false,
        bridge_enabled: true,
        broker_auth_ready: false,
        ...buildBridgeErrorTelemetry(error),
      });
      res.status(500).json({
        success: false,
        bridgeReady: false,
        bridgeEnabled: true,
        brokerAuthReady: false,
        error: errorMessage,
      });
    }
  });

  apiApp.get('/api/mcp/bridge/clients', async (req, res) => {
    try {
      const requestId = randomUUID();
      const clients = detectMcpClients({
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        userDataPath: app.getPath("userData"),
        bridgeUrl: DEFAULT_BRIDGE_URL,
      }).map(summarizeBridgeClientState);
      const detectedClients = clients
        .filter((client) => client.detected === true)
        .map((client) => client.id);
      const configuredClients = clients
        .filter((client) => client.configured === true)
        .map((client) => client.id);
      const bridgeReady = await probeHostMcpBridgeHealth(state.hostMcpBridge.port);
      const bridgePreferences = readHostMcpBridgePreferences({
        userDataPath: app.getPath("userData"),
      });
      const scriptAction = bridgeScriptAction({
        bridgeReady,
        configuredClients,
        detectedClients,
      });

      void emitBridgeLogRepoEvent("bridge_status_checked", {
        ...bridgeRequestTelemetryFields(req, "api_clients", { request_id: requestId }),
        ...summarizeBridgeClientInventory(clients),
        outcome: "success",
        bridge_ready: bridgeReady,
        bridge_enabled: bridgePreferences.data.enabled !== false,
        script_action: scriptAction,
      });

      res.json({
        success: true,
        bridgeReady,
        bridgeEnabled: bridgePreferences.data.enabled !== false,
        configuredClients,
        detectedClients,
        clients,
        scriptAction,
        undo: "Rerun setup-community/run-mcp-servers to reselect the active MCP path.",
      });
    } catch (error) {
      const requestId = randomUUID();
      const errorMessage = logProgrammaticBridgeError("clients", error, requestId);
      void emitBridgeLogRepoEvent("bridge_status_checked", {
        ...bridgeRequestTelemetryFields(req, "api_clients", { request_id: requestId }),
        outcome: "failed",
        bridge_ready: false,
        bridge_enabled: true,
        script_action: "fallback_toolhive",
        ...buildBridgeErrorTelemetry(error),
      });
      res.status(500).json({
        success: false,
        bridgeReady: false,
        bridgeEnabled: true,
        configuredClients: [],
        detectedClients: [],
        clients: [],
        scriptAction: "fallback_toolhive",
        undo: "Rerun setup-community/run-mcp-servers to reselect the active MCP path.",
        error: errorMessage,
      });
    }
  });

  apiApp.post('/api/mcp/bridge/enable', async (req, res) => {
    const requestId = randomUUID();
    const telemetryCommon = bridgeRequestTelemetryFields(req, "api_enable", {
      request_id: requestId,
    });
    let clientIds = [];
    let bridgeEnabled = readHostMcpBridgePreferences({
      userDataPath: app.getPath("userData"),
    }).data.enabled !== false;
    if (!requireProgrammaticBridgeHeader(req, res)) {
      void emitBridgeLogRepoEvent("bridge_enable_failed", {
        ...telemetryCommon,
        outcome: "failed",
        ...buildBridgeErrorTelemetry(
          "Programmatic Host MCP Bridge configuration requires X-PORTICO-Programmatic-Bridge: 1",
          "missing_programmatic_header",
        ),
      });
      return;
    }

    try {
      const clients = detectMcpClients({
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        userDataPath: app.getPath("userData"),
        bridgeUrl: DEFAULT_BRIDGE_URL,
      });
      clientIds = normalizeBridgeEnableClientIds(req.body || {}, clients);
      void emitBridgeLogRepoEvent("bridge_enable_requested", {
        ...telemetryCommon,
        ...summarizeBridgeClientInventory(clients),
        outcome: "requested",
        selected_client_ids: clientIds,
        selected_client_count: clientIds.length,
      });

      if (clientIds.length === 0) {
        void emitBridgeLogRepoEvent("bridge_enable_failed", {
          ...telemetryCommon,
          ...summarizeBridgeClientInventory(clients),
          outcome: "failed",
          selected_client_count: 0,
          bridge_enabled: bridgeEnabled,
          ...buildBridgeErrorTelemetry(
            "No MCP clients were detected or requested",
            "no_clients",
          ),
        });
        return res.status(400).json({
          success: false,
          bridgeEnabled,
          bridgeUrl: DEFAULT_BRIDGE_URL,
          error: "No MCP clients were detected or requested",
          clients,
        });
      }

      setHostMcpBridgeDesiredEnabled(true, {
        userDataPath: app.getPath("userData"),
        source: "api_enable",
        reason: "programmatic_client_configuration",
      });
      bridgeEnabled = true;
      const bridgeReady = await ensureHostMcpBridgeReady({
        timeoutMs: normalizeBridgeEnableTimeoutMs(req.body?.timeout_ms ?? req.body?.timeoutMs),
      });
      if (!bridgeReady.ready) {
        const errorMessage = logProgrammaticBridgeError(
          "bridge_readiness",
          bridgeReady.error || "Host MCP Bridge did not become healthy",
          requestId,
        );
        void emitBridgeLogRepoEvent("bridge_enable_failed", {
          ...telemetryCommon,
          outcome: "failed",
          bridge_ready: false,
          bridge_enabled: true,
          selected_client_ids: clientIds,
          selected_client_count: clientIds.length,
          ...buildBridgeErrorTelemetry(
            errorMessage,
          ),
        });
        return res.status(503).json({
          success: false,
          bridgeReady: false,
          bridgeEnabled: true,
          bridgeUrl: DEFAULT_BRIDGE_URL,
          error: errorMessage,
          selectedClientIds: clientIds,
          clients,
        });
      }

      const configureResult = await configureMcpClients({
        userDataPath: app.getPath("userData"),
        homeDir: os.homedir(),
        bridgeUrl: DEFAULT_BRIDGE_URL,
        clientIds,
        platform: process.platform,
        env: process.env,
      });
      const resultSummary = summarizeBridgeClientResults(configureResult.results || []);
      void emitBridgeLogRepoEvent("bridge_enable_completed", {
        ...telemetryCommon,
        ...resultSummary,
        outcome: configureResult.success ? "success" : "partial",
        bridge_ready: true,
        bridge_enabled: true,
      });
      void emitBridgeClientResultEvents("client_configure", configureResult.results || [], {
        ...telemetryCommon,
        request_source: "api_enable",
        bridge_ready: true,
        bridge_enabled: true,
      });
      res.status(configureResult.success ? 200 : 207).json({
        success: configureResult.success,
        bridgeReady: true,
        bridgeEnabled: true,
        bridgeUrl: configureResult.bridgeUrl || DEFAULT_BRIDGE_URL,
        selectedClientIds: clientIds,
        results: configureResult.results || [],
      });
    } catch (error) {
      const errorMessage = logProgrammaticBridgeError("enable", error, requestId);
      void emitBridgeLogRepoEvent("bridge_enable_failed", {
        ...telemetryCommon,
        outcome: "failed",
        bridge_ready: false,
        bridge_enabled: bridgeEnabled,
        selected_client_ids: clientIds,
        selected_client_count: clientIds.length,
        ...buildBridgeErrorTelemetry(error),
      });
      res.status(500).json({
        success: false,
        bridgeReady: false,
        bridgeEnabled,
        bridgeUrl: DEFAULT_BRIDGE_URL,
        error: errorMessage,
      });
    }
  });

  apiApp.post('/api/mcp/bridge/disable', async (req, res) => {
    const requestId = randomUUID();
    const telemetryCommon = bridgeRequestTelemetryFields(req, "api_disable", {
      request_id: requestId,
    });
    if (!requireProgrammaticBridgeHeader(req, res)) {
      void emitBridgeLogRepoEvent("bridge_disable_failed", {
        ...telemetryCommon,
        outcome: "failed",
        ...buildBridgeErrorTelemetry(
          "Programmatic Host MCP Bridge configuration requires X-PORTICO-Programmatic-Bridge: 1",
          "missing_programmatic_header",
        ),
      });
      return;
    }

    try {
      const clients = detectMcpClients({
        homeDir: os.homedir(),
        platform: process.platform,
        env: process.env,
        userDataPath: app.getPath("userData"),
        bridgeUrl: DEFAULT_BRIDGE_URL,
      }).map(summarizeBridgeClientState);
      const detectedClients = clients
        .filter((client) => client.detected === true)
        .map((client) => client.id);
      const configuredClients = clients
        .filter((client) => client.configured === true)
        .map((client) => client.id);

      void emitBridgeLogRepoEvent("bridge_disable_requested", {
        ...telemetryCommon,
        ...summarizeBridgeClientInventory(clients),
        outcome: "requested",
        bridge_enabled: false,
        configured_client_ids: configuredClients,
        configured_client_count: configuredClients.length,
      });

      setHostMcpBridgeDesiredEnabled(false, {
        userDataPath: app.getPath("userData"),
        source: "api_disable",
        reason: "programmatic_disable",
      });
      const stopResult = await stopHostMcpBridge({ reason: "programmatic_disable" });
      await checkDockerStatus();
      if (!stopResult?.success) {
        const errorMessage = logProgrammaticBridgeError(
          "disable",
          stopResult?.error || "Host MCP Bridge did not stop",
          requestId,
        );
        void emitBridgeLogRepoEvent("bridge_disable_failed", {
          ...telemetryCommon,
          ...summarizeBridgeClientInventory(clients),
          outcome: "failed",
          bridge_ready: true,
          bridge_enabled: false,
          configured_client_ids: configuredClients,
          configured_client_count: configuredClients.length,
          ...buildBridgeErrorTelemetry(errorMessage, "bridge_stop_failed"),
        });
        return res.status(503).json({
          success: false,
          bridgeReady: true,
          bridgeEnabled: false,
          bridgeUrl: DEFAULT_BRIDGE_URL,
          configuredClients,
          detectedClients,
          clients,
          scriptAction: "enable_bridge",
          error: errorMessage,
        });
      }

      const scriptAction = "fallback_toolhive";
      void emitBridgeLogRepoEvent("bridge_disable_completed", {
        ...telemetryCommon,
        ...summarizeBridgeClientInventory(clients),
        outcome: "success",
        bridge_ready: false,
        bridge_enabled: false,
        script_action: scriptAction,
      });

      res.json({
        success: true,
        bridgeReady: false,
        bridgeEnabled: false,
        bridgeUrl: DEFAULT_BRIDGE_URL,
        configuredClients,
        detectedClients,
        clients,
        scriptAction,
        message:
          "Host MCP Bridge stopped. Client configurations were left unchanged.",
        undo: "Rerun setup-community/run-mcp-servers to reselect the active MCP path.",
      });
    } catch (error) {
      const errorMessage = logProgrammaticBridgeError("disable", error, requestId);
      void emitBridgeLogRepoEvent("bridge_disable_failed", {
        ...telemetryCommon,
        outcome: "failed",
        bridge_ready: false,
        bridge_enabled: false,
        ...buildBridgeErrorTelemetry(error),
      });
      res.status(500).json({
        success: false,
        bridgeReady: false,
        bridgeEnabled: false,
        bridgeUrl: DEFAULT_BRIDGE_URL,
        scriptAction: "fallback_toolhive",
        error: errorMessage,
      });
    }
  });

  apiApp.post('/api/mcp/oauth/record', (req, res) => {
    if (!requireElectronBrokerAuth(req, res)) {
      return;
    }
    let serverId;
    let normalizedRecord;
    let serverConfig;
    try {
      serverId = normalizeBrokerServerId(req);
      const migration = migrateLegacyOAuthRecordIfNeeded(serverId);
      if (oauthMigrationRequiresReauth(migration)) {
        sendOAuthAuthRequired(res, serverId, {
          reason: migration.reason,
          errorClass: migration.errorClass,
        });
        return;
      }
      const record = loadOAuthRecord(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
      });
      if (!record) {
        sendOAuthAuthRequired(res, serverId);
        return;
      }
      normalizedRecord = normalizeOAuthBrokerRecord(record);
      serverConfig = loadGeneratedMcpServerConfig(
        serverId,
        bootstrap.PROJECT_ROOT,
      );
    } catch (error) {
      const status = error.message === "invalid server_id" ? 400 : 503;
      if (status !== 400) {
        console.warn(
          `[API] OAuth broker could not prepare secure record for ${serverId || "unknown"}: ${error.message}`,
        );
      }
      res.status(status).json({
        success: false,
        error:
          status === 400
            ? "invalid server_id"
            : "secure OAuth record is unavailable",
      });
      return;
    }

    res.json({
      server_id: serverId,
      token: normalizedRecord.token,
      client_info: normalizedRecord.client_info,
      server_config: serverConfig,
    });
  });

  apiApp.post('/api/mcp/oauth/record/update', (req, res) => {
    if (!requireElectronBrokerAuth(req, res)) {
      return;
    }
    let serverId;
    try {
      serverId = normalizeBrokerServerId(req);
      const normalizedRecord = normalizeOAuthBrokerRecord({
        token: req.body?.token,
        client_info: req.body?.client_info,
      });
      persistOAuthRecord(serverId, normalizedRecord, {
        projectRoot: bootstrap.PROJECT_ROOT,
      });
    } catch (error) {
      const status = error.message === "invalid server_id" ? 400 : 503;
      console.warn(
        `[API] OAuth broker could not persist secure record for ${serverId || "unknown"}: ${error.message}`,
      );
      res.status(status).json({
        success: false,
        error:
          status === 400
            ? "invalid server_id"
            : "secure OAuth record persistence failed",
      });
      return;
    }

    res.json({ success: true, server_id: serverId });
  });

  apiApp.post('/api/mcp/oauth/record/invalidate', (req, res) => {
    if (!requireElectronBrokerAuth(req, res)) {
      return;
    }
    let serverId;
    try {
      serverId = normalizeBrokerServerId(req);
      const requestedErrorClass = String(
        req.body?.error_class || "oauth_terminal_refresh_failure",
      ).trim();
      const errorClass = [
        "oauth_terminal_refresh_failure",
        "oauth_client_identity_mismatch",
        "oauth_persistent_downstream_unauthorized",
      ].includes(requestedErrorClass)
        ? requestedErrorClass
        : "oauth_terminal_refresh_failure";
      const result = invalidateSecureOAuthRecord(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        reason: "secure_oauth_record_requires_reauth",
        errorClass,
      });
      console.warn(
        `[API] Invalidated secure OAuth record for ${serverId}; errorClass=${errorClass} cleared=${result.cleared}`,
      );
      res.json({
        success: true,
        server_id: serverId,
        state: result.state,
        reason: result.reason,
        error_class: result.errorClass,
        cleared: result.cleared,
      });
    } catch (error) {
      const status = error.message === "invalid server_id" ? 400 : 503;
      console.warn(
        `[API] OAuth broker could not invalidate secure record for ${serverId || "unknown"}: ${error.message}`,
      );
      res.status(status).json({
        success: false,
        error:
          status === 400
            ? "invalid server_id"
            : "secure OAuth record invalidation failed",
      });
    }
  });

  apiApp.post('/api/mcp/oauth/access-token', (req, res) => {
    if (!requireElectronBrokerAuth(req, res)) {
      return;
    }
    let normalizedRecord;
    try {
      const serverId = normalizeBrokerServerId(req);
      const migration = migrateLegacyOAuthRecordIfNeeded(serverId);
      if (oauthMigrationRequiresReauth(migration)) {
        sendOAuthAuthRequired(res, serverId, {
          reason: migration.reason,
          errorClass: migration.errorClass,
        });
        return;
      }
      const record = loadOAuthRecord(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
      });
      if (!record) {
        sendOAuthAuthRequired(res, serverId);
        return;
      }
      normalizedRecord = normalizeOAuthBrokerRecord(record);
    } catch (error) {
      const status = error.message === "invalid server_id" ? 400 : 503;
      if (status !== 400) {
        console.warn(
          `[API] OAuth broker could not vend persisted access token: ${error.message}`,
        );
      }
      res.status(status).json({
        success: false,
        error:
          status === 400
            ? "invalid server_id"
            : "OAuth access token is unavailable",
      });
      return;
    }

    res.json({
      access_token: normalizedRecord.token.access_token,
      expires_at:
        normalizedRecord.token.expires_at ||
        normalizedRecord.token.expiry ||
        normalizedRecord.token.expiresAt ||
        null,
      token_type: normalizedRecord.token.token_type || "Bearer",
    });
  });

  apiApp.post('/api/mcp/static-secret', (req, res) => {
    if (!requireElectronBrokerAuth(req, res)) {
      return;
    }

    let serverId;
    let secretName;
    let bytes;
    try {
      serverId = normalizeBrokerServerId(req);
      secretName = normalizeBrokerSecretName(req);
      bytes = resolveStaticSecretBrokerBytes(serverId, secretName);
    } catch (error) {
      const status =
        error.message === "invalid server_id" ||
        error.message === "invalid secret_name"
          ? 400
          : 404;
      console.warn(
        `[API] Static secret broker could not resolve ${serverId || "unknown"}/${secretName || "unknown"}: ${error.message}`,
      );
      res.status(status).json({
        success: false,
        error:
          status === 400
            ? error.message
            : "static secret is unavailable",
      });
      return;
    }

    res.json({
      server_id: serverId,
      secret_name: secretName,
      value_base64: bytes.toString("base64"),
    });
  });

  // GET /api/system-information - Local hardware summary for model recommendations
  apiApp.get('/api/system-information', (req, res) => {
    try {
      res.json({
        success: true,
        system: collectSystemInformation(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to collect system information',
      });
    }
  });

  // POST /api/server-readiness/bulk - Canonical readiness for multiple servers
  apiApp.post('/api/server-readiness/bulk', async (req, res) => {
    const rawServerIds = Array.isArray(req.body?.server_ids)
      ? req.body.server_ids
      : Array.isArray(req.body?.serverIds)
        ? req.body.serverIds
        : [];
    const serverIds = [
      ...new Set(
        rawServerIds
          .map((serverId) => String(serverId || '').trim())
          .filter(Boolean),
      ),
    ].slice(0, 250);

    try {
      const results = {};
      await Promise.all(
        serverIds.map(async (serverId) => {
          try {
            const status = await withTimeout(
              getServerReadinessStatus(serverId, {
                syncHealthStatus: false,
              }),
              SERVER_READINESS_BULK_ITEM_TIMEOUT_MS,
              `readiness probe timed out for ${serverId}`,
            );
            results[serverId] = readinessStatusToApiPayload(serverId, status);
          } catch (error) {
            results[serverId] = {
              success: false,
              server_id: serverId,
              healthy: false,
              readiness_phase: READINESS_PHASE_STARTING,
              error: error.message,
            };
          }
        }),
      );
      try {
        await syncHealthStatusFileFromReadinessEntries(
          Object.entries(results).map(([serverId, payload]) => [serverId, payload]),
        );
      } catch (syncError) {
        console.warn(
          `[API] Could not sync health status file from bulk readiness: ${syncError.message}`,
        );
      }
      res.json({
        success: true,
        results,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // GET /api/server-readiness/:serverId - Canonical readiness for one server
  apiApp.get('/api/server-readiness/:serverId', async (req, res) => {
    const { serverId } = req.params;

    try {
      const status = await getServerReadinessStatus(serverId);
      res.json(readinessStatusToApiPayload(serverId, status));
    } catch (error) {
      res.status(500).json({
        success: false,
        server_id: serverId,
        healthy: false,
        readiness_phase: READINESS_PHASE_STARTING,
        error: error.message,
      });
    }
  });

  // GET /api/mcp-server-logs/:serverId - Fetch recent logs for a single MCP server
  apiApp.get('/api/mcp-server-logs/:serverId', async (req, res) => {
    try {
      const { serverId } = req.params;
      const result = await getMcpServerLogs(serverId, {
        lines: req.query.lines,
      });
      if (result?.code === 'server_not_found') {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        server_id: req.params.serverId,
        code: "log_fetch_failed",
        logs: "",
        error: "Unable to fetch MCP server logs.",
      });
    }
  });

  // ============================================================================
  // MARKETPLACE ENDPOINTS
  // ============================================================================

  // Chat-tool projection: this HTTP surface feeds the skills MCP server only
  // (the control plane reads the full config over IPC). The raw config ships
  // every marketplace's cachedManifest plus per-file baseline hashes for
  // every installed skill — ~200 KB of model context per skills_list_marketplaces
  // call with zero decision value. Same diet rationale as
  // LIST_PUBLISHED_SOLUTION_FIELDS.
  function projectMarketplaceSourceForAgentSurface(source) {
    if (!source || typeof source !== "object") return null;
    const projected = { type: source.type || null };
    for (const key of ["repo", "host", "projectPath", "url", "ref", "path"]) {
      if (typeof source[key] === "string" && source[key]) {
        projected[key] = source[key];
      }
    }
    return projected;
  }

  apiApp.get('/api/marketplaces', async (req, res) => {
    try {
      const config = await marketplaceService.loadMarketplacesConfig(
        bootstrap.PROJECT_ROOT,
        { logger: console },
      );
      return res.json({
        success: true,
        data: {
          version: config.version,
          marketplaces: (config.marketplaces || []).map((marketplace) => ({
            id: marketplace.id,
            name: marketplace.name,
            description: marketplace.description,
            marketplaceVersion: marketplace.marketplaceVersion,
            isSparse: marketplace.isSparse === true,
            ootb: marketplace.ootb === true,
            enabled: marketplace.enabled !== false,
            lastSynced: marketplace.lastSynced || null,
            source: projectMarketplaceSourceForAgentSurface(marketplace.source),
            skill_count: marketplaceService.countTotalSkills(
              marketplace.cachedManifest,
            ),
          })),
          installedSkills: (config.installedSkills || []).map((entry) => ({
            marketplaceId: entry.marketplaceId,
            pluginName: entry.pluginName ?? null,
            skillId: entry.skillId,
            installedVersion: entry.installedVersion,
            localPath: entry.localPath,
            hasUpdate: entry.hasUpdate === true,
            isDirty: entry.isDirty === true,
            hasConflict: entry.hasConflict === true,
            installedAt: entry.installedAt || null,
            updatedAt: entry.updatedAt || null,
          })),
        },
      });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  // ============================================================================
  // AI MARKETPLACE (native REST) — agentic access via the Subagents/Skills MCP
  // servers, which proxy to these localhost endpoints. Shares one source of
  // truth (api key, viewer identity, install bookkeeping) with the control-plane
  // IPC handlers through ai-marketplace-operations.js.
  // ============================================================================

  function aiMarketplaceErrorEnvelope(error) {
    return {
      success: false,
      error: error?.message || String(error),
      code: error?.code || null,
      remediation: error?.remediation || null,
      body: error?.body ?? null,
    };
  }

  function sendAiMarketplaceError(res, error) {
    // Always 200 with a { success:false } envelope so the MCP proxy (which reads
    // the JSON body) surfaces the structured error/code rather than an HTTP throw.
    return res.json(aiMarketplaceErrorEnvelope(error));
  }

  // Deferred outcome for the flow-status polling contract: the confirm/publish
  // continuation stores the route's final envelope on the flow entry, and
  // GET /api/ai-marketplace/publish-flow-status/:flowId serves it to the
  // polling MCP proxy. Completed entries live 5 minutes before eviction
  // (shared-state cleanup), far beyond the ~1s poll cadence.
  function stashMarketplacePublishRouteOutcome(flowId, envelope) {
    const entry = state.marketplacePublishFlowResults.get(flowId);
    if (!entry) {
      console.warn(
        `[API][ai-marketplace] publish flow ${flowId} outcome arrived after eviction`,
      );
      return;
    }
    entry.routeOutcome = envelope;
    entry.routeOutcomeAt = Date.now();
  }

  // The one reply shape for the marketplace write routes (publish-agent /
  // publish-skill / unpublish). Without a flow the native dialog already
  // resolved, so the route answers inline. With a flow it follows the
  // flow-status polling contract (same as ask_user_question): reply with the
  // pending flow id now, and let the decision continuation stash the final
  // envelope for GET publish-flow-status.
  async function respondToMarketplaceConfirm(res, confirm, finishDecision) {
    if (!confirm.flowId) {
      return res.json(await finishDecision(confirm.decision));
    }
    void Promise.resolve(confirm.decision)
      .then(finishDecision, (error) => aiMarketplaceErrorEnvelope(error))
      .then((envelope) => {
        stashMarketplacePublishRouteOutcome(confirm.flowId, envelope);
        broadcastAiMarketplacePublishOutcome(confirm.flowId, envelope);
      });
    return res.json({
      success: true,
      status: "pending",
      started: true,
      flow_id: confirm.flowId,
    });
  }

  // Human-in-the-loop confirmation for outward-facing writes (publish/unpublish).
  // The MCP tool's HTTP call blocks until the user responds. Reads and local
  // installs are not gated.
  async function confirmAiMarketplaceWrite({ confirmLabel, message, detail }) {
    try {
      const win =
        BrowserWindow.getFocusedWindow() ||
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ||
        null;
      const options = {
        type: "question",
        buttons: ["Cancel", confirmLabel || "Publish"],
        defaultId: 1,
        cancelId: 0,
        title: "AI Marketplace",
        message: message || "Publish to the AI Marketplace?",
        detail: detail || "",
        noLink: true,
      };
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    } catch (error) {
      console.warn("[API][ai-marketplace] confirmation dialog failed:", error.message);
      return false;
    }
  }

  // App-styled, minimizable publish-confirmation modal (round 9). Registers a
  // marketplace_publish native-input flow and routes the request to the owning
  // chat window like every backend modal. The flow's own timers settle it
  // (deny at the confirm budget; publish budget after approval), and the
  // polling MCP proxy reads the outcome from the flow-status endpoint — no
  // HTTP call blocks on the user.
  //
  // Returns { flowId, decision }:
  //   flowId   — the registered flow id, or null when a pre-flow fallback
  //              (invalid payload / undeliverable request) resolved via the
  //              legacy native dialog INLINE (decision is then already final).
  //   decision — promise (or value on fallback paths) of a DECISION object:
  //     { kind: "approved" }                        — legacy confirm; caller publishes main-side
  //     { kind: "denied" }                          — declined / dismissed / confirm timeout
  //     { kind: "published", result }               — renderer ran the full publish pipeline
  //     { kind: "publish_failed", error, code }     — renderer publish failed after approval
  //     { kind: "unknown_outcome", result }         — approved, publish outlived the budget
  //     { kind: "error", error, code }              — flow errored before a user decision
  async function confirmAiMarketplaceWriteViaModal(request, nativeFallback, options = {}) {
    let normalizedRequest;
    try {
      normalizedRequest = normalizeMarketplacePublishConfirmRequest(request);
    } catch (error) {
      console.warn(
        "[API][ai-marketplace] publish confirm payload invalid; using native dialog:",
        error.message,
      );
      return {
        flowId: null,
        decision: {
          kind: (await confirmAiMarketplaceWrite(nativeFallback)) ? "approved" : "denied",
        },
      };
    }
    const timeoutSeconds = Math.min(
      MARKETPLACE_PUBLISH_TIMEOUT_SECONDS,
      Math.max(
        MARKETPLACE_PUBLISH_MIN_TIMEOUT_SECONDS,
        Math.floor(Number(options.timeoutSeconds) || MARKETPLACE_PUBLISH_TIMEOUT_SECONDS),
      ),
    );

    const flowId = `marketplace-publish-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let resolveWaiter;
    const waiter = new Promise((resolve) => {
      resolveWaiter = resolve;
    });
    const entry = startMarketplacePublishFlow({
      flowId,
      status: "in_progress",
      chatId: null,
      mode: normalizedRequest.mode,
      result: null,
      startedAt: Date.now(),
      completedAt: null,
      timeoutHandle: null,
      cleanupHandle: null,
      ownerWindowId: null,
      matchedViewKey: null,
      presentation: "visible",
      phase: "confirm",
      resolveDecision: null,
      onPublishing: null,
    });
    entry.resolveDecision = (decision) => {
      entry.resolveDecision = null;
      resolveWaiter(
        decision && typeof decision === "object" && decision.kind
          ? decision
          : { kind: "denied" },
      );
    };
    // Renderer-executed publishes: the first "publishing" completion swaps the
    // confirm deny-timer for a publish budget — a one-shot REPLACEMENT of the
    // existing timer (no new recurring work), spending whatever remains of the
    // route's slice of the Rust HTTP ceiling, never less than the minimum.
    entry.onPublishing = () => {
      if (entry.status !== "in_progress" || entry.phase === "publishing") {
        return false;
      }
      entry.phase = "publishing";
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      const deadlineAt = Number(options.publishDeadlineAt);
      const budgetMs = Math.max(
        MARKETPLACE_PUBLISH_MIN_EXECUTE_SECONDS * 1000,
        (Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + 30 * 1000) - Date.now(),
      );
      entry.timeoutHandle = setTimeout(() => {
        terminateMarketplacePublishFlow(
          flowId,
          buildMarketplacePublishUnknownOutcomeResult(entry),
        );
      }, budgetMs);
      return true;
    };

    // Dev-only auto-approve: the flag rides ONLY these agentic broadcast
    // payloads (manual control-plane publishes never pass through here), and
    // the resolver clamps to false off dev builds before any file IO. The
    // key is omitted entirely when off so non-dev payloads are unchanged,
    // and ANY resolution error fails closed — a dev convenience must never
    // break the approval broadcast.
    let autoApprove = false;
    try {
      autoApprove =
        resolveMarketplaceAutoApprove({
          userDataPath: app.getPath("userData"),
          isDevBuild: state.buildInfo?.buildNumber === "dev-build",
        }) === true;
    } catch {
      autoApprove = false;
    }
    const delivery = broadcastAiMarketplacePublishConfirmRequested({
      flow_id: flowId,
      mode: normalizedRequest.mode,
      title: normalizedRequest.title,
      confirm_label: normalizedRequest.confirmLabel,
      summary: normalizedRequest.summary,
      allowed_emails: normalizedRequest.allowedEmails,
      republish: normalizedRequest.republish,
      solution_id: normalizedRequest.solutionId,
      solution_type: normalizedRequest.solutionType,
      agent: normalizedRequest.agent,
      skill: normalizedRequest.skill,
      timeout_seconds: timeoutSeconds,
      ...(autoApprove ? { auto_approve: true } : {}),
    });
    if (!delivery?.sent) {
      terminateMarketplacePublishFlow(
        flowId,
        buildMarketplacePublishCancelledResult(entry, "no_window_available"),
      );
      return {
        flowId: null,
        decision: {
          kind: (await confirmAiMarketplaceWrite(nativeFallback)) ? "approved" : "denied",
        },
      };
    }
    entry.ownerWindowId = delivery.windowId ?? null;
    entry.matchedViewKey = delivery.matchedViewKey ?? null;
    broadcastNativeInputPresentationSnapshot(entry.ownerWindowId);

    entry.timeoutHandle = setTimeout(() => {
      terminateMarketplacePublishFlow(
        flowId,
        buildMarketplacePublishTimeoutResult(entry),
      );
    }, timeoutSeconds * 1000);

    return { flowId, decision: waiter };
  }

  // Non-approved confirm decisions → honest envelopes. Timeout and
  // cancellation are NOT user denials (the user never decided) and carry
  // retryable codes; renderer errors (e.g. publish_ui_busy) pass their code
  // through. Returns null for approved decisions so callers fall through to
  // the write. `denied:true` is reserved for a REAL user "no".
  function marketplaceDecisionFailureEnvelope(decision, { nothingHappened, deniedError }) {
    if (!decision || decision.kind === "approved") return null;
    if (decision.kind === "timeout") {
      return {
        success: false,
        code: "approval_timed_out",
        error: `The approval dialog timed out before the user responded; ${nothingHappened}.`,
        remediation:
          "Retry the call and ask the user to respond to the approval dialog in the app window.",
      };
    }
    if (decision.kind === "cancelled") {
      return {
        success: false,
        code: "approval_cancelled",
        error: `The approval was cancelled before the user decided; ${nothingHappened}.`,
      };
    }
    if (decision.kind === "error") {
      return {
        success: false,
        error: decision.error || "The approval confirmation failed inside the app.",
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.code === "publish_ui_busy"
          ? {
              remediation:
                "Another approval dialog is open in the app; retry after the user finishes it.",
            }
          : {}),
      };
    }
    return { success: false, denied: true, error: deniedError };
  }

  // Same ~24 KB/skill problem as list-published (see
  // LIST_PUBLISHED_SOLUTION_FIELDS below): raw search/get payloads carry the
  // full SKILL.md `comment` plus `*_semantic` duplicates. Search keeps only
  // identity/status fields; get-solution strips the body/semantic blobs AND
  // any inline bundle payloads (converted to the documented has_bundle flag)
  // but keeps everything else (skill_refs/skill_ids drive dependency flows).
  // Full bodies stay available via /api/ai-marketplace/get-bundle. The
  // renderer keeps untrimmed payloads via its own IPC channel.
  const SEARCH_EXTRA_SOLUTION_FIELDS = Object.freeze(["version", "tags"]);
  function projectSearchPayloadForAgentSurface(data) {
    if (!data || typeof data !== "object") return data;
    const projectEntry = (solution) => {
      if (!solution || typeof solution !== "object") return solution;
      const projected = projectSolutionForAgentSurface(solution);
      for (const key of SEARCH_EXTRA_SOLUTION_FIELDS) {
        if (key in solution) projected[key] = solution[key];
      }
      return projected;
    };
    const projected = { ...data };
    for (const key of ["results", "solutions"]) {
      if (Array.isArray(projected[key])) {
        projected[key] = projected[key].map(projectEntry);
      }
    }
    return projected;
  }

  // Full-content body fields, stripped at every depth: the SKILL.md body
  // rides in `comment` and the `*_semantic` duplicates, and the publish flow
  // spreads bundle payloads top-level onto listings, so skill_md /
  // system_prompt / references / scripts can also appear as plain envelope
  // fields depending on the deployment.
  const SOLUTION_BODY_CONTENT_KEYS = new Set([
    "comment",
    "skill_md",
    "system_prompt",
    "references",
    "scripts",
  ]);
  // Inline bundle containers: sandbox deployments inline `bundle` on
  // GET-by-id and git-backed listings inline `resolved_bundle_cache`. The
  // agent surface never forwards either — the tools document "body omitted;
  // use get_marketplace_bundle" — so they collapse into the has_bundle flag
  // regardless of the remote's shape.
  const SOLUTION_BUNDLE_CONTAINER_KEYS = new Set(["bundle", "resolved_bundle_cache"]);
  function stripSolutionBodyFieldsForAgentSurface(value) {
    if (Array.isArray(value)) {
      return value.map(stripSolutionBodyFieldsForAgentSurface);
    }
    if (!value || typeof value !== "object") return value;
    const out = {};
    let droppedBundleContent = false;
    for (const [key, entry] of Object.entries(value)) {
      if (SOLUTION_BODY_CONTENT_KEYS.has(key) || /_semantic$/.test(key)) continue;
      if (SOLUTION_BUNDLE_CONTAINER_KEYS.has(key)) {
        if (entry) droppedBundleContent = true;
        continue;
      }
      out[key] = stripSolutionBodyFieldsForAgentSurface(entry);
    }
    // Remotes that inline the bundle instead of sending the flag still
    // answer the documented has_bundle; an explicit remote value is never
    // overwritten.
    if (droppedBundleContent && out.has_bundle === undefined) {
      out.has_bundle = true;
    }
    return out;
  }

  apiApp.post('/api/ai-marketplace/search', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.search(req.body?.params || req.body || {});
      return res.json({ success: true, data: projectSearchPayloadForAgentSurface(data) });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/get-solution', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.getSolution(req.body?.id, {
        expectedType: req.body?.expected_type ?? req.body?.expectedType,
      });
      return res.json({
        success: true,
        data: stripSolutionBodyFieldsForAgentSurface(data),
      });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/get-bundle', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.getBundle(req.body?.id, {
        expectedType: req.body?.expected_type ?? req.body?.expectedType,
      });
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  // Chat-tool projection for list-published: the raw marketplace search
  // payload carries the full SKILL.md (comment) plus *_semantic duplicates —
  // ~24 KB per skill that models must haystack through to copy one solution
  // id (which is how a UUID got mistranscribed in PORTICO-347). Identity,
  // status, and dependency facts survive; body/semantic blobs do not. The
  // renderer keeps the untrimmed payload via its own IPC channel.
  const LIST_PUBLISHED_SOLUTION_FIELDS = Object.freeze([
    "id",
    "solution_id",
    "uuid",
    "name",
    "display_name",
    "description",
    "type",
    "status",
    "publication_state",
    "author",
    "author_display_name",
    "owners",
    "submitted_by",
    "detail_url",
    "created_at",
    "updated_at",
    "created_timestamp",
    "updated_timestamp",
    "allowed_emails",
    "has_bundle",
    "used_by_published_agents",
    "agent_dependency_check_unavailable",
  ]);
  function projectSolutionForAgentSurface(solution) {
    if (!solution || typeof solution !== "object") return solution;
    const projected = {};
    for (const key of LIST_PUBLISHED_SOLUTION_FIELDS) {
      if (key in solution) projected[key] = solution[key];
    }
    return projected;
  }

  apiApp.post('/api/ai-marketplace/list-published', async (req, res) => {
    try {
      // The agentic surface answers "which of these can be unpublished?"
      // from this listing, so each skill carries used_by_published_agents —
      // the same published-agent constraint the unpublish action enforces.
      const data = await aiMarketplaceOperations.listPublished({
        type: req.body?.type,
        includeAgentDependencies: true,
      });
      const projected =
        data && Array.isArray(data.solutions)
          ? { ...data, solutions: data.solutions.map(projectSolutionForAgentSurface) }
          : data;
      return res.json({ success: true, data: projected });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/skill-provenance', async (_req, res) => {
    try {
      const data = await aiMarketplaceOperations.getSkillProvenanceSnapshot();
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/delete-local-skill', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.deleteLocalSkill(
        req.body?.skill_id ?? req.body?.skillId,
      );
      broadcastMarketplaceLinksChanged("skill");
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/clear-deleted-agent-link', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.clearDeletedAgentLink(
        req.body?.agent_id ?? req.body?.agentId,
      );
      broadcastMarketplaceLinksChanged("agent");
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/install', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.install(req.body?.id, {
        existingAgentId: req.body?.existing_agent_id ?? req.body?.existingAgentId,
        refreshInstalledSkillId:
          req.body?.refresh_installed_skill_id ?? req.body?.refreshInstalledSkillId,
        expectedType: req.body?.expected_type ?? req.body?.expectedType,
      });
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  // In-place installed→editable conversion (the control plane's "Convert to
  // editable copy"). Local-only and non-destructive, so unlike publish/
  // unpublish there is no confirmation flow — same policy as install.
  apiApp.post('/api/ai-marketplace/reclaim-agent', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.reclaimInstalledAgent(
        req.body?.agent_id ?? req.body?.agentId,
      );
      broadcastMarketplaceLinksChanged("agent");
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/reclaim-skill', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.reclaimInstalledSkill(
        req.body?.skill_id ?? req.body?.skillId,
      );
      broadcastMarketplaceLinksChanged("skill");
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/publish-agent', async (req, res) => {
    try {
      const agentId = req.body?.agent_id ?? req.body?.agentId;
      const allowedEmails = req.body?.allowed_emails ?? req.body?.allowedEmails;
      let existingSolutionId = req.body?.existing_solution_id ?? req.body?.existingSolutionId;
      // Fetch BEFORE confirming: bad ids or unreadable prompts surface as real
      // errors without any confirmation UI (and inside the START call's short
      // timeout — the polling proxy only starts waiting once the flow is
      // registered), and the modal shows the actual agent card + prompt
      // preview for what would be shared. The elapsed time still shaves the
      // confirm budget so prefetch + confirm + publish stays inside the total
      // flow budget the poller waits out.
      const routeStartedAt = Date.now();
      const prefetched = await Promise.race([
        aiMarketplaceOperations.getAgentForPublish(agentId, {
          existingSolutionId,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    "Timed out loading the agent from the Subagents MCP; try again once the server is running.",
                  ),
                  { code: "agent_fetch_timeout" },
                ),
              ),
            MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS * 1000,
          ),
        ),
      ]);
      // A published agent's link names the republish target — the prefetch
      // adopts it when the caller omitted existing_solution_id, so the modal
      // and the write both see a republish (no UUID round-trip via the model).
      if (!existingSolutionId && prefetched.resolvedExistingSolutionId) {
        existingSolutionId = prefetched.resolvedExistingSolutionId;
      }
      const prefetchElapsedSeconds = Math.ceil((Date.now() - routeStartedAt) / 1000);
      const detail =
        "This shares the agent's name, description, system prompt, and configured skills/tools with everyone who can see it on the AI Marketplace." +
        (Array.isArray(allowedEmails) && allowedEmails.length
          ? `\n\nVisible to: ${allowedEmails.join(", ")}`
          : "\n\nVisibility: discoverable per your marketplace's default rules.");
      const confirm = await confirmAiMarketplaceWriteViaModal(
        {
          mode: "publish-agent",
          title: existingSolutionId ? "Republish agent" : "Publish agent",
          confirmLabel: existingSolutionId ? "Republish" : "Publish",
          summary: detail,
          allowedEmails,
          republish: Boolean(existingSolutionId),
          // Republishes target a known listing — surface its id as the badge.
          solutionId: existingSolutionId || null,
          solutionType: "agents",
          agent: prefetched.agent,
          systemPrompt: prefetched.systemPrompt,
        },
        {
          confirmLabel: existingSolutionId ? "Republish" : "Publish",
          message: `Publish agent "${agentId}" to the AI Marketplace?`,
          detail,
        },
        {
          timeoutSeconds:
            MARKETPLACE_PUBLISH_TIMEOUT_SECONDS - prefetchElapsedSeconds,
          publishDeadlineAt:
            routeStartedAt + MARKETPLACE_PUBLISH_TOTAL_BUDGET_SECONDS * 1000,
        },
      );
      // The consolidated modal runs the dependent-skill pre-flow and the agent
      // publish in the renderer and reports the outcome through the decision.
      // Legacy "approved" (component fallback / native dialog) still publishes
      // main-side through the guarded buildAndPublishAgent below.
      const finishDecision = async (decision) => {
        try {
          if (decision.kind === "published") {
            broadcastMarketplaceLinksChanged("agent");
            return { success: true, data: decision.result };
          }
          if (decision.kind === "publish_failed") {
            return {
              success: false,
              error: decision.error || "The publish failed inside the app.",
              code: decision.code || "publish_failed",
              remediation:
                "The user approved the publish but it failed inside the app; they can retry it from the Agents tab.",
            };
          }
          if (decision.kind === "unknown_outcome") {
            return {
              success: false,
              code: "publish_outcome_unknown",
              error:
                decision.result?.error ||
                "The publish was approved and is still running in the app; check the Agents tab for the outcome.",
            };
          }
          const failure = marketplaceDecisionFailureEnvelope(decision, {
            nothingHappened: "nothing was published",
            deniedError: "Publish was not confirmed by the user.",
          });
          if (failure) {
            return failure;
          }
          const data = await aiMarketplaceOperations.buildAndPublishAgent({
            agentId,
            allowedEmails,
            existingSolutionId,
            prefetched,
          });
          broadcastMarketplaceLinksChanged("agent");
          return { success: true, data };
        } catch (error) {
          return aiMarketplaceErrorEnvelope(error);
        }
      };
      return respondToMarketplaceConfirm(res, confirm, finishDecision);
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/ai-marketplace/publish-skill', async (req, res) => {
    try {
      const skillId = req.body?.skill_id ?? req.body?.skillId;
      let existingSolutionId = req.body?.existing_solution_id ?? req.body?.existingSolutionId;
      // Fetch BEFORE confirming (same budget discipline as publish-agent):
      // bad ids surface without any confirmation UI and the modal shows the
      // real skill card for what would be shared.
      const routeStartedAt = Date.now();
      const prefetched = await Promise.race([
        aiMarketplaceOperations.getSkillForPublish(skillId, {
          existingSolutionId,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    "Timed out loading the skill from the Skills MCP; try again once the server is running.",
                  ),
                  { code: "skill_fetch_timeout" },
                ),
              ),
            MARKETPLACE_PUBLISH_PREFETCH_TIMEOUT_SECONDS * 1000,
          ),
        ),
      ]);
      // Same adoption contract as publish-agent: a published skill's link
      // names the republish target when existing_solution_id was omitted.
      if (!existingSolutionId && prefetched.resolvedExistingSolutionId) {
        existingSolutionId = prefetched.resolvedExistingSolutionId;
      }
      const prefetchElapsedSeconds = Math.ceil((Date.now() - routeStartedAt) / 1000);
      const detail =
        "This shares the skill with everyone at Portico so they can add it to their own AI Chat sessions (its SKILL.md, references, and scripts become visible on the AI Marketplace).";
      const confirm = await confirmAiMarketplaceWriteViaModal(
        {
          mode: "publish-skill",
          title: existingSolutionId
            ? `Republish skill "${skillId}"`
            : `Publish skill "${skillId}"`,
          confirmLabel: existingSolutionId ? "Republish" : "Publish",
          summary: detail,
          republish: Boolean(existingSolutionId),
          // Republishes target a known listing — surface its id as the badge.
          solutionId: existingSolutionId || null,
          solutionType: "skills",
          skill: { ...prefetched.skill, published: Boolean(existingSolutionId) },
        },
        {
          confirmLabel: existingSolutionId ? "Republish" : "Publish",
          message: `Publish skill "${skillId}" to the AI Marketplace?`,
          detail,
        },
        {
          timeoutSeconds:
            MARKETPLACE_PUBLISH_TIMEOUT_SECONDS - prefetchElapsedSeconds,
        },
      );
      const finishDecision = async (decision) => {
        try {
          const failure = marketplaceDecisionFailureEnvelope(decision, {
            nothingHappened: "nothing was published",
            deniedError: "Publish was not confirmed by the user.",
          });
          if (failure) {
            return failure;
          }
          const published = await aiMarketplaceOperations.buildAndPublishSkill({
            skillId,
            existingSolutionId,
          });
          broadcastMarketplaceLinksChanged("skill");
          // Flat identity envelope (publish-agent parity): the chat model
          // copies the solution id from here instead of digging it out of
          // the raw marketplace echo.
          const publishStatus = {
            id: published?.solution_id || null,
            status: published?.publishStatus?.status || "active",
            has_bundle: published?.publishStatus?.has_bundle !== false,
          };
          const action = published?.action === "created" ? "created" : "updated";
          const publishedSkillId = published?.skill_id || String(skillId);
          return {
            success: true,
            data: {
              action,
              solution_id: publishStatus.id,
              skill_id: publishedSkillId,
              name: publishedSkillId,
              data: { ...publishStatus },
              publishStatus,
              message:
                (action === "created"
                  ? `Skill "${publishedSkillId}" published to the AI Marketplace`
                  : `Skill "${publishedSkillId}" marketplace copy updated`) +
                (publishStatus.id ? ` (solution ${publishStatus.id})` : "") +
                `. Marketplace status: ${publishStatus.status}.`,
            },
          };
        } catch (error) {
          return aiMarketplaceErrorEnvelope(error);
        }
      };
      return respondToMarketplaceConfirm(res, confirm, finishDecision);
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  // Skill listings an agent solution references (and which outlive its
  // unpublish): they are the natural next unpublish targets, so the envelope
  // hands their ids over instead of sending models back to the listing
  // haystack. The publish flow spreads the bundle payload top-level onto
  // agent solutions, so refs are usually right on the envelope; spec-shaped
  // envelopes carry neither refs nor an inline bundle (bundle content lives
  // behind the bundle route only), so those fetch the published payload
  // once; trimmed listings fall back to the local skill-links registry.
  // A solution's inline bundle payload may arrive as an object or a JSON
  // string depending on the marketplace surface. Returns the payload object
  // or null.
  function parseInlineSolutionBundlePayload(container) {
    const raw = container?.bundle?.payload;
    if (!raw) return null;
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function collectAgentSolutionSkillListings(solution) {
    let refs = Array.isArray(solution?.skill_refs)
      ? solution.skill_refs
      : Array.isArray(solution?.bundle?.payload?.skill_refs)
        ? solution.bundle.payload.skill_refs
        : [];
    if (!refs.length && solution?.id && solution?.has_bundle !== false) {
      // One-shot convenience fetch on an explicit user-confirmed unpublish —
      // never required: failures fall through to the registry below.
      try {
        const bundle = await aiMarketplaceOperations.getBundle(solution.id);
        if (Array.isArray(bundle?.payload?.skill_refs)) {
          refs = bundle.payload.skill_refs;
        }
      } catch {
        // No readable bundle: the unpublish result stays valid without refs.
      }
    }
    const listings = [];
    const seen = new Set();
    for (const ref of refs) {
      if (listings.length >= 50) break;
      if (!ref || ref.kind !== "solution") continue;
      const skillId = typeof ref.skill_id === "string" ? ref.skill_id.trim() : "";
      const refSolutionId =
        typeof ref.solution_id === "string" ? ref.solution_id.trim() : "";
      if (!skillId || !refSolutionId || seen.has(skillId)) continue;
      seen.add(skillId);
      listings.push({ skill_id: skillId, solution_id: refSolutionId });
    }
    if (listings.length) return listings;
    try {
      const skillIds = Array.isArray(solution?.skill_ids) ? solution.skill_ids : [];
      // One registry read for the whole batch: getLink() re-reads and re-parses
      // the entire links file per call.
      const links = skillIds.length ? await aiMarketplaceSkillLinks.listLinks() : {};
      for (const rawId of skillIds) {
        if (listings.length >= 50) break;
        const leaf = aiMarketplaceSkillLinks.canonicalSkillName(rawId);
        if (!leaf || seen.has(leaf)) continue;
        const link = links[leaf];
        if (!link?.solutionId) continue;
        seen.add(leaf);
        listings.push({ skill_id: leaf, solution_id: link.solutionId });
      }
    } catch {
      // Registry unavailable: the unpublish result stays valid without the
      // convenience listing.
    }
    return listings;
  }

  apiApp.post('/api/ai-marketplace/unpublish', async (req, res) => {
    try {
      const id = req.body?.id ?? req.body?.solution_id;
      const expectedType = req.body?.expected_type ?? req.body?.expectedType;
      const detail = "This unpublishes it for everyone. Installed copies are not affected.";
      // Ownership and type are proven before any confirmation UI. Discovery
      // search/get results are not authority for an unpublish.
      const routeStartedAt = Date.now();
      const targetSolution = await aiMarketplaceOperations.getOwnedSolutionForWrite(
        id,
        { expectedType },
      );
      const targetName = (
        typeof targetSolution?.name === "string" && targetSolution.name.trim()
          ? targetSolution.name.trim()
          : String(id)
      ).slice(0, 180);
      const targetIsSkill =
        typeof targetSolution?.type === "string" &&
        targetSolution.type.trim().toLowerCase() === "skills";
      // Fast-fail BEFORE the confirmation modal: a skill listing that a
      // published agent still references can never be unpublished, so don't
      // make the user sit through a doomed confirm. deletePublishedSolution
      // re-runs the same check at execution time (the enforcement point).
      if (targetIsSkill) {
        await aiMarketplaceOperations.assertSolutionUnpublishableOnMarketplace(
          id,
          targetSolution?.type,
        );
      }
      // Card facts for the confirmation modal. Older renderer-published agent
      // listings carry no flattened fields (the bundle-payload spread was lost
      // when publishing consolidated onto the renderer path), so recover them
      // from the published bundle: inline payload first, else one bundle
      // fetch. Display-only and best-effort — a sparse card never blocks the
      // unpublish.
      let agentCardBundlePayload = null;
      if (!targetIsSkill) {
        const hasFlattenedAgentCardFields = Boolean(
          targetSolution?.base_model_id ||
            targetSolution?.reasoning_effort ||
            (Array.isArray(targetSolution?.skill_ids) &&
              targetSolution.skill_ids.length) ||
            (Array.isArray(targetSolution?.tool_server_ids) &&
              targetSolution.tool_server_ids.length),
        );
        if (!hasFlattenedAgentCardFields) {
          agentCardBundlePayload = parseInlineSolutionBundlePayload(targetSolution);
          if (!agentCardBundlePayload && targetSolution?.has_bundle !== false) {
            try {
              const bundle = await aiMarketplaceOperations.getBundle(id);
              agentCardBundlePayload = parseInlineSolutionBundlePayload({ bundle });
            } catch {
              // No readable bundle: the card renders sparse, unpublish proceeds.
            }
          }
        }
      }
      const agentCardField = (key) => {
        const top = targetSolution?.[key];
        const topHasValue = Array.isArray(top) ? top.length > 0 : Boolean(top);
        return topHasValue ? top : agentCardBundlePayload?.[key];
      };
      const prefetchElapsedSeconds = Math.ceil((Date.now() - routeStartedAt) / 1000);
      const confirm = await confirmAiMarketplaceWriteViaModal(
        {
          mode: "unpublish",
          title: `Remove "${targetName}" from the AI Marketplace`,
          confirmLabel: "Unpublish",
          summary: detail,
          solutionId: targetSolution?.id || String(id),
          solutionType: targetSolution?.type,
          skill: targetIsSkill
            ? {
                name: targetName,
                description:
                  typeof targetSolution.description === "string"
                    ? targetSolution.description
                    : "",
                source: "user",
                version:
                  typeof targetSolution.version === "string"
                    ? targetSolution.version
                    : "1.0",
                author:
                  typeof targetSolution.author === "string" ? targetSolution.author : "",
                // USER-source skill cards show only the authenticated creator
                // (the frontmatter author is spoofable) — without this the
                // owner badge renders "Unknown".
                created_by_email:
                  typeof targetSolution?.submitted_by === "string"
                    ? targetSolution.submitted_by
                    : "",
                published: true,
              }
            : null,
          // Agent-type listings: flattened agent facts come from the listing
          // when the publish path spread them top-level, with the published
          // bundle payload as the fallback for older renderer-published
          // listings. Display-only; id doubles as the solution id.
          agent: targetIsSkill
            ? null
            : {
                id: targetSolution?.id || String(id),
                name: targetName,
                description:
                  typeof targetSolution?.description === "string" &&
                  targetSolution.description
                    ? targetSolution.description
                    : typeof agentCardBundlePayload?.description === "string"
                      ? agentCardBundlePayload.description
                      : "",
                base_model_id: agentCardField("base_model_id"),
                reasoning_effort: agentCardField("reasoning_effort"),
                skill_ids: agentCardField("skill_ids"),
                tool_server_ids: agentCardField("tool_server_ids"),
                created_by_email: targetSolution?.submitted_by,
              },
        },
        {
          confirmLabel: "Unpublish",
          message: `Remove solution "${targetName}" from the AI Marketplace?`,
          detail,
        },
        {
          timeoutSeconds:
            MARKETPLACE_PUBLISH_TIMEOUT_SECONDS - prefetchElapsedSeconds,
        },
      );
      const finishDecision = async (decision) => {
        try {
          const failure = marketplaceDecisionFailureEnvelope(decision, {
            nothingHappened: "nothing was unpublished",
            deniedError: "Unpublish was not confirmed by the user.",
          });
          if (failure) {
            return failure;
          }
          // Agent targets resolve their dependent-listing refs BEFORE the
          // delete: once the listing is gone its bundle route 404s, and the
          // refs describe the payload that was published, not what remains.
          const dependentSkillListings = targetIsSkill
            ? null
            : await collectAgentSolutionSkillListings(
                // Reuse the card-recovery payload so a trimmed listing does
                // not trigger a second bundle fetch here.
                agentCardBundlePayload
                  ? { ...targetSolution, bundle: { payload: agentCardBundlePayload } }
                  : targetSolution,
              );
          const removal = await aiMarketplaceOperations.deletePublishedSolution(id, {
            expectedType,
            ownershipChecked: true,
            ownedSolutionType: targetSolution?.type,
          });
          broadcastMarketplaceLinksChanged(targetIsSkill ? "skill" : "unknown");
          // Identity envelope: say what was removed and what it touched
          // locally, instead of echoing the bare marketplace DELETE body.
          const envelope = {
            action: "unpublished",
            solution_id: String(id),
            name: targetName,
            type: targetSolution?.type || expectedType || null,
            message: `"${targetName}" (solution ${id}) removed from the AI Marketplace.`,
          };
          if (targetIsSkill) {
            envelope.skill_links_cleared = Array.isArray(removal?.clearedSkillLinks)
              ? removal.clearedSkillLinks.slice(0, 50)
              : [];
          } else {
            envelope.local_agent_ids_unlinked = Array.isArray(removal?.clearedAgentIds)
              ? removal.clearedAgentIds.slice(0, 50)
              : [];
            envelope.dependent_skill_listings = dependentSkillListings;
          }
          return { success: true, data: envelope };
        } catch (error) {
          return aiMarketplaceErrorEnvelope(error);
        }
      };
      return respondToMarketplaceConfirm(res, confirm, finishDecision);
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  // Flow-status polling contract for the marketplace write confirmations
  // (publish-agent / publish-skill / unpublish) — the same start+poll shape
  // as /api/user-question-flow-status. `routeOutcome` (not the flow's own
  // status) gates completion: legacy-approved decisions keep running the
  // main-side publish after the flow entry itself completes.
  apiApp.get('/api/ai-marketplace/publish-flow-status/:flowId', (req, res) => {
    const { flowId } = req.params;
    const entry = state.marketplacePublishFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }
    if (!entry.routeOutcome) {
      return res.json({
        success: true,
        flow_id: flowId,
        status: 'in_progress',
        elapsed_ms: Date.now() - entry.startedAt,
      });
    }
    return res.json({
      success: true,
      flow_id: flowId,
      status: 'completed',
      result: entry.routeOutcome,
      elapsed_ms: Math.max(0, (entry.routeOutcomeAt || Date.now()) - entry.startedAt),
    });
  });

  // Best-effort abandonment hook for the polling proxy (mirrors
  // /api/cancel-user-question-flow): dismisses the pending confirmation so an
  // orphaned modal never sits around after the tool call gave up.
  apiApp.post('/api/ai-marketplace/cancel-publish-flow', (req, res) => {
    const flowId = typeof req.body?.flow_id === 'string' ? req.body.flow_id.trim() : '';
    const reason =
      (typeof req.body?.reason === 'string' && req.body.reason.trim()) || 'tool_cancelled';
    if (!flowId) {
      return res.status(400).json({ success: false, error: 'flow_id is required' });
    }
    const entry = state.marketplacePublishFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }
    if (entry.status !== 'in_progress') {
      return res.json({ success: true, flow_id: flowId, status: 'already_completed' });
    }
    terminateMarketplacePublishFlow(flowId, buildMarketplacePublishCancelledResult(entry, reason));
    console.log(`[API] Cancelled marketplace publish flow ${flowId} (${reason})`);
    return res.json({ success: true, flow_id: flowId, status: 'cancelled' });
  });

  apiApp.post('/api/ai-marketplace/update', async (req, res) => {
    try {
      const data = await aiMarketplaceOperations.updatePublishedSolution(
        req.body?.id,
        req.body?.patch || {},
        {
          localAgentId:
            req.body?.local_agent_id ?? req.body?.localAgentId ?? "",
          localSkillId:
            req.body?.local_skill_id ?? req.body?.localSkillId ?? "",
        },
      );
      broadcastMarketplaceLinksChanged("unknown");
      return res.json({ success: true, data });
    } catch (error) {
      return sendAiMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces', async (req, res) => {
    try {
      const sourceInput = req.body?.source_input ?? req.body?.sourceInput;
      const marketplace = await marketplaceService.addMarketplace({
        projectRoot: bootstrap.PROJECT_ROOT,
        sourceInput,
        interactiveAuth: true,
        logger: console,
      });
      return res.json({ success: true, marketplace });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/remove', async (req, res) => {
    try {
      const marketplaceId = req.body?.marketplace_id ?? req.body?.marketplaceId;
      const removeInstalledSkills =
        req.body?.remove_installed_skills ?? req.body?.removeInstalledSkills ?? false;
      const result = await marketplaceService.removeMarketplace({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        removeInstalledSkills,
        logger: console,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  // Shared with the removal executor route below: publish-link sidecar
  // cleanup for skills the destructive sync removed.
  async function clearRemovedSkillSidecarLinksApi(removed) {
    const skillIds = (Array.isArray(removed) ? removed : [])
      .map((entry) => entry?.skillId)
      .filter(Boolean);
    if (!skillIds.length) return;
    try {
      // One registry rewrite for the batch: clearLink() serializes a full
      // read-modify-write per skill on the shared write chain.
      await require('./ai-marketplace-skill-links').clearLinks(skillIds);
    } catch (error) {
      console.warn(
        `[Marketplace] Could not clear publish links for removed skills ${skillIds.join(', ')}: ${error.message}`,
      );
    }
  }

  function marketplaceSyncAgentReferencesReaderApi() {
    const { buildSyncAgentTools } = require('./marketplace-sync-agent-tools');
    return buildSyncAgentTools().listReferences;
  }

  apiApp.post('/api/marketplaces/sync', async (req, res) => {
    try {
      const marketplaceId = req.body?.marketplace_id ?? req.body?.marketplaceId;
      const result = await marketplaceService.syncMarketplace({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        interactiveAuth: true,
        logger: console,
        listAgentReferences: marketplaceSyncAgentReferencesReaderApi(),
      });
      await clearRemovedSkillSidecarLinksApi(result.skillsRemoved);
      // Chat-tool projection: result.marketplace embeds the whole refreshed
      // cachedManifest; the model needs the sync verdicts, not the catalog.
      return res.json({
        success: true,
        marketplace: {
          id: result.marketplace.id,
          name: result.marketplace.name,
          marketplaceVersion: result.marketplace.marketplaceVersion,
          lastSynced: result.marketplace.lastSynced || null,
          skill_count: marketplaceService.countTotalSkills(
            result.marketplace.cachedManifest,
          ),
        },
        hasUpdate: result.hasUpdate,
        skillsUpdated: result.skillsUpdated,
        skillsConflicted: result.skillsConflicted,
        skillsUpToDate: result.skillsUpToDate,
        skillSyncErrors: result.skillSyncErrors,
        skillsRemoved: result.skillsRemoved,
        skillsSourceMissing: result.skillsSourceMissing,
        pendingRemovals: result.pendingRemovals,
        agentInventoryUnavailable: result.agentInventoryUnavailable,
        // Agent-facing guidance: pendingRemovals require explicit consent.
        remediation: result.pendingRemovals?.length
          ? 'Some installed skills no longer exist upstream and are used by agents. Show the pendingRemovals list to the user; after they explicitly confirm, call apply_marketplace_sync_removals with confirm=true.'
          : undefined,
      });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/sync-all', async (req, res) => {
    try {
      const results = await marketplaceService.syncAllMarketplaces({
        projectRoot: bootstrap.PROJECT_ROOT,
        interactiveAuth: true,
        logger: console,
        listAgentReferences: marketplaceSyncAgentReferencesReaderApi(),
      });
      for (const result of results) {
        await clearRemovedSkillSidecarLinksApi(result?.skillsRemoved);
      }
      return res.json({ success: true, results });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/apply-sync-removals', async (req, res) => {
    try {
      const marketplaceId = req.body?.marketplace_id ?? req.body?.marketplaceId;
      const removals = Array.isArray(req.body?.removals) ? req.body.removals : [];
      const { buildSyncAgentTools } = require('./marketplace-sync-agent-tools');
      const result = await marketplaceService.applyMarketplaceSyncRemovals({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        removals,
        logger: console,
        agentTools: buildSyncAgentTools(),
      });
      await clearRemovedSkillSidecarLinksApi(result.removed);
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.get('/api/marketplaces/:marketplaceId/skills', async (req, res) => {
    try {
      const result = await marketplaceService.getMarketplaceSkills({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId: req.params.marketplaceId,
        // Chat surface: never pop interactive GitLab auth from a tool call;
        // a cache-miss on a private repo fails with an auth error instead.
        // The control plane's IPC path keeps interactive auth.
        interactiveAuth: false,
        logger: console,
      });

      // Optional agentic filters so a model can ask for one plugin or a
      // matching subset instead of the full catalog.
      const pluginFilter = String(req.query?.plugin_name || "").trim();
      const searchFilter = String(req.query?.search || "").trim().toLowerCase();
      const limitRaw = Number.parseInt(String(req.query?.limit || ""), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;

      let skills = result.skills;
      if (pluginFilter) {
        skills = skills.filter((skill) => (skill.pluginName || "") === pluginFilter);
      }
      if (searchFilter) {
        skills = skills.filter((skill) =>
          `${skill.id} ${skill.display_name || ""} ${skill.description || ""}`
            .toLowerCase()
            .includes(searchFilter),
        );
      }
      const totalMatching = skills.length;
      if (limit !== null) {
        skills = skills.slice(0, limit);
      }

      // Chat-tool projection: the raw entries duplicate id/name/displayName
      // and the marketplace object carries the whole cachedManifest the
      // catalog was parsed from (a second copy of every description).
      return res.json({
        success: true,
        skills: skills.map((skill) => ({
          id: skill.id,
          display_name: skill.display_name,
          description: skill.description,
          pluginName: skill.pluginName ?? null,
          skillPath: skill.skillPath,
          // Needed as the install tool's skill_source arg for external-source
          // plugins; null means "the marketplace's own repository".
          ...(skill.skillSource ? { skillSource: skill.skillSource } : {}),
          available: skill.available !== false,
          ...(skill.unavailableReason
            ? { unavailableReason: skill.unavailableReason }
            : {}),
          installed: skill.installed === true,
          ...(skill.installed
            ? {
                installedVersion: skill.installedVersion,
                hasUpdate: skill.hasUpdate === true,
                isDirty: skill.isDirty === true,
                hasConflict: skill.hasConflict === true,
                localPath: skill.localPath,
              }
            : {}),
        })),
        total_matching: totalMatching,
        marketplace: {
          id: result.marketplace.id,
          name: result.marketplace.name,
          description: result.marketplace.description,
          marketplaceVersion: result.marketplace.marketplaceVersion,
          isSparse: result.marketplace.isSparse === true,
          skill_count: marketplaceService.countTotalSkills(
            result.marketplace.cachedManifest,
          ),
        },
      });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/skills/install', async (req, res) => {
    try {
      const result = await marketplaceService.installMarketplaceSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId: req.body?.marketplace_id ?? req.body?.marketplaceId,
        skillId: req.body?.skill_id ?? req.body?.skillId,
        skillPath: req.body?.skill_path ?? req.body?.skillPath,
        skillSource: req.body?.skill_source ?? req.body?.skillSource,
        pluginName: req.body?.plugin_name ?? req.body?.pluginName ?? null,
        interactiveAuth: true,
        logger: console,
      });
      return res.json({
        success: true,
        localPath: result.localPath,
        version: result.version,
        pluginName: result.pluginName ?? null,
        display_name: result.display_name ?? null,
        // True only after the installed-skill record was written to
        // marketplaces.json (the service throws otherwise) — lets the model
        // distinguish "files on disk" from "registered install".
        registered: true,
        marketplace_id: req.body?.marketplace_id ?? req.body?.marketplaceId ?? null,
        skill_id: req.body?.skill_id ?? req.body?.skillId ?? null,
      });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/skills/uninstall', async (req, res) => {
    try {
      // Referential integrity: guarded at the entry funnel (this route is the
      // agentic uninstall_marketplace_skill tool's target) — internal
      // rollback/detach flows call the service directly and stay unguarded.
      await agentSkillUsageGuard.assertSkillDeletable({
        leafName: req.body?.skill_id ?? req.body?.skillId,
      });
      const result = await marketplaceService.uninstallMarketplaceSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId: req.body?.marketplace_id ?? req.body?.marketplaceId,
        skillId: req.body?.skill_id ?? req.body?.skillId,
        pluginName: req.body?.plugin_name ?? req.body?.pluginName ?? null,
        logger: console,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/skills/detach', async (req, res) => {
    try {
      const result = await marketplaceService.detachMarketplaceSkillToUserSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId: req.body?.marketplace_id ?? req.body?.marketplaceId,
        skillId: req.body?.skill_id ?? req.body?.skillId,
        targetSkillName: req.body?.target_skill_name ?? req.body?.targetSkillName,
        pluginName: req.body?.plugin_name ?? req.body?.pluginName ?? null,
        logger: console,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/skills/check-updates', async (req, res) => {
    try {
      const result = await marketplaceService.checkSkillUpdates({
        projectRoot: bootstrap.PROJECT_ROOT,
        // Chat surface: passive scan semantics (same as the renderer's
        // freshness sweeps) — a tool call must never pop a GitLab sign-in.
        interactiveAuth: false,
        // Solutions-marketplace installs compare the listing's updated_at;
        // without these callbacks the chat tool silently skipped them.
        searchSolutions: (params) =>
          // Same 12s cap as the renderer sweep: a backend body stall must
          // cost seconds, not the client's 30s default.
          require('./ai-marketplace-operations').search(params, { timeoutMs: 12_000 }),
        fetchSolution: (solutionId) =>
          require('./ai-marketplace-operations').getSolution(solutionId),
        logger: console,
      });
      // Agent-side sweep (installed agent links vs their listings). Fully
      // independent of the skill scan: a failure here degrades to an error
      // note instead of failing the whole check.
      let agentUpdates = { updates: [], hasUpdates: false };
      try {
        agentUpdates = await aiMarketplaceOperations.checkInstalledAgentUpdates();
      } catch (error) {
        agentUpdates = { updates: [], hasUpdates: false, error: error?.message };
      }
      return res.json({
        success: true,
        updates: result.updates,
        hasUpdates: result.hasUpdates,
        agent_updates: agentUpdates.updates,
        agents_have_updates: agentUpdates.hasUpdates,
        ...(agentUpdates.error ? { agent_updates_error: agentUpdates.error } : {}),
      });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  // Provenance gate consulted by the subagents server before agent
  // create/update applies skill additions. Pure local resolution against the
  // loaded registry — no network.
  apiApp.post('/api/agent-skills/validate-attachable', async (req, res) => {
    try {
      const skillIds = Array.isArray(req.body?.skill_ids)
        ? req.body.skill_ids
        : Array.isArray(req.body?.skillIds)
          ? req.body.skillIds
          : [];
      const config = await marketplaceService.loadMarketplacesConfig(
        bootstrap.PROJECT_ROOT,
        { logger: console },
      );
      const { validateAttachableSkillIds } = require('./marketplace-allowlist');
      const result = validateAttachableSkillIds(config, skillIds);
      const { logMarketplaceDiag } = require('./marketplace-diagnostics');
      logMarketplaceDiag(
        'attach',
        result.rejected.length ? 'validate:rejected' : 'validate:ok',
        {
          requestedCount: skillIds.length,
          allowedCount: result.allowed.length,
          rejected: result.rejected.map((entry) => ({
            id: entry.id,
            reason: entry.reason,
          })),
        },
        result.rejected.length ? 'warn' : 'info',
      );
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  apiApp.post('/api/marketplaces/skills/update', async (req, res) => {
    try {
      const marketplaceId = req.body?.marketplace_id ?? req.body?.marketplaceId;
      const skillId = req.body?.skill_id ?? req.body?.skillId;
      // Solutions-marketplace installs have no git marketplace entry; their
      // update path is a refresh-in-place reinstall of the linked solution
      // (the same refreshInstalledSkillId flow the GUI freshness refresh
      // uses). Before this branch, the ONLY agentic way to apply a flagged
      // update was delete+reinstall — which the in-use guard rightly blocks
      // for skills attached to agents.
      if (String(marketplaceId || "").trim() === "ai-marketplace") {
        const snapshot = await aiMarketplaceOperations.getSkillProvenanceSnapshot();
        const canonicalSkillId = String(skillId || "").trim().replace(/^ai-marketplace\//, "");
        const installed = (snapshot?.installed_skills || []).find((entry) => {
          const localPath = String(entry?.local_path || "");
          return (
            localPath === `skills-marketplace/ai-marketplace/${canonicalSkillId}` &&
            entry?.marketplace_solution_id
          );
        });
        if (!installed) {
          return sendMarketplaceError(res, Object.assign(
            new Error(
              `No installed AI Marketplace solution matches skill "${canonicalSkillId}".`,
            ),
            { code: "skill_not_found" },
          ));
        }
        const refreshed = await aiMarketplaceOperations.install(
          installed.marketplace_solution_id,
          { interactiveAuth: false, refreshInstalledSkillId: canonicalSkillId },
        );
        return res.json({
          success: true,
          refreshed: true,
          skill_id: canonicalSkillId,
          solution_id: installed.marketplace_solution_id,
          installedPath: refreshed?.installedPath || null,
          version: refreshed?.version ?? null,
        });
      }
      const result = await marketplaceService.updateMarketplaceSkill({
        projectRoot: bootstrap.PROJECT_ROOT,
        marketplaceId,
        skillId,
        pluginName: req.body?.plugin_name ?? req.body?.pluginName ?? null,
        forceDiscardLocalChanges:
          req.body?.force_discard_local_changes ??
          req.body?.forceDiscardLocalChanges ??
          false,
        interactiveAuth: true,
        logger: console,
      });
      return res.json({ success: true, version: result.version });
    } catch (error) {
      return sendMarketplaceError(res, error);
    }
  });

  // ============================================================================
  // OAUTH LOGGING ENDPOINT
  // ============================================================================

  // POST /api/oauth-log - Receive OAuth logs from Docker containers and other sources
  apiApp.post('/api/oauth-log', (req, res) => {
    const { layer, level, message } = req.body;
    try {
      const { logOAuth } = require('./oauth-logger');
      logOAuth(layer || 'MCPO', level || 'INFO', message || '');
      res.json({ success: true });
    } catch (error) {
      // OAuth logger may not be initialized yet
      console.log(`[OAuth:${layer || 'MCPO'}] ${message || ''}`);
      res.json({ success: true, fallback: true });
    }
  });

  // ============================================================================
  // MCP RESTART ENDPOINT
  // ============================================================================

  // Operation-native REST surface. Compatibility mutation routes below also
  // acknowledge immediately and preserve their legacy response fields; callers
  // can hydrate authoritative snapshots by operation id.
  apiApp.post('/api/mcp-operations', (req, res) => {
    try {
      const kind = String(req.body?.kind || '').trim();
      const serverIds = Array.isArray(req.body?.serverIds)
        ? req.body.serverIds
        : Array.isArray(req.body?.server_ids)
          ? req.body.server_ids
          : [];
      const operation = mcpOperationService.startMcpOperation({
        clientRequestId: mcpOperationClientRequestId(req, `rest:${kind || 'unknown'}`),
        kind,
        serverIds,
      });
      return res.status(202).json({
        success: true,
        operationId: operation.operationId,
        operation,
        results: [],
        errors: [],
      });
    } catch (error) {
      return sendMcpOperationError(res, error);
    }
  });

  apiApp.get('/api/mcp-operations/active', (_req, res) => {
    try {
      const operation = mcpOperationService.getActiveMcpOperation();
      return res.json({
        success: true,
        operationId: operation?.operationId || null,
        operation,
      });
    } catch (error) {
      return sendMcpOperationError(res, error);
    }
  });

  apiApp.get('/api/mcp-operations/:operationId', (req, res) => {
    try {
      const operation = mcpOperationService.getMcpOperation(
        String(req.params.operationId || '').trim(),
      );
      if (!operation) {
        const error = new Error(`MCP operation ${req.params.operationId} was not found`);
        error.code = 'MCP_OPERATION_NOT_FOUND';
        throw error;
      }
      return res.json({
        success: true,
        operationId: operation.operationId,
        operation,
      });
    } catch (error) {
      return sendMcpOperationError(res, error);
    }
  });

  // POST /api/restart-mcp - Silent MCP infrastructure restart
  apiApp.post('/api/restart-mcp', async (req, res) => {
    const msg = '[API] ✅ Received restart-mcp request\n';
    console.log(msg);
    sendInitLog(msg, 'info');

    if (mcpOperationService.hasMcpOperationCoordinator()) {
      try {
        const rawToggleState = dockerMcp.loadRawMcpToggles({ includeMeta: true });
        if (rawToggleState.parseError) {
          const error = new Error(
            `Cannot restart MCP servers: ${rawToggleState.parseError.message}`,
          );
          error.code = 'MCP_TOGGLES_PARSE_ERROR';
          throw error;
        }
        const enabledServerIds = Object.entries(
          dockerMcp.computeEffectiveMcpToggles(rawToggleState.toggles || {}),
        )
          .filter(([, enabled]) => enabled === true)
          .map(([serverId]) => serverId)
          .filter((serverId) => dockerMcp.isKnownMcpServerId(serverId));
        if (enabledServerIds.length === 0) {
          return res.json({
            success: true,
            operationId: null,
            operation: null,
            results: [],
            errors: [],
            logs: [],
            healthCheckPassed: true,
            message: 'No enabled MCP servers require restart',
          });
        }

        const operationResult = await startCompatibilityMcpOperation(
          req,
          'restart',
          enabledServerIds,
          {
            onStarted(operation) {
              BrowserWindow.getAllWindows().forEach((window) => {
                if (!window.isDestroyed()) {
                  window.webContents.send('mcp-restart-started', {
                    operationId: operation.operationId,
                  });
                }
              });
              broadcastMcpRestartCompletionWhenTerminal(operation.operationId);
            },
          },
        );
        return res.status(operationResultHttpStatus(operationResult)).json({
          ...operationResult,
          logs: [],
          healthCheckPassed: false,
          message: 'MCP server restart operation started',
        });
      } catch (error) {
        if (error.code !== 'MCP_OPERATION_BUSY') {
          broadcastMcpRestartComplete({
            success: false,
            operationId: error.operationId || null,
            error: error.message,
          });
        }
        return sendMcpOperationError(res, error);
      }
    }

    // Broadcast to all windows that MCP restart is starting
    console.log('[API] Broadcasting mcp-restart-started to all windows');
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send('mcp-restart-started');
      }
    });

    try {
      // Run initialization with log collection
      const result = await runMcpInitialization({
        skipDockerCheck: false,
        logCollector: null  // Logs are collected internally
      });

      // Format logs for response
      const formattedLogs = result.logs.map(log =>
        `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.text}`
      );

      console.log(`[API] MCP restart ${result.success ? 'succeeded' : 'failed'}`);

      // After restart completes, run full health check and broadcast to all windows
      console.log('[API] Running full health check and broadcasting status...');
      queueFullHealthCheck("mcp-restart", { immediate: true });

      // Broadcast completion to all windows
      console.log('[API] Broadcasting mcp-restart-complete to all windows');
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('mcp-restart-complete', {
            success: result.success,
            error: result.success ? undefined : result.errors.join('\n')
          });
        }
      });

      res.json({
        success: result.success,
        logs: formattedLogs,
        healthCheckPassed: result.healthCheckPassed,
        error: result.success ? undefined : result.errors.join('\n')
      });
    } catch (error) {
      const errMsg = `[API] ❌ MCP restart error: ${error.message}\n`;
      console.error(errMsg);
      sendInitLog(errMsg, 'error');

      // Broadcast failure to all windows
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('mcp-restart-complete', {
            success: false,
            error: error.message
          });
        }
      });

      res.status(500).json({
        success: false,
        logs: [`Critical error: ${error.message}`],
        error: error.message
      });
    }
  });

  // ============================================================================
  // SINGLE SERVER RESTART ENDPOINT
  // ============================================================================

  // POST /api/restart-mcp-server/:serverId - Restart a single MCP server
  // Used by MCP Assistant tool for targeted server restart
  apiApp.post('/api/restart-mcp-server/:serverId', async (req, res) => {
    const { serverId } = req.params;
    const automaticRecovery =
      req.body?.automaticRecovery === true &&
      req.body?.recoverySource === 'mcp-orc';
    const recoveryMetadata = automaticRecovery
      ? {
          source: 'mcp-orc',
          automaticRecovery: true,
          recoveryReason:
            String(req.body?.recoveryReason || 'automatic_timeout_recovery'),
          serverId,
        }
      : undefined;
    const msg = `[API] ✅ Received restart request for server: ${serverId}\n`;
    console.log(msg);
    sendInitLog(msg, 'info');

    if (mcpOperationService.hasMcpOperationCoordinator()) {
      try {
        const operationResult = await startCompatibilityMcpOperation(
          req,
          'restart',
          [serverId],
          { metadata: recoveryMetadata },
        );
        const result = firstMcpOperationResult(operationResult, serverId);
        const row = operationResult.operation?.rows?.find(
          (entry) => (entry.serverId || entry.id) === serverId,
        );
        const response = {
          ...operationResult,
          server_id: serverId,
          mode: row?.deploymentType || 'docker',
          healthy: result?.healthy === true,
          readiness_phase: result?.readiness_phase || 'failed',
          message: operationResult.success
            ? result?.pending
              ? `Server ${serverId} restart operation started.`
              : result?.requiresConfiguration
                ? `Server ${serverId} requires configuration before it can restart.`
                : result?.requiresAuthentication
                  ? `Server ${serverId} restarted and requires authentication.`
                  : result?.healthy
                    ? `Server ${serverId} restarted successfully and its tools are ready.`
                    : `Server ${serverId} restart completed but requires attention.`
            : `Failed to restart server ${serverId}`,
        };
        return res.status(operationResultHttpStatus(operationResult)).json(response);
      } catch (error) {
        return sendMcpOperationError(res, error);
      }
    }

    if (automaticRecovery) {
      return res.status(503).json({
        success: false,
        server_id: serverId,
        errorCode: 'MCP_OPERATION_COORDINATOR_UNAVAILABLE',
        error: 'Automatic MCP recovery requires the operation coordinator.',
      });
    }

    try {
      const deploymentType = await getDeploymentTypeForServer(serverId);

      // PORTICO-224: do not restart a server whose required env vars are missing —
      // the generated config would expand its placeholders to empty strings.
      // Mirrors the toggle-enable NOT_CONFIGURED preflight.
      const preflightIssue = detectToggleEnablePreflightIssue(serverId, {
        projectRoot: bootstrap.PROJECT_ROOT,
        findServerYaml: dockerMcp.findServerYaml,
        parseYaml: dockerMcp.parseYaml,
        parseEnvFile: dockerMcp.parseEnvFile,
        checkServerConfigured: dockerMcp.checkServerConfigured,
      });
      if (
        preflightIssue &&
        isConfigurationRequiredPreflightIssue(preflightIssue)
      ) {
        console.log(
          `[API] ${serverId} restart skipped because configuration is incomplete`,
        );
        clearStartupFailure(bootstrap.PROJECT_ROOT, serverId, {
          logger: console,
        });
        updateServerPhase(serverId, READINESS_PHASE_NOT_CONFIGURED, {
          deploymentType,
          error: preflightIssue.error,
        });
        scheduleLifecycleHealthSync();
        return res.json({
          success: true,
          server_id: serverId,
          restarted: false,
          requiresConfiguration: true,
          requiresSecretReplacement:
            preflightIssue.requiresSecretReplacement === true,
          configurationIssue:
            preflightIssue.configurationIssue || undefined,
          requiredAction: preflightIssue.requiredAction || 'configure',
          uiStatus: 'not_configured',
          errorCode: preflightIssue.errorCode,
          error: preflightIssue.error,
          healthy: false,
          readiness_phase: READINESS_PHASE_NOT_CONFIGURED,
          message: preflightIssue.message,
          recoveryPrompt: preflightIssue.recoveryPrompt || undefined,
          recoveryLabel: preflightIssue.recoveryLabel || undefined,
        });
      }

      const restartSummary = await restartServerAndWaitReady(serverId, {
        deploymentType,
        restartReason: 'restart-mcp-server',
        healthReason: 'mcp-server-restart',
        maxWaitMs: TOOL_READY_TIMEOUT_MS,
      });

      if (restartSummary.success) {
        const successMsg = `[API] Server ${serverId} restarted successfully (mode: ${restartSummary.mode || 'docker'}, healthy=${restartSummary.healthy}, phase=${restartSummary.readinessPhase || 'unknown'})\n`;
        console.log(successMsg);
        sendInitLog(successMsg, 'info');

        res.json({
          success: true,
          server_id: serverId,
          mode: restartSummary.mode || 'docker',
          healthy: restartSummary.healthy,
          readiness_phase:
            restartSummary.readinessPhase ||
            (restartSummary.healthy
              ? READINESS_PHASE_TOOL_READY
              : READINESS_PHASE_STARTING),
          message: restartSummary.healthy
            ? `Server ${serverId} restarted successfully and its tools are ready.`
            : `Server ${serverId} restarted successfully but its tools are still starting.`,
          ...(restartSummary.readinessError
            ? { readiness_error: restartSummary.readinessError }
            : {}),
        });
      } else {
        safeQueueFullHealthCheck('mcp-server-restart');
        const errMsg = `[API] ❌ Failed to restart server ${serverId}: ${restartSummary.error}\n`;
        console.error(errMsg);
        sendInitLog(errMsg, 'error');

        const statusCode =
          restartSummary.errorCode === 'SERVICE_NOT_FOUND' ? 409 : 500;
        res.status(statusCode).json({
          success: false,
          server_id: serverId,
          error: restartSummary.error,
          ...(restartSummary.errorCode && { errorCode: restartSummary.errorCode }),
          ...(restartSummary.errorDetails
            ? { errorDetails: restartSummary.errorDetails }
            : {}),
        });
      }
    } catch (error) {
      const errMsg = `[API] ❌ Server restart error for ${serverId}: ${error.message}\n`;
      console.error(errMsg);
      sendInitLog(errMsg, 'error');

      res.status(500).json({
        success: false,
        server_id: serverId,
        error: error.message
      });
    }
  });

  // ============================================================================
  // MCP SERVER TOGGLE ENDPOINT
  // ============================================================================

  // POST /api/delete-mcp-server/:serverId - Delete a single user-installed MCP server
  apiApp.post('/api/delete-mcp-server/:serverId', async (req, res) => {
    const { serverId } = req.params;

    if (!serverId || typeof serverId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'serverId is required',
      });
    }

    const msg = `[API] ✅ Received delete request for server: ${serverId}\n`;
    console.log(msg);
    sendInitLog(msg, 'info');

    try {
      const executeDelete = async () => {
        const result = await deleteUserMcpServer(serverId, {
          projectRoot: bootstrap.PROJECT_ROOT,
          env: createMcpRuntimeEnv(),
          isPackagedApp: app.isPackaged,
          logger: console,
          broadcastToggleState(payload) {
            BrowserWindow.getAllWindows().forEach((window) => {
              if (!window.isDestroyed()) {
                window.webContents.send('mcp-server-toggled', payload);
              }
            });
          },
        });

        const statusCode = result.success ? 200 : 500;
        if (result.success) {
          sendInitLog(
            `[API] Server ${serverId} deleted successfully (${result.files_deleted_count || 0} files removed)\n`,
            'info',
          );
        } else {
          sendInitLog(
            `[API] ❌ Failed to delete ${serverId}: ${result.error}\n`,
            'error',
          );
        }

        return res.status(statusCode).json(result);
      };
      return mcpOperationService.hasMcpOperationCoordinator()
        ? await mcpOperationService.runExclusiveMcpMutation(
            { kind: 'delete_user_mcp_server', source: 'rest' },
            executeDelete,
          )
        : await executeDelete();
    } catch (error) {
      if (error.code === 'MCP_OPERATION_BUSY') {
        return sendMcpOperationError(res, error);
      }
      const errMsg = `[API] ❌ Delete error for ${serverId}: ${error.message}\n`;
      console.error(errMsg);
      sendInitLog(errMsg, 'error');
      return res.status(500).json({
        success: false,
        server_id: serverId,
        error: error.message,
      });
    }
  });

  // POST /api/persist-mcp-toggle - Persist toggle state without lifecycle changes
  // Used by MCP Assistant create flow before a targeted restart.
  apiApp.post('/api/persist-mcp-toggle', async (req, res) => {
    const { server_id, enabled } = req.body;

    if (!server_id || typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'server_id (string) and enabled (boolean) are required',
      });
    }

    const msg = `[API] ✅ Received persist-mcp-toggle request: ${server_id} → ${enabled ? 'enable' : 'disable'}\n`;
    console.log(msg);
    sendInitLog(msg, 'info');

    // PORTICO-410: never let the chat path flip a hard-disabled server back on,
    // even through the persist-only endpoint.
    if (enabled && dockerMcp.isServerHardDisabled(server_id)) {
      console.warn(
        `[API] Refusing chat-side persist-enable for hard-disabled server ${server_id}`,
      );
      return res.json(hardDisabledToggleRefusal(server_id));
    }

    try {
      const persistToggle = () => persistMcpToggleState(server_id, enabled, {
        mutateToggles: mutateMcpToggles,
        reasonPrefix: 'api-persist-toggle',
      });
      if (mcpOperationService.hasMcpOperationCoordinator()) {
        await mcpOperationService.runExclusiveMcpMutation(
          { kind: 'persist_mcp_toggle', source: 'rest' },
          persistToggle,
        );
      } else {
        await persistToggle();
      }
      console.log(`[API] Toggle persisted for ${server_id}: ${enabled}`);

      res.json({
        success: true,
        server_id,
        enabled,
        message: `Toggle persisted for ${server_id}`,
      });
    } catch (error) {
      if (error.code === 'MCP_OPERATION_BUSY') {
        return sendMcpOperationError(res, error);
      }
      const errMsg = `[API] ❌ Persist toggle error for ${server_id}: ${error.message}\n`;
      console.error(errMsg);
      sendInitLog(errMsg, 'error');

      res.status(500).json({
        success: false,
        server_id,
        enabled,
        error: error.message,
      });
    }
  });

  // POST /api/toggle-mcp-server - Enable or disable an MCP server
  // Used by MCP Assistant tool for self-service integration enablement
  // Delegates to docker-mcp module for proper PATH/env handling
  apiApp.post('/api/toggle-mcp-server', async (req, res) => {
    const { server_id, enabled } = req.body;
    const toggleChatId = normalizeOptionalChatId(req.body?.chat_id);

    if (!server_id || typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'server_id (string) and enabled (boolean) are required'
      });
    }

    const msg = `[API] ✅ Received toggle request: ${server_id} → ${enabled ? 'enable' : 'disable'}\n`;
    console.log(msg);
    sendInitLog(msg, 'info');

    // PORTICO-410: hard-disabled integrations are opaque to the model. This REST
    // endpoint is the model's only toggle path, so refuse enables here before
    // any preflight, persistence, or operation is started.
    const hardDisableGate = evaluateHardDisableToggleGate({
      serverId: server_id,
      enabled,
      isHardDisabled: dockerMcp.isServerHardDisabled(server_id),
      currentToggle: dockerMcp.getMcpTogglesSync()[server_id],
    });
    if (hardDisableGate) {
      if (hardDisableGate.blocked) {
        console.warn(
          `[API] Refusing chat-side enable for hard-disabled server ${server_id}`,
        );
      }
      return res.json(hardDisableGate.response);
    }

    // The assistant toggle endpoint is the final read-only boundary before an
    // operation is created. A scrubbed sensitive-file placeholder without its
    // encrypted backing value cannot be repaired by toggling or by the generic
    // configuration modal, so return the precise recovery state without
    // persisting a toggle or opening operation progress.
    if (enabled) {
      const preflightIssue = detectToggleEnablePreflightIssue(server_id, {
        projectRoot: bootstrap.PROJECT_ROOT,
        findServerYaml: dockerMcp.findServerYaml,
        parseYaml: dockerMcp.parseYaml,
        parseEnvFile: dockerMcp.parseEnvFile,
        checkServerConfigured: dockerMcp.checkServerConfigured,
      });
      if (isSavedSecretUnavailableIssue(preflightIssue)) {
        console.warn(
          `[API] ${server_id} enable skipped because its saved secure configuration is unavailable`,
        );
        return res.json(
          savedSecretUnavailableToggleResponse(server_id, preflightIssue),
        );
      }
    }

    if (enabled) {
      if (contractorDeniedServers.has(server_id)) {
        console.log(`[API] Clearing contractor-denied block for ${server_id} — user re-enabling via toggle`);
        contractorDeniedServers.delete(server_id);
      }
      const blocked = checkCircuitBreaker(server_id);
      if (blocked) {
        console.warn(`[API] Circuit breaker tripped for ${server_id} toggle`);
        return res.json(blocked);
      }
    }

    if (mcpOperationService.hasMcpOperationCoordinator()) {
      try {
        const operationResult = await startCompatibilityMcpOperation(
          req,
          enabled ? 'enable' : 'disable',
          [server_id],
          {
            metadata: {
              presentationSource: 'chat_tool',
              ...(toggleChatId ? { chat_id: toggleChatId } : {}),
            },
          },
        );
        const result = firstMcpOperationResult(operationResult, server_id);
        const readinessPhase =
          result?.readiness_phase ||
          (enabled ? READINESS_PHASE_FAILED : READINESS_PHASE_DISABLED);
        if (operationResult.success) {
          clearFlowFailures(server_id);
        } else {
          recordFlowFailure(server_id);
        }
        return res.status(operationResultHttpStatus(operationResult)).json({
          ...operationResult,
          server_id,
          enabled,
          healthy: enabled ? result?.healthy === true : false,
          readiness_phase: readinessPhase,
          requiresConfiguration: result?.requiresConfiguration === true,
          requiresAuthentication: result?.requiresAuthentication === true,
          requiresSecretReplacement:
            result?.requiresSecretReplacement === true,
          configurationIssue: result?.configurationIssue || undefined,
          requiredAction: result?.requiredAction || undefined,
          recoveryPrompt: result?.recoveryPrompt || undefined,
          recoveryLabel: result?.recoveryLabel || undefined,
          uiStatus: result?.uiStatus || readinessPhase,
          errorCode: result?.errorCode || undefined,
          message: operationResult.success
            ? result?.pending
              ? `Server ${server_id} ${enabled ? 'enable' : 'disable'} operation started.`
              : result?.requiresConfiguration
                ? `Server ${server_id} enabled; configuration required before it can start.`
                : result?.requiresAuthentication
                  ? `Server ${server_id} enabled and requires authentication.`
                  : enabled
                    ? `Server ${server_id} enabled successfully and its tools are ready.`
                    : `Server ${server_id} disabled successfully.`
            : `Failed to ${enabled ? 'enable' : 'disable'} server ${server_id}`,
        });
      } catch (error) {
        recordFlowFailure(server_id);
        return sendMcpOperationError(res, error);
      }
    }

    // Only block if the SAME server already has an active flow (e.g. toggle
    // while its own OAuth is in progress).  Different servers are allowed to
    // proceed independently — the serial task queue in docker-mcp.js already
    // prevents infrastructure conflicts at the container/nginx level.
    const hadActiveFlow = activeSetupFlows.has(server_id);
    const toggleFlowGate = await waitForToggleFlowGate(server_id, activeSetupFlows);
    if (toggleFlowGate) {
      console.warn(
        `[API] Rejecting toggle for ${server_id} — same-server flow still active: ${toggleFlowGate.error}`,
      );
      return res.json(toggleFlowGate);
    }
    if (hadActiveFlow) {
      console.log(`[API] Same-server flow cleared for ${server_id}, proceeding with toggle`);
    }

    return withTrackedSetupFlow(server_id, activeSetupFlows, 'toggle', async () => {
    try {
      const deploymentType = await getDeploymentTypeForServer(server_id);
      const noopResult = await detectToggleLifecycleNoop(server_id, enabled, {
        deploymentType,
        isServerEffectivelyEnabled: () =>
          isServerEffectivelyEnabled(server_id, dockerMcp),
        getServerReadinessStatus: () =>
          getServerReadinessStatus(server_id, { deploymentType }),
        getMcpoServerStatus:
          deploymentType === "docker"
            ? () => dockerMcp.getMcpoServerStatus(server_id)
            : null,
      });

      if (noopResult) {
        if (!enabled) {
          clearStartupFailure(bootstrap.PROJECT_ROOT, server_id, {
            logger: console,
          });
          schedulePostToggleHealthSync(server_id, false, {
            runHealthCheckAndBroadcast,
            queueFullHealthCheck,
            logger: console,
          });
        }
        clearFlowFailures(server_id);
        return res.json({
          success: true,
          server_id,
          enabled,
          healthy: noopResult.healthy,
          readiness_phase: noopResult.readinessPhase,
          message: noopResult.message,
        });
      }

      // 1. Update persisted toggles atomically
      await persistMcpToggleState(server_id, enabled, {
        mutateToggles: mutateMcpToggles,
        reasonPrefix: 'api-toggle',
      });
      if (!enabled) {
        clearStartupFailure(bootstrap.PROJECT_ROOT, server_id, {
          logger: console,
        });
      }
      console.log(`[API] Toggle saved for ${server_id}: ${enabled}`);

      let lifecycleResult = { success: true };
      let readinessResult = buildStartingToggleReadiness(enabled);
      let lifecycleHealthSyncScheduled = false;
      const toggleStartedAt = Date.now();

      const broadcastToggleState = () => {
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send('mcp-server-toggled', { server_id, enabled });
          }
        });
      };

      const scheduleLifecycleHealthSync = () => {
        if (lifecycleHealthSyncScheduled) {
          return;
        }
        lifecycleHealthSyncScheduled = true;
        schedulePostToggleHealthSync(server_id, enabled, {
          runHealthCheckAndBroadcast,
          queueFullHealthCheck,
          logger: console,
        });
      };

      const finalizeSuccessfulToggle = async () => {
        broadcastToggleState();
      };

      const readCurrentReadiness = async (options = {}) => {
        if (!enabled) {
          return {
            healthy: false,
            readinessPhase: READINESS_PHASE_DISABLED,
          };
        }

        let currentReadiness = await getServerReadinessStatus(server_id, {
          deploymentType,
          requestTimeoutMs: Number.isFinite(options.requestTimeoutMs)
            ? options.requestTimeoutMs
            : undefined,
          assumeEnabled: true,
          skipCache: true,
        });
        return currentReadiness;
      };

      if (enabled) {
        const preflightIssue = detectToggleEnablePreflightIssue(server_id, {
          projectRoot: bootstrap.PROJECT_ROOT,
          findServerYaml: dockerMcp.findServerYaml,
          parseYaml: dockerMcp.parseYaml,
          parseEnvFile: dockerMcp.parseEnvFile,
          checkServerConfigured: dockerMcp.checkServerConfigured,
        });
        if (preflightIssue) {
          if (preflightIssue.errorCode === 'NOT_CONFIGURED') {
            console.log(
              `[API] ${server_id} enabled without starting runtime because configuration is incomplete`,
            );
            clearStartupFailure(bootstrap.PROJECT_ROOT, server_id, {
              logger: console,
            });
            updateServerPhase(server_id, READINESS_PHASE_NOT_CONFIGURED, {
              deploymentType,
              error: preflightIssue.error,
            });
            scheduleLifecycleHealthSync();
            await finalizeSuccessfulToggle();
            return res.json({
              success: true,
              server_id,
              enabled,
              requiresConfiguration: true,
              started: false,
              uiStatus: 'not_configured',
              errorCode: preflightIssue.errorCode,
              error: preflightIssue.error,
              message: preflightIssue.message,
            });
          }
          console.error(`[API] ❌ Preflight failed for ${server_id}: ${preflightIssue.error}`);
          sendInitLog(`[API] ❌ Preflight failed for ${server_id}: ${preflightIssue.error}\n`, 'error');
          return res.status(500).json({
            success: false,
            server_id,
            enabled,
            error: preflightIssue.error,
            errorCode: preflightIssue.errorCode,
            message: preflightIssue.message,
          });
        }

        console.log(`[API] Enabling server ${server_id}...`);
        updateServerPhase(server_id, READINESS_PHASE_STARTING, { deploymentType });
        const lifecyclePromise = Promise.resolve(restartMcpoServer(server_id))
          .then((result) => {
            const elapsedMs = Date.now() - toggleStartedAt;
            if (result?.success) {
              console.log(
                `[API] Enable lifecycle for ${server_id} completed successfully after ${elapsedMs}ms`,
              );
              scheduleLifecycleHealthSync();
            } else {
              console.warn(
                `[API] Enable lifecycle for ${server_id} failed after ${elapsedMs}ms: ${result?.error || 'unknown error'}`,
              );
            }
            return result;
          })
          .catch((error) => {
            const elapsedMs = Date.now() - toggleStartedAt;
            console.error(
              `[API] Enable lifecycle for ${server_id} threw after ${elapsedMs}ms: ${error.message}`,
            );
            return {
              success: false,
              error: error.message,
            };
          });
        const enableOutcome = await resolveEnableToggleLifecycleResult(lifecyclePromise, {
          responseDeadlineMs: DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
          pollIntervalMs: DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS,
          initialReadiness: buildStartingToggleReadiness(enabled),
          acceptableReadinessPhases: Array.from(OAUTH_READY_PHASES),
          getReadiness: () => readCurrentReadiness({
            requestTimeoutMs: TOGGLE_ENABLE_READINESS_REQUEST_TIMEOUT_MS,
          }),
        });
        lifecycleResult = enableOutcome.lifecycleResult || { success: true };

        console.log(
          `[API] Enable toggle response for ${server_id}: source=${enableOutcome.source}, elapsed=${enableOutcome.elapsedMs}ms, phase=${enableOutcome.readinessResult?.readinessPhase || enableOutcome.readinessResult?.readiness_phase || 'unknown'}`,
        );

        if (lifecycleResult?.requiresConfiguration) {
          clearStartupFailure(bootstrap.PROJECT_ROOT, server_id, {
            logger: console,
          });
          updateServerPhase(server_id, READINESS_PHASE_NOT_CONFIGURED, {
            deploymentType,
            error: lifecycleResult.error,
          });
          scheduleLifecycleHealthSync();
          await finalizeSuccessfulToggle();
          return res.json({
            success: true,
            server_id,
            enabled,
            requiresConfiguration: true,
            started: false,
            uiStatus: 'not_configured',
            errorCode: lifecycleResult.errorCode || 'NOT_CONFIGURED',
            error: lifecycleResult.error,
            message:
              lifecycleResult.message ||
              `Server ${server_id} enabled; configuration required before it can start`,
          });
        }

        if (enableOutcome.source === 'lifecycle' && !lifecycleResult.success) {
          const errStr = lifecycleResult.error || '';
          const isNotConfigured = errStr.includes('no such service') || errStr.includes('not configured') || errStr.includes('not found') || lifecycleResult.errorCode === 'SERVICE_NOT_FOUND';
          console.error(`[API] ❌ Failed to start server ${server_id}: ${errStr}${isNotConfigured ? ' (server needs configuration)' : ''}`);
          sendInitLog(`[API] ❌ Failed to start ${server_id}: ${errStr}\n`, 'error');
          return res.status(500).json({
            success: false,
            server_id,
            enabled,
            error: errStr,
            errorCode: isNotConfigured ? 'NOT_CONFIGURED' : (lifecycleResult.errorCode || 'START_FAILED'),
            message: isNotConfigured
              ? `Server ${server_id} is not configured (missing required environment variables). Use trigger_guided_setup to open the configuration form.`
              : `Toggle saved but server failed to start: ${errStr}`
          });
        }

        await finalizeSuccessfulToggle();
        if (enableOutcome.source === 'lifecycle') {
          readinessResult = await readCurrentReadiness();
        } else {
          readinessResult = enableOutcome.readinessResult || buildStartingToggleReadiness(true);
        }
      } else {
        // DISABLING: Use shared runtime lifecycle helper to keep API/IPC behavior in sync.
        console.log(`[API] Disabling server ${server_id}...`);
        updateServerPhase(server_id, READINESS_PHASE_DISABLED, { deploymentType });

        const isHost = await isHostDeployedServer(server_id);
        if (isHost) {
          try {
            const { promisify } = require('util');
            const execAsync = promisify(require('child_process').exec);
            await restartHostMcpoWithFreshConfig({
              execAsync,
              projectRoot: bootstrap.PROJECT_ROOT,
              env: createMcpRuntimeEnv(),
              regenerateMcpInfrastructure,
              stopHostMcpo,
              startHostMcpo,
              logger: console,
              regenerationOptions: {
                force: true,
                isPackagedApp: app.isPackaged,
                timeout: 30000,
              },
            });
            dockerMcp.invalidateHostModeCaches?.();
          } catch (e) {
            console.log(`[API] Host MCPO restart notice: ${e.message}`);
          }
        } else {
          const runtimeTarget = getConfiguredMcpoRuntimeTarget(server_id);
          const containerName = runtimeTarget.containerName;
          const composeService = runtimeTarget.composeService;
          const nginxContainer = 'mcpo';

          console.log(`[API] Force-removing container ${containerName}...`);
          try {
            await executeWithStreaming(
              buildForceRemoveContainerCommand(containerName),
              [],
              10000,
            );
          } catch (e) { /* ok */ }

          // Regenerate full runtime infra so routes, compose services, and
          // control-plane topology stay aligned with the new toggle state.
          console.log(`[API] Regenerating MCP infrastructure after disable...`);
          try {
            const { promisify } = require('util');
            const execAsync = promisify(require('child_process').exec);
            await regenerateMcpInfrastructure(
              execAsync,
              bootstrap.PROJECT_ROOT,
              createMcpRuntimeEnv(),
              { force: true, isPackagedApp: app.isPackaged, timeout: 30000 },
            );
            dockerMcp.invalidateHostModeCaches?.();
          } catch (e) {
            console.log(`[API] Config regeneration notice: ${e.message || 'non-zero exit'}`);
          }

          if (composeService !== containerName) {
            console.log(`[API] Disabled runtime was composed as ${composeService}`);
          }

          console.log(`[API] Refreshing control-plane programs (${nginxContainer})...`);
          try {
            const { promisify } = require('util');
            const execAsync = promisify(require('child_process').exec);
            await refreshMcpControlPlane(
              execAsync,
              bootstrap.PROJECT_ROOT,
              createMcpRuntimeEnv(),
              {
                controlPlaneContainer: nginxContainer,
                serverId: server_id,
                includeRegular: runtimeTarget.deploymentScope !== 'core',
                includeCore: runtimeTarget.deploymentScope === 'core',
                serverRouteWait: 'skip',
                logger: console,
              },
            );
          } catch (e) { /* ok */ }
        }
        await finalizeSuccessfulToggle();
        scheduleLifecycleHealthSync();
      }

      console.log(`[API] Successfully toggled ${server_id} to ${enabled ? 'enabled' : 'disabled'}`);

      const successMsg = enabled
        ? `[API] Server ${server_id} enabled successfully (healthy=${readinessResult.healthy}, phase=${readinessResult.readinessPhase || 'unknown'})\n`
        : `[API] Server ${server_id} disabled successfully\n`;
      console.log(successMsg);
      sendInitLog(successMsg, 'info');

      let message = `Server ${server_id} disabled successfully`;
      if (enabled) {
        if (readinessResult.healthy) {
          message = `Server ${server_id} enabled successfully and its tools are ready.`;
        } else if (
          readinessResult.readinessPhase === READINESS_PHASE_CHECKING_TOKENS
        ) {
          message = `Server ${server_id} enabled successfully and is checking existing OAuth tokens.`;
        } else if (
          readinessResult.readinessPhase === READINESS_PHASE_NEEDS_OAUTH ||
          readinessResult.readinessPhase === READINESS_PHASE_WAITING_CALLBACK
        ) {
          message = `Server ${server_id} enabled successfully and is ready for OAuth authorization.`;
        } else {
          message = `Server ${server_id} enabled successfully but is still starting.`;
        }
      }

      clearFlowFailures(server_id);

      res.json({
        success: true,
        server_id,
        enabled,
        healthy: enabled ? readinessResult.healthy : false,
        readiness_phase: enabled
          ? (
              readinessResult.readinessPhase ||
              (readinessResult.healthy
                ? READINESS_PHASE_TOOL_READY
                : READINESS_PHASE_STARTING)
            )
          : READINESS_PHASE_DISABLED,
        message,
      });
    } catch (error) {
      const errMsg = `[API] ❌ Toggle error for ${server_id}: ${error.message}\n`;
      console.error(errMsg);
      sendInitLog(errMsg, 'error');
      recordFlowFailure(server_id);

      res.status(500).json({
        success: false,
        server_id,
        error: error.message
      });
    }
    }); // withTrackedSetupFlow
  });

  // ============================================================================
  // OAUTH FLOW ENDPOINT
  // ============================================================================

  // POST /api/trigger-oauth-flow - Trigger OAuth flow from LLM (BLOCKING)
  apiApp.post('/api/trigger-oauth-flow', async (req, res) => {
    // Strip the LLM-side `server:` prefix before any downstream lookup so the
    // YAML-backed OAuth detection and persisted-token check use the canonical
    // bare id. Without this, googleworkspace requests come in as
    // "server:google_workspace", findServerYaml returns null, and the
    // disposition flips to NOT_OAUTH_SERVER even for OAuth-backed servers.
    const server_id = stripAssistantServerPrefix(req.body?.server_id);
    const forceAuth = Boolean(req.body?.force_auth);
    const chatId = normalizeOptionalChatId(req.body?.chat_id);
    console.log(`[API] OAuth flow requested for ${server_id} (LLM-triggered, force_auth=${forceAuth})`);

    if (contractorDeniedServers.has(server_id)) {
      console.warn(`[API] Contractor-denied fast-fail for ${server_id} — block active until wizard close or CP action`);
      return res.json({
        success: false,
        errorCode: 'CONTRACTOR_PERMISSIONS_DENIED',
        error: `Authorization denied — contractor account lacks required permissions for ${server_id}.`,
        message: `Your contractor account needs additional permissions for ${server_id}. `
          + `To request access, create a Jira ticket here: ${CONTRACTOR_JIRA_URL} `
          + `— or reach out in #help-llm for assistance. `
          + `Once permissions are granted, you can retry.`,
      });
    }

    const blocked = checkCircuitBreaker(server_id);
    if (blocked) {
      console.warn(`[API] Circuit breaker tripped for ${server_id} OAuth`);
      return res.json(blocked);
    }

    // Wait for same-server flow only; different servers can proceed in parallel.
    if (activeSetupFlows.has(server_id)) {
      const conflicting = await waitForSameServerFlow(server_id, activeSetupFlows);
      if (conflicting) {
        console.warn(`[API] Rejecting OAuth flow for ${server_id} — same-server flow still active: ${conflicting}`);
        return res.json({
          success: false,
          error: `A setup flow is already in progress for this server (${conflicting}). Wait for it to complete.`,
          errorCode: 'FLOW_IN_PROGRESS',
          server_id,
        });
      }
      console.log(`[API] Same-server OAuth session state is clear for ${server_id}; starting a fresh OAuth flow`);
    }
    const hasStaticOAuthConfig = serverUsesOAuthConfig(server_id, {
      findServerYaml: dockerMcp.findServerYaml,
      readFileSync: fs.readFileSync,
      parseYaml: dockerMcp.parseYaml,
      logger: console,
    });
    let hasUsablePersistedOAuthTokens = null;
    let oauthMigration = null;
    if (hasStaticOAuthConfig) {
      try {
        oauthMigration = migrateLegacyOAuthRecordIfNeeded(server_id);
        const tokenCheck = checkPersistedOAuthTokens(server_id, {
          projectRoot: bootstrap.PROJECT_ROOT,
          isCoreServer,
        });
        hasUsablePersistedOAuthTokens = tokenCheck.exists === true;
        if (!hasUsablePersistedOAuthTokens) {
          console.log(
            `[API] Persisted OAuth tokens are unavailable for ${server_id} (reason=${tokenCheck.reason || "unknown"})`,
          );
        }
      } catch (error) {
        hasUsablePersistedOAuthTokens = false;
        console.warn(
          `[API] Could not inspect persisted OAuth tokens for ${server_id}: ${error.message}`,
        );
      }
    }

    // Canonical readiness check. This will reuse the short-lived lifecycle cache
    // when available, so we can safely trust runtime OAuth discovery here.
    const readinessResult = await getServerReadinessStatus(server_id);
    const readinessPhase = readinessResult.readinessPhase;

    const oauthTriggerDisposition = getOAuthTriggerDisposition({
      hasStaticOAuthConfig,
      readinessStatus: readinessResult,
      forceAuth,
      hasUsablePersistedOAuthTokens,
    });

    if (oauthTriggerDisposition.type === "disabled") {
      console.warn(`[API] ${server_id} is disabled — rejecting OAuth trigger`);
      recordFlowFailure(server_id);
      return res.json({
        success: false,
        completed: false,
        server_id,
        healthy: false,
        readiness_phase: READINESS_PHASE_DISABLED,
        error: `Server ${server_id} is DISABLED. You must call toggle_integration to enable it before authorizing.`,
        message: `Server ${server_id} is disabled. Call mcp_assistant_toggle_integration("${server_id}") first, then authorize.`,
      });
    }

    if (oauthTriggerDisposition.type === "already_authorized") {
      console.log(`[API] Server ${server_id} is already tool-ready — skipping OAuth wizard`);
      clearFlowFailures(server_id);
      queueFullHealthCheck(`oauth-already-authed:${server_id}`, { immediate: true });
      return res.json({
        success: true,
        completed: true,
        server_id,
        healthy: true,
        readiness_phase: READINESS_PHASE_TOOL_READY,
        message: `OAuth already authorized for ${server_id} (existing tokens are valid). Tools are ready.`,
        already_authorized: true,
      });
    }

    // Guard: reject non-OAuth servers. Token-based servers (e.g. GitLab)
    // should use trigger_guided_setup for re-configuration, not OAuth.
    if (oauthTriggerDisposition.type === "not_oauth") {
      console.warn(`[API] Server ${server_id} does not use OAuth — rejecting trigger-oauth-flow`);
      return res.json({
        success: false,
        error: `Server ${server_id} does not use OAuth authentication. It uses token/API-key authentication. Call trigger_guided_setup(server_id="${server_id}") to open the configuration form where the user can re-enter their credentials.`,
        errorCode: 'NOT_OAUTH_SERVER'
      });
    }

    // Runtime-discovered OAuth servers do not have a static YAML marker, but
    // they must still complete the same one-way legacy import before any fresh
    // authorization flow is allowed to remove plaintext state.
    if (!hasStaticOAuthConfig) {
      try {
        oauthMigration = migrateLegacyOAuthRecordIfNeeded(server_id);
      } catch (error) {
        console.warn(
          `[API] Could not migrate runtime-discovered OAuth state for ${server_id}: ${error.message}`,
        );
      }
    }

    if (oauthMigration?.imported && !forceAuth) {
      console.log(
        `[API] Recovering ${server_id} from newly imported secure OAuth state before starting a fresh flow`,
      );
      const recovery = await restartServerAndWaitReady(server_id, {
        restartReason: "legacy-oauth-migration",
        healthReason: "legacy-oauth-migration",
      });
      if (recovery.healthy) {
        clearFlowFailures(server_id);
        return res.json({
          success: true,
          completed: true,
          server_id,
          healthy: true,
          readiness_phase: READINESS_PHASE_TOOL_READY,
          message: `OAuth credentials for ${server_id} were migrated into secure storage and restored.`,
          migrated_existing_credentials: true,
        });
      }
      console.warn(
        `[API] ${server_id} did not recover after legacy OAuth migration; continuing with reauthentication`,
      );
    }
    if (!hasStaticOAuthConfig) {
      console.log(
        `[API] Allowing OAuth flow for ${server_id} based on runtime readiness (phase=${readinessPhase || "unknown"}, oauth_state=${readinessResult.oauthState || "none"}, auth_url=${readinessResult.authorizationUrlAvailable === true})`,
      );
    }

    if (dismissedOAuthFlows.has(server_id)) {
      console.log(`[API] Clearing previous dismissal state for ${server_id}`);
      dismissedOAuthFlows.delete(server_id);
    }
    if (completedOAuthFlows.has(server_id)) {
      completedOAuthFlows.delete(server_id);
    }

    try {
      const clearResult = prepareFreshOAuthFlow(server_id);
      if (!clearResult?.success) {
        throw new Error(
          clearResult?.error || "Failed to prepare fresh OAuth state",
        );
      }
    } catch (error) {
      console.error(
        `[API] Failed to prepare fresh OAuth flow for ${server_id}:`,
        error,
      );
      recordFlowFailure(server_id);
      return res.json({
        success: false,
        completed: false,
        server_id,
        error: error.message,
      });
    }

    const session = startTrackedOAuthSession(server_id, {
      forceAuth,
    });

    broadcastOAuthFlowRequested({
      server_id,
      chat_id: chatId,
      force_auth: forceAuth,
      resume_existing: false,
    });

    const asyncMode = req.body?.async === true;
    if (asyncMode) {
      const flowId = `oauth-${server_id}-${Date.now()}`;
      state.oauthFlowResults.set(flowId, {
        serverId: server_id,
        status: 'in_progress',
        result: null,
        startedAt: Date.now(),
        completedAt: null,
      });

      session.promise
        .then((result) => {
          state.oauthFlowResults.set(flowId, {
            serverId: server_id,
            status: 'completed',
            result,
            startedAt: session.startedAt,
            completedAt: Date.now(),
          });
          setTimeout(() => state.oauthFlowResults.delete(flowId), 5 * 60 * 1000);
        })
        .catch((err) => {
          state.oauthFlowResults.set(flowId, {
            serverId: server_id,
            status: 'completed',
            result: { success: false, error: err.message, server_id },
            startedAt: session.startedAt,
            completedAt: Date.now(),
          });
          setTimeout(() => state.oauthFlowResults.delete(flowId), 5 * 60 * 1000);
        });

      return res.json({
        started: true,
        flow_id: flowId,
        server_id,
        readiness_phase: READINESS_PHASE_WAITING_CALLBACK,
      });
    }

    return attachToOAuthSession(session, req, res);
  });

  // GET /api/oauth-flow-status/:flowId - Non-blocking OAuth flow status polling
  apiApp.get('/api/oauth-flow-status/:flowId', (req, res) => {
    const { flowId } = req.params;
    const entry = state.oauthFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }

    if (entry.status === 'in_progress') {
      const cached = serverLifecycle.get(entry.serverId);
      return res.json({
        flow_id: flowId,
        server_id: entry.serverId,
        status: 'in_progress',
        readiness_phase: cached?.phase || READINESS_PHASE_WAITING_CALLBACK,
        elapsed_ms: Date.now() - entry.startedAt,
      });
    }

    return res.json({
      flow_id: flowId,
      server_id: entry.serverId,
      status: 'completed',
      result: entry.result,
      elapsed_ms: entry.completedAt - entry.startedAt,
    });
  });

  // ============================================================================
  // USER QUESTION FLOW ENDPOINTS
  // ============================================================================

  apiApp.post('/api/owui/request-model-refresh', async (req, res) => {
    broadcastOwuiModelRefreshRequested(req.body || {});
    return res.json({ success: true });
  });

  apiApp.post('/api/trigger-user-question-flow', async (req, res) => {
    let normalizedRequest;
    try {
      normalizedRequest = normalizeUserQuestionRequest(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'Invalid user-question payload',
      });
    }

    const flowId = `user-question-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = startUserQuestionFlow({
      flowId,
      status: 'in_progress',
      chatId: normalizedRequest.chatId,
      questions: normalizedRequest.questions,
      timeoutSeconds: normalizedRequest.timeoutSeconds,
      result: null,
      startedAt: Date.now(),
      completedAt: null,
      timeoutHandle: null,
      cleanupHandle: null,
      ownerWindowId: null,
      matchedViewKey: null,
      presentation: 'visible',
    });

    entry.timeoutHandle = setTimeout(() => {
      const latest = state.userQuestionFlowResults.get(flowId);
      if (!latest || latest.status !== 'in_progress') {
        return;
      }
      terminateUserQuestionFlow(flowId, buildUserQuestionTimeoutResult(latest));
    }, normalizedRequest.timeoutSeconds * 1000);

    const delivery = broadcastUserQuestionRequested({
      flow_id: flowId,
      chat_id: normalizedRequest.chatId,
      questions: normalizedRequest.questions,
      timeout_seconds: normalizedRequest.timeoutSeconds,
    });
    if (!delivery?.sent) {
      const result = buildUserQuestionErrorResult(
        entry,
        "No chat window is available for this question",
      );
      terminateUserQuestionFlow(flowId, result);
      return res.status(503).json({
        success: false,
        error: "No chat window is available",
      });
    }
    entry.ownerWindowId = delivery.windowId ?? null;
    entry.matchedViewKey = delivery.matchedViewKey ?? null;
    broadcastNativeInputPresentationSnapshot(entry.ownerWindowId);

    return res.status(202).json({
      success: true,
      started: true,
      flow_id: flowId,
      timeout_seconds: normalizedRequest.timeoutSeconds,
    });
  });

  apiApp.get('/api/user-question-flow-status/:flowId', (req, res) => {
    const { flowId } = req.params;
    const entry = state.userQuestionFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }

    if (entry.status === 'in_progress') {
      return res.json({
        success: true,
        flow_id: flowId,
        status: 'in_progress',
        elapsed_ms: Date.now() - entry.startedAt,
      });
    }

    return res.json({
      success: true,
      flow_id: flowId,
      status: 'completed',
      result: entry.result,
      elapsed_ms: Math.max(0, (entry.completedAt || Date.now()) - entry.startedAt),
    });
  });

  apiApp.post('/api/cancel-user-question-flow', (req, res) => {
    const flowId = typeof req.body?.flow_id === 'string' ? req.body.flow_id.trim() : '';
    const reason =
      (typeof req.body?.reason === 'string' && req.body.reason.trim()) || 'tool_cancelled';
    if (!flowId) {
      return res.status(400).json({ success: false, error: 'flow_id is required' });
    }
    const entry = state.userQuestionFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }
    if (entry.status !== 'in_progress') {
      return res.json({ success: true, flow_id: flowId, status: 'already_completed' });
    }
    terminateUserQuestionFlow(flowId, buildUserQuestionCancelledResult(entry, reason));
    console.log(`[API] Cancelled user-question flow ${flowId} (${reason})`);
    return res.json({ success: true, flow_id: flowId, status: 'cancelled' });
  });

  apiApp.post('/api/trigger-chat-workspace-consent-flow', async (req, res) => {
    let normalizedRequest;
    try {
      normalizedRequest = normalizeChatWorkspaceConsentRequest(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'Invalid chat-workspace consent payload',
      });
    }

    const flowId = `chat-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = startChatWorkspaceConsentFlow({
      flowId,
      status: 'in_progress',
      chatId: normalizedRequest.chatId,
      hostPath: normalizedRequest.hostPath,
      displayPath: normalizedRequest.displayPath,
      preamble: normalizedRequest.preamble,
      timeoutSeconds: normalizedRequest.timeoutSeconds,
      result: null,
      startedAt: Date.now(),
      completedAt: null,
      timeoutHandle: null,
      cleanupHandle: null,
      ownerWindowId: null,
      matchedViewKey: null,
      presentation: 'visible',
    });

    entry.timeoutHandle = setTimeout(() => {
      const latest = state.chatWorkspaceConsentFlowResults.get(flowId);
      if (!latest || latest.status !== 'in_progress') {
        return;
      }
      terminateChatWorkspaceConsentFlow(
        flowId,
        buildChatWorkspaceConsentTimeoutResult(latest),
      );
    }, normalizedRequest.timeoutSeconds * 1000);

    const delivery = broadcastChatWorkspaceConsentRequested({
      flow_id: flowId,
      chat_id: normalizedRequest.chatId,
      host_path: normalizedRequest.hostPath,
      display_path: normalizedRequest.displayPath,
      preamble: normalizedRequest.preamble,
      timeout_seconds: normalizedRequest.timeoutSeconds,
    });
    entry.ownerWindowId = delivery?.windowId ?? null;
    entry.matchedViewKey = delivery?.matchedViewKey ?? null;
    broadcastNativeInputPresentationSnapshot(entry.ownerWindowId);

    return res.status(202).json({
      success: true,
      started: true,
      flow_id: flowId,
      timeout_seconds: normalizedRequest.timeoutSeconds,
      display_path: normalizedRequest.displayPath,
    });
  });

  apiApp.get('/api/chat-workspace-consent-flow-status/:flowId', (req, res) => {
    const { flowId } = req.params;
    const entry = state.chatWorkspaceConsentFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }

    if (entry.status === 'in_progress') {
      return res.json({
        success: true,
        flow_id: flowId,
        status: 'in_progress',
        elapsed_ms: Date.now() - entry.startedAt,
      });
    }

    return res.json({
      success: true,
      flow_id: flowId,
      status: 'completed',
      result: entry.result,
      elapsed_ms: Math.max(0, (entry.completedAt || Date.now()) - entry.startedAt),
    });
  });

  apiApp.post('/api/cancel-chat-workspace-consent-flow', (req, res) => {
    const flowId = typeof req.body?.flow_id === 'string' ? req.body.flow_id.trim() : '';
    const reason =
      (typeof req.body?.reason === 'string' && req.body.reason.trim()) || 'tool_cancelled';
    if (!flowId) {
      return res.status(400).json({ success: false, error: 'flow_id is required' });
    }
    const entry = state.chatWorkspaceConsentFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }
    if (entry.status !== 'in_progress') {
      return res.json({ success: true, flow_id: flowId, status: 'already_completed' });
    }
    terminateChatWorkspaceConsentFlow(
      flowId,
      buildChatWorkspaceConsentCancelledResult(entry, reason),
    );
    console.log(`[API] Cancelled chat-workspace consent flow ${flowId} (${reason})`);
    return res.json({ success: true, flow_id: flowId, status: 'cancelled' });
  });

  apiApp.post('/api/trigger-sensitive-info-flow', async (req, res) => {
    let normalizedRequest;
    try {
      normalizedRequest = normalizeSensitiveInfoRequest(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'Invalid sensitive-info payload',
      });
    }

    const flowId = `sensitive-info-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = startSensitiveInfoFlow({
      flowId,
      status: 'in_progress',
      chatId: normalizedRequest.chatId,
      prompt: normalizedRequest.prompt,
      preamble: normalizedRequest.preamble,
      label: normalizedRequest.label,
      placeholder: normalizedRequest.placeholder,
      timeoutSeconds: normalizedRequest.timeoutSeconds,
      visualAids: normalizedRequest.visualAids,
      result: null,
      startedAt: Date.now(),
      completedAt: null,
      timeoutHandle: null,
      cleanupHandle: null,
      ownerWindowId: null,
      matchedViewKey: null,
      presentation: 'visible',
    });

    entry.timeoutHandle = setTimeout(() => {
      const latest = state.sensitiveInfoFlowResults.get(flowId);
      if (!latest || latest.status !== 'in_progress') {
        return;
      }
      terminateSensitiveInfoFlow(flowId, buildSensitiveInfoTimeoutResult(latest));
    }, normalizedRequest.timeoutSeconds * 1000);

    const delivery = broadcastSensitiveInfoRequested({
      flow_id: flowId,
      chat_id: normalizedRequest.chatId,
      prompt: normalizedRequest.prompt,
      preamble: normalizedRequest.preamble,
      label: normalizedRequest.label,
      placeholder: normalizedRequest.placeholder,
      timeout_seconds: normalizedRequest.timeoutSeconds,
      visual_aids: normalizedRequest.visualAids,
    });
    entry.ownerWindowId = delivery?.windowId ?? null;
    entry.matchedViewKey = delivery?.matchedViewKey ?? null;
    broadcastNativeInputPresentationSnapshot(entry.ownerWindowId);

    return res.status(202).json({
      success: true,
      started: true,
      flow_id: flowId,
      timeout_seconds: normalizedRequest.timeoutSeconds,
    });
  });

  apiApp.get('/api/sensitive-info-flow-status/:flowId', (req, res) => {
    const { flowId } = req.params;
    const entry = state.sensitiveInfoFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }

    if (entry.status === 'in_progress') {
      return res.json({
        success: true,
        flow_id: flowId,
        status: 'in_progress',
        elapsed_ms: Date.now() - entry.startedAt,
      });
    }

    const result = entry.result;
    if (entry.cleanupHandle) {
      clearTimeout(entry.cleanupHandle);
      entry.cleanupHandle = null;
    }
    state.sensitiveInfoFlowResults.delete(flowId);

    return res.json({
      success: true,
      flow_id: flowId,
      status: 'completed',
      result,
      elapsed_ms: Math.max(0, (entry.completedAt || Date.now()) - entry.startedAt),
    });
  });

  apiApp.post('/api/cancel-sensitive-info-flow', (req, res) => {
    const flowId = typeof req.body?.flow_id === 'string' ? req.body.flow_id.trim() : '';
    const reason =
      (typeof req.body?.reason === 'string' && req.body.reason.trim()) || 'tool_cancelled';
    if (!flowId) {
      return res.status(400).json({ success: false, error: 'flow_id is required' });
    }
    const entry = state.sensitiveInfoFlowResults.get(flowId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Flow not found or expired',
        flow_id: flowId,
      });
    }
    if (entry.status !== 'in_progress') {
      return res.json({ success: true, flow_id: flowId, status: 'already_completed' });
    }
    terminateSensitiveInfoFlow(flowId, buildSensitiveInfoCancelledResult(entry, reason));
    console.log(`[API] Cancelled sensitive-info flow ${flowId} (${reason})`);
    return res.json({ success: true, flow_id: flowId, status: 'cancelled' });
  });

  // ============================================================================
  // GUIDED SETUP ENDPOINT (LLM-triggered server configuration)
  // ============================================================================

  // POST /api/trigger-guided-setup - Open config modal for server setup or reconfiguration
  // Used by MCP Assistant for initial setup (missing env vars) or reconfiguration (expired/invalid tokens)
  apiApp.post('/api/trigger-guided-setup', async (req, res) => {
    // Same `server:` prefix normalization as /api/trigger-oauth-flow — without
    // this, the renderer's `appState.servers.find(s.id===…)` lookup misses,
    // notifyGuidedSetupCompleted fires with success=false, and the response is
    // shaped as `dismissed: true` even though no form ever opened.
    const server_id = stripAssistantServerPrefix(req.body?.server_id);
    const { reason } = req.body || {};
    const chatId = normalizeOptionalChatId(req.body?.chat_id);

    if (!server_id) {
      return res.status(400).json({
        success: false,
        error: 'server_id (string) is required'
      });
    }

    console.log(`[API] Guided setup requested for ${server_id}`);

    const blocked = checkCircuitBreaker(server_id);
    if (blocked) {
      console.warn(`[API] Circuit breaker tripped for ${server_id} guided setup`);
      return res.json(blocked);
    }

    const GUIDED_SETUP_COOLDOWN_MS = 60000;
    const recentSuccess = guidedSetupSuccessCooldown.get(server_id);
    if (recentSuccess && (Date.now() - recentSuccess.timestamp) < GUIDED_SETUP_COOLDOWN_MS && reason !== 'credentials_invalid') {
      console.log(`[API] Guided setup cooldown active for ${server_id} — setup succeeded ${Math.round((Date.now() - recentSuccess.timestamp) / 1000)}s ago, returning cached result`);
      return res.json({
        success: true,
        completed: true,
        server_id,
        healthy: true,
        readiness_phase: recentSuccess.readiness_phase || 'tool_ready',
        message: `Server ${server_id} was already configured successfully ${Math.round((Date.now() - recentSuccess.timestamp) / 1000)}s ago. No need to reconfigure.`,
        cached: true,
      });
    }

    // Wait for same-server flow only; different servers can proceed in parallel.
    if (activeSetupFlows.has(server_id)) {
      const conflicting = await waitForSameServerFlow(server_id, activeSetupFlows);
      if (conflicting) {
        console.warn(`[API] Rejecting guided setup for ${server_id} — same-server flow still active: ${conflicting}`);
        return res.json({
          success: false,
          error: `A setup flow is already in progress for this server (${conflicting}). Wait for it to complete.`,
          errorCode: 'FLOW_IN_PROGRESS',
          server_id,
        });
      }
      console.log(`[API] Same-server flow cleared for ${server_id}, proceeding with guided setup`);
    }
    activeSetupFlows.set(server_id, 'guided-setup');
    const flowId = `guided-setup-${randomUUID()}`;

    const requestLifecycle = createOAuthRequestLifecycle(req, res, {
      logger: console,
      serverId: server_id,
    });

    // Clear any stale result for this server
    guidedSetupResults.delete(server_id);

    let setupResolve;
    const setupPromise = new Promise(r => { setupResolve = r; });
    guidedSetupWaiters.set(server_id, { resolve: setupResolve, flowId });

    sendBackendModalRequest('guided-setup-requested', {
      server_id,
      chat_id: chatId,
      reason,
      flow_id: flowId,
    });

    // Wait for completion via Promise (instant signal from IPC handler)
    const timeout = 120000; // 2 minutes (safety net — signal arrives via IPC)
    console.log(`[API] Waiting for guided setup completion for ${server_id}...`);

    const disconnectCheck = new Promise(resolve => {
      const interval = setInterval(() => {
        if (requestLifecycle.isClientDisconnected()) {
          clearInterval(interval);
          resolve({ type: 'disconnected' });
        }
      }, 2000);
      setupPromise.then(() => clearInterval(interval));
      setTimeout(() => clearInterval(interval), timeout);
    });

    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => resolve({ type: 'timeout' }), timeout)
    );

    const outcome = await Promise.race([
      setupPromise.then(result => ({ type: 'result', result })),
      disconnectCheck,
      timeoutPromise,
    ]);

    guidedSetupWaiters.delete(server_id);

    if (outcome.type === 'disconnected') {
      console.warn(`[API] Guided setup client disconnected for ${server_id} — releasing lock`);
      guidedSetupResults.delete(server_id);
      activeSetupFlows.delete(server_id);
      requestLifecycle.detach();
      return;
    }

    if (outcome.type === 'timeout') {
      console.log(`[API] Guided setup timed out for ${server_id} after 5 minutes`);
      guidedSetupResults.delete(server_id);
      activeSetupFlows.delete(server_id);
      requestLifecycle.detach();
      return res.json({
        success: false,
        error: 'Guided setup timed out after 5 minutes',
        server_id
      });
    }

    const result = outcome.result;
    guidedSetupResults.delete(server_id);

    if (result.outcome === 'completed' && result.success) {
      console.log(`[API] Guided setup completed successfully for ${server_id}`);
      const deploymentType = await getDeploymentTypeForServer(server_id);

      const invalidateResult = await invalidateAggregatorCaches(server_id, {
        deploymentType,
        reason: 'guided-setup',
      });
      if (!invalidateResult.success && !invalidateResult.skipped) {
        console.warn(
          `[API] Aggregator cache invalidation failed after guided setup for ${server_id}: ${invalidateResult.error || 'unknown error'}`,
        );
      }

      let readyResult = await waitForServerReadinessPhase(
        server_id,
        [...OAUTH_READY_PHASES],
        {
          deploymentType,
          maxWaitMs: 45000,
          pollIntervalMs: 2000,
        },
      );
      const serverHealthy = readyResult.healthy;
      const readinessPhase =
        readyResult.readinessPhase ||
        (serverHealthy
          ? READINESS_PHASE_TOOL_READY
          : READINESS_PHASE_STARTING);

      queueFullHealthCheck(`guided-setup:${server_id}`, { immediate: true });

      activeSetupFlows.delete(server_id);
      requestLifecycle.detach();

      guidedSetupSuccessCooldown.set(server_id, {
        timestamp: Date.now(),
        readiness_phase: readinessPhase,
      });

      if (serverHealthy) {
        return res.json({
          success: true,
          completed: true,
          server_id,
          healthy: true,
          readiness_phase: readinessPhase,
          message: `Server ${server_id} configured, enabled, and healthy. Its tools are now available.`
        });
      } else {
        console.warn(
          `[API] ${server_id} not ready after guided setup (phase=${readinessPhase}) — returning partial success`,
        );
        let message = `Server ${server_id} configured and enabled but still starting up. Tools may not be available yet — the user should wait a moment and try again.`;
        if (readinessPhase === READINESS_PHASE_CHECKING_TOKENS) {
          message = `Server ${server_id} configured and enabled, and it is checking existing OAuth tokens.`;
        } else if (
          readinessPhase === READINESS_PHASE_NEEDS_OAUTH ||
          readinessPhase === READINESS_PHASE_WAITING_CALLBACK
        ) {
          message = `Server ${server_id} configured and enabled, and it is ready for OAuth authorization.`;
        }
        return res.json({
          success: true,
          completed: true,
          server_id,
          healthy: false,
          readiness_phase: readinessPhase,
          message,
        });
      }
    }

    activeSetupFlows.delete(server_id);
    requestLifecycle.detach();

    if (result.outcome === 'redirected_to_chat') {
      console.log(`[API] Guided setup redirected to chat for ${server_id}`);
      return res.json({
        success: false,
        completed: false,
        dismissed: false,
        redirected_to_chat: true,
        outcome: 'redirected_to_chat',
        server_id,
        message: `The user chose to continue ${server_id} setup in a new chat.`,
      });
    }

    if (result.outcome === 'test_failed') {
      console.log(`[API] Guided setup test failed for ${server_id}`);
      return res.json({
        success: false,
        completed: false,
        dismissed: false,
        test_failed: true,
        outcome: 'test_failed',
        server_id,
        errorCode: result.errorCode || 'CONFIGURATION_TEST_FAILED',
        configurationIssue: result.configurationIssue || undefined,
        requiredAction: result.requiredAction || undefined,
        severity: result.severity || 'error',
        recoveryPrompt: result.recoveryPrompt || undefined,
        recoveryLabel: result.recoveryLabel || undefined,
        message:
          result.message ||
          `The ${server_id} configuration test failed. The user did not dismiss the form.`,
      });
    }

    console.log(`[API] Guided setup dismissed for ${server_id}`);
    return res.json({
      success: false,
      completed: false,
      dismissed: true,
      outcome: 'dismissed',
      server_id,
      message: `User dismissed the configuration form for ${server_id}.`,
    });
  });

  // ============================================================================
  // OAUTH DIRECT ENDPOINT (Browser Redirect)
  // ============================================================================

  // GET /api/oauth/:serverId - Direct OAuth flow initiation (browser redirect)
  // Used when Control Plane Authenticate button opens browser directly
  apiApp.get('/api/oauth/:serverId', async (req, res) => {
    const { serverId } = req.params;
    console.log(`[API] OAuth redirect requested for ${serverId}`);

    try {
      // Fetch current OAuth status from MCPO
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch('http://localhost:8765/oauth/current', {
        signal: controller.signal
      });
      clearTimeout(fetchTimeout);

      if (!response.ok) {
        console.error(`[API] Failed to fetch OAuth status: ${response.status}`);
        return res.status(502).send(`
          <html>
            <head><title>OAuth Error</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>OAuth Error</h1>
              <p>Failed to fetch OAuth status from MCPO (HTTP ${response.status})</p>
              <p>Please try clicking Authenticate again.</p>
            </body>
          </html>
        `);
      }

      const data = await response.json();

      if (data.current && data.current.authorization_url) {
        console.log(`[API] Redirecting to OAuth provider: ${data.current.authorization_url}`);
        return res.redirect(data.current.authorization_url);
      }

      // No active OAuth flow
      console.log(`[API] No active OAuth flow found for ${serverId}`);
      res.status(404).send(`
        <html>
          <head><title>No OAuth Flow</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>No Active OAuth Flow</h1>
            <p>No OAuth authorization is currently pending for <strong>${serverId}</strong>.</p>
            <p>Please try clicking the Authenticate button again in the Control Plane.</p>
            <p style="color: #666; margin-top: 20px;">You can close this tab.</p>
          </body>
        </html>
      `);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[API] OAuth status fetch timeout for ${serverId}`);
        return res.status(504).send(`
          <html>
            <head><title>OAuth Timeout</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>OAuth Timeout</h1>
              <p>Timed out fetching OAuth status. MCPO may not be running.</p>
              <p>Please try clicking Authenticate again.</p>
            </body>
          </html>
        `);
      }
      console.error(`[API] OAuth error for ${serverId}:`, error);
      res.status(500).send(`
        <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>OAuth Error</h1>
            <p>Error: ${error.message}</p>
            <p>Please try clicking Authenticate again.</p>
          </body>
        </html>
      `);
    }
  });

  // ============================================================================
  // MCP SERVER ENDPOINTS
  // ============================================================================

  // GET /api/mcp/servers - List all MCP server IDs
  // Used by chat UI to match tool name prefixes to servers
  apiApp.get('/api/mcp/servers', async (req, res) => {
    const catalog = await listMcpServerCatalog(bootstrap.PROJECT_ROOT);
    res.json(catalog.map((server) => server.id));
  });

  // GET /api/mcp/servers/catalog - List IDs with configured display names.
  // The legacy IDs-only endpoint above remains stable for existing callers.
  apiApp.get('/api/mcp/servers/catalog', async (req, res) => {
    res.json(await listMcpServerCatalog(bootstrap.PROJECT_ROOT));
  });

  // GET /api/mcp/servers/:serverId/icon - Get server icon
  // Returns PNG image for the specified MCP server
  apiApp.get('/api/mcp/servers/:serverId/icon', async (req, res) => {
    const { serverId } = req.params;
    const configDirs = [
      path.join(bootstrap.PROJECT_ROOT, 'mcp-configs', serverId),
      path.join(bootstrap.PROJECT_ROOT, 'mcp-configs-user', serverId)
    ];

    for (const dir of configDirs) {
      const iconPath = path.join(dir, `${serverId}.png`);
      try {
        await fsPromises.access(iconPath);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return fs.createReadStream(iconPath).pipe(res);
      } catch {
        // Not in this dir — try next
      }
    }

    res.status(404).json({ error: 'Icon not found' });
  });

  // ============================================================================
  // WORKSPACE + ARTIFACT FILE SERVING ENDPOINTS
  // ============================================================================

  // Serve workspace files as downloads by default and in a constrained image
  // context when explicitly requested by the chat renderer.
  registerWorkspaceFileRoute(apiApp, { projectRoot: bootstrap.PROJECT_ROOT });

  // GET /artifact-preview/:chatId/:artifactId/versions/:version/* - Serve immutable version preview files inline.
  apiApp.get(
    [
      '/artifact-preview/:chatId/:artifactId/versions/:version',
      '/artifact-preview/:chatId/:artifactId/versions/:version/{*filePath}',
    ],
    async (req, res) => {
      const { chatId, artifactId, version } = req.params;
      const filePathParts = req.params.filePath;
      const requestedPath = Array.isArray(filePathParts)
        ? filePathParts.join('/')
        : filePathParts || '';

      let previewFile;
      try {
        previewFile = await resolveArtifactVersionPreviewFile({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
          artifactId,
          version,
          requestedPath,
        });
      } catch (error) {
        const statusCode = error?.statusCode || 500;
        if (statusCode === 403) {
          console.warn(
            `[API] Blocked artifact version preview path: ${chatId}/${artifactId}/versions/${version}/${requestedPath}`,
          );
        }
        return res.status(statusCode).json({
          error: error?.message || 'Failed to resolve artifact version preview',
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(previewFile.filePath, (error) => {
        if (error && !res.headersSent) {
          console.error(`[API] Failed to serve artifact version preview: ${error.message}`);
          res.status(error.statusCode || 500).json({ error: 'Failed to serve artifact version preview' });
        }
      });
    }
  );

  // GET /artifact-preview/:chatId/:artifactId/* - Serve materialized artifact files inline
  // Used as a static preview fallback when the artifact's assigned localhost port isn't reachable.
  apiApp.get(
    ['/artifact-preview/:chatId/:artifactId', '/artifact-preview/:chatId/:artifactId/{*filePath}'],
    async (req, res) => {
      const { chatId, artifactId } = req.params;
      const filePathParts = req.params.filePath;
      const requestedPath = Array.isArray(filePathParts)
        ? filePathParts.join('/')
        : filePathParts || '';

      if (!chatId || !artifactId) {
        return res.status(400).json({ error: 'chatId and artifactId are required' });
      }

      let previewFile;
      try {
        previewFile = await resolveArtifactPreviewFile({
          projectRoot: bootstrap.PROJECT_ROOT,
          chatId,
          artifactId,
          requestedPath,
        });
      } catch (error) {
        const statusCode = error?.statusCode || 500;
        if (statusCode === 403) {
          console.warn(
            `[API] Blocked artifact preview path: ${chatId}/${artifactId}/${requestedPath}`,
          );
        }
        return res.status(statusCode).json({
          error: error?.message || 'Failed to resolve artifact preview',
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(previewFile.filePath, (error) => {
        if (error && !res.headersSent) {
          console.error(`[API] Failed to serve artifact preview: ${error.message}`);
          res.status(error.statusCode || 500).json({ error: 'Failed to serve artifact preview' });
        }
      });
    },
  );

  // ============================================================================
  // ARTIFACT PANEL ENDPOINTS
  // ============================================================================

  // POST /api/artifact/open - MCP signals to open artifact in panel
  // Called by Artifacts MCP server when artifact should be displayed
  apiApp.post('/api/artifact/open', (req, res) => {
    const { artifact_id, preview_url, name, version, detached, chat_id } = req.body;

    if (!artifact_id || !preview_url) {
      return res.status(400).json({ error: 'artifact_id and preview_url required' });
    }

    console.log(`[Artifacts] Opening artifact ${artifact_id} at ${preview_url}, chat: ${chat_id}, detached: ${detached}`);

    // Broadcast to all windows to show artifact panel
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send('artifact-open', {
          artifact_id,
          preview_url,
          name: name || 'Artifact',
          version: version || 1,
          detached: detached || false,
          chat_id
        });
      }
    });

    res.json({ success: true, message: 'Artifact open signal sent' });
  });

  // POST /api/artifact/close - Close artifact panel
  apiApp.post('/api/artifact/close', (req, res) => {
    const { artifact_id } = req.body;

    console.log(`[Artifacts] Closing artifact ${artifact_id || 'current'}`);

    // Broadcast to all windows to close artifact panel
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send('artifact-close', { artifact_id });
      }
    });

    res.json({ success: true, message: 'Artifact close signal sent' });
  });

  // POST /api/artifact/version-changed - Notify of version change
  apiApp.post('/api/artifact/version-changed', (req, res) => {
    const { artifact_id, version, preview_url, host_port } = req.body;

    console.log(`[Artifacts] Artifact ${artifact_id} version changed to ${version}`);

    // Broadcast to all windows
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send('artifact-version-changed', {
          artifact_id,
          version,
          preview_url,
          host_port
        });
      }
    });

    res.json({ success: true });
  });

  // Store the port globally for IPC handlers to access
  // (The actual server is started separately via startApiServer)
  global.workspaceFileServerPort = API_PORT;

  return apiApp;
}

/**
 * Start the API server on the specified port
 * @param {Object} apiApp - Express app instance
 * @returns {Promise<Object>} - Server instance
 */
async function startApiServer(apiApp) {
  // Kill any existing process on port 9876 before starting
  await killProcessOnPort(API_PORT);

  return new Promise((resolve, reject) => {
    let settled = false;

    // Create server without callback to use event-based approach
    const apiServer = apiApp.listen(API_PORT, '127.0.0.1');

    // Register error handler FIRST to catch EADDRINUSE before 'listening' fires
    apiServer.on('error', (error) => {
      if (settled) return;
      settled = true;
      const errMsg = `[API] ❌ Server failed to start: ${error.message}\n`;
      console.error(errMsg);
      reject(error);
    });

    // Then register listening handler
    apiServer.on('listening', () => {
      if (settled) return;
      settled = true;
      const msg = `[API] ✅ REST API server READY on http://127.0.0.1:${API_PORT}\n`;
      console.log(msg);
      resolve(apiServer);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('API server startup timeout'));
    }, 5000);
  });
}

// ============================================================================
// GLOBAL ERROR HANDLERS
// ============================================================================

// Global error handlers to catch startup/runtime failures
process.on('uncaughtException', (err) => {
  console.error('[API] Uncaught exception:', err);
  try {
    sendInitLog(`[API] ❌ Uncaught exception: ${err.message}\n`, 'error');
  } catch (logErr) {
    // sendInitLog may not be available
    console.error('[API] Could not log uncaught exception to init file');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[API] Unhandled rejection:', reason);
  try {
    sendInitLog(`[API] ❌ Unhandled rejection: ${String(reason)}\n`, 'error');
  } catch (logErr) {
    // sendInitLog may not be available
    console.error('[API] Could not log unhandled rejection to init file');
  }
});

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Server creation and startup
  createApiServer,
  startApiServer,

  // LLM-side normalization (exported for tests)
  stripAssistantServerPrefix,
  normalizeBridgeEnableClientIds,
  normalizeBridgeEnableTimeoutMs,
  summarizeBridgeClientState,
  bridgeScriptAction,

  // Shared post-OAuth readiness recovery
  waitForPostOauthServerRecovery,

  // Readiness helpers
  normalizeReadinessStatus,
  isServerEffectivelyEnabled,
  disabledReadinessStatus,
  shouldReconcileHealthStatusFromReadiness,
  reconcileHealthStatusFromReadiness,

  // Port constant
  API_PORT
};
