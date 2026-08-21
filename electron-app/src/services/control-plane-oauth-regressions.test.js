const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function assertIncludes(haystack, needle, message) {
  assert.ok(
    haystack.includes(needle),
    message || `expected content to include ${JSON.stringify(needle)}`,
  );
}

function assertNormalizedIncludes(haystack, needle, message) {
  assertIncludes(
    normalizeWhitespace(haystack),
    normalizeWhitespace(needle),
    message,
  );
}

function assertOrderedIncludes(haystack, needles, message) {
  let cursor = 0;
  for (const needle of needles) {
    const nextIndex = haystack.indexOf(needle, cursor);
    assert.notEqual(
      nextIndex,
      -1,
      message || `expected content to include ${JSON.stringify(needle)} in order`,
    );
    cursor = nextIndex + needle.length;
  }
}

function extractFunctionBlock(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(
    signatureIndex,
    -1,
    `expected function signature ${JSON.stringify(signature)}`,
  );
  const openBraceIndex = source.indexOf("{", signatureIndex);
  assert.notEqual(openBraceIndex, -1, `expected opening brace for ${signature}`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(signatureIndex, index + 1);
      }
    }
  }

  assert.fail(`unterminated function block for ${signature}`);
}

test("control plane OAuth wizard matches guided setup Connect copy", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.html",
  );
  const source = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );

  assertIncludes(html, '<h2 class="oauth-wizard-title">Connect</h2>');
  assertIncludes(html, 'id="oauth-wizard-description"');
  assertIncludes(html, 'id="oauth-wizard-authorize-btn">Connect</button>');
  assertOrderedIncludes(html, [
    'id="oauth-wizard-next-btn"',
    "You can always connect more integrations later.",
    ">Skip</button>",
  ]);
  assertOrderedIncludes(html, [
    'id="oauth-wizard-skip-all-btn"',
    "You can always connect more integrations later.",
    ">Skip All</button>",
  ]);
  assertOrderedIncludes(normalizeWhitespace(html), [
    '[data-theme="light"] .oauth-wizard-preview-icon[data-logo-kind="portico"] {',
    "padding: 6px;",
    "background: #153f90;",
    "filter: none;",
  ]);
  assertOrderedIncludes(normalizeWhitespace(html), [
    '[data-theme="light"] .oauth-wizard-server-icon[data-logo-kind="portico"] {',
    "padding: 10px;",
    "background: #153f90;",
    "filter: none;",
  ]);
  assertIncludes(source, "const SINGLE_SERVER_WIZARD_DESCRIPTION =");
  assertIncludes(source, "const MULTI_SERVER_WIZARD_DESCRIPTION =");
  assertIncludes(
    source,
    "Let's connect your integration. You'll be asked to sign in.",
  );
  assertIncludes(
    source,
    "Let's connect your integrations. You'll be asked to sign in for each one.",
  );
  assertIncludes(source, "function getWizardDescriptionText(serverCount)");
  assertIncludes(source, "serverCount === 1");
  assertIncludes(
    source,
    "updateWizardDescriptionText(oauthWizardState.servers.length);",
  );
});

test("control plane OAuth wizard keeps a draggable macOS backdrop while dialog controls stay interactive", () => {
  const html = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.html",
  );

  assert.match(
    html,
    /\.platform-darwin\s+\.oauth-wizard-modal\.visible\s*\{[^}]*-webkit-app-region:\s*drag;[^}]*\}/s,
    "the OAuth wizard should make the visible macOS backdrop a window drag plane",
  );
  assert.match(
    html,
    /\.platform-darwin\s+\.oauth-wizard-content,\s*\.platform-darwin\s+\.oauth-wizard-content\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag;[^}]*\}/s,
    "the OAuth wizard should keep the dialog card and all nested controls interactive on macOS",
  );
});

test("control plane OAuth wizard carries logo kind through preview and current server rendering", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );

  assertNormalizedIncludes(
    source,
    "logoKind: server.logoKind || server.logo_kind || null",
  );
  assertIncludes(source, "function getWizardLogoKind(metadata = {})");
  assertIncludes(source, "const PORTICO_LOGO_SERVER_IDS = new Set([");
  assertIncludes(source, '"data-plat-mcp"');
  assertIncludes(source, '"ownership-mcp"');
  assertIncludes(source, '"teamworks-mcp"');
  assertIncludes(
    source,
    '<img class="oauth-wizard-preview-icon" data-logo-kind="${logoKind}"',
  );
  assertIncludes(source, "icon.dataset.logoKind = getWizardLogoKind(metadata);");
  assertIncludes(source, "icon.removeAttribute('data-logo-kind');");
});

test("control plane OAuth wizard starts a queue and auto-advances after the first connect", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );

  assertNormalizedIncludes(source, "queueStarted: false");
  assertIncludes(source, "function scheduleWizardAutoStartForCurrent()");
  assertIncludes(source, "oauthWizardState.queueStarted = true;");
  assertOrderedIncludes(source, [
    "if (shouldAutoAdvanceAfterWizardSuccess()) {",
    "advanceToNextPendingWizardServer();",
  ]);
  assertOrderedIncludes(source, [
    "function advanceToNextPendingWizardServer()",
    "navigateWizardToServer(nextPending, { autoStart: true });",
  ]);
  assertOrderedIncludes(source, [
    "retryBtn.onclick = () => {",
    "if (oauthWizardState.queueStarted) {",
    "scheduleWizardAutoStartForCurrent();",
  ]);
  assertOrderedIncludes(source, [
    "backBtn.onclick = () => {",
    "if (oauthWizardState.queueStarted) {",
    "scheduleWizardAutoStartForCurrent();",
  ]);
});

test("control plane backend-triggered OAuth reuses the shared wizard flow without auto-closing after the first server", () => {
  const wizardSource = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");
  const backendListenersSource = readRepoFile(
    "electron-app/src/renderer/components/backend-modal-listeners.js",
  );

  assertIncludes(
    wizardSource,
    "function dismissWizardRequestedServerIfNeeded(serverId = null)",
  );
  // The dismissible-request fallback moved into the body (default is null now).
  assertIncludes(
    wizardSource,
    "oauthWizardState.dismissibleRequestServerId",
  );
  assertOrderedIncludes(wizardSource, [
    "function setOAuthWizardInteractionSuppressed(suppressed) {",
    'setOwuiInteractionSuppressed?.("oauth-wizard", suppressed);',
    'setNativeOverlayInteractionSuppressed?.("oauth-wizard", suppressed);',
  ]);
  assertIncludes(wizardSource, "function revealExistingOAuthWizard(options = {})");
  // The reveal-existing path keeps backend-triggered re-auth re-using the
  // open wizard for SAME-server requests. A different-server backend
  // request takes over instead — see the `hasNewServer` branch.
  assertOrderedIncludes(wizardSource, [
    "if (oauthWizardFlowInProgress && !hasNewServer) {",
    "revealing existing wizard",
    "reusedExistingFlow: true",
  ]);
  assertOrderedIncludes(wizardSource, [
    "if (oauthWizardFlowInProgress && hasNewServer) {",
    "aborting prior flow and re-initializing",
  ]);
  assertOrderedIncludes(wizardSource, [
    "} else if (backendManaged) {",
    "backend request will finish main-stack recovery",
  ]);
  assertOrderedIncludes(wizardSource, [
    "updateWizardServerRecoveryState(serverId, {",
    "window.markMcpServerPostSuccessStarting?.(serverId, {",
    "stage: 'checking'",
    "detail: 'Checking...'",
    "operationKind: 'post_oauth_recovery'",
    "postAuthRecovery: true",
    "[OAuth Wizard] Starting background prod recovery for ${serverId}",
  ]);
  assertIncludes(
    wizardSource,
    "!isWizardBackendManagedServer(getWizardServerId(server))",
  );
  assertIncludes(
    mcpServersSource,
    "async function runOAuthFlowForServer(serverId, options = {})",
  );
  assertIncludes(mcpServersSource, "const forceAuth = Boolean(options.forceAuth);");
  assertIncludes(
    mcpServersSource,
    "const resumeExisting = Boolean(options.resumeExisting);",
  );
  assertNormalizedIncludes(
    mcpServersSource,
    "const allServersNeedingOAuth = forceAuth ? [buildServerForReauth(serverId)] : findAllServersNeedingOAuth({ requestedServerId: serverId });",
  );
  assertOrderedIncludes(mcpServersSource, [
    "forceAuthAll: !forceAuth,",
    "forceAuthServerIds: forceAuth ? [serverId] : []",
  ]);
  assertOrderedIncludes(mcpServersSource, [
    "flowSource,",
    "resumeExisting,",
    "requestedServerId:",
    "backendManagedServerIds:",
  ]);
  assertNormalizedIncludes(
    indexSource,
    "window.setupBackendModalListeners({ label: 'Control Panel' });",
  );
  assertOrderedIncludes(backendListenersSource, [
    "window.electronAPI?.onOAuthFlowRequested?.((payload) => {",
    'runOrDeferBackendModal("oauth", payload, options, runBackendOAuthFlow);',
  ]);
  assertOrderedIncludes(backendListenersSource, [
    "refreshServerAfterOperation(server_id, {",
    "waitForHealthy: false,",
    "maxWait: 1000",
  ]);
  assertOrderedIncludes(backendListenersSource, [
    "window.runOAuthFlowForServer(server_id, {",
    'flowSource: "backend-requested"',
    "forceAuth: Boolean(force_auth)",
    "resumeExisting: Boolean(resume_existing)",
    "showNotifications: false",
  ]);
  assert.ok(!indexSource.includes("runOAuthFlowForSingleServer("));
});

test("control plane OAuth discovery honors backend needs_oauth state without OAuth metadata", () => {
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const discoveryStart = mcpServersSource.indexOf(
    "function findAllServersNeedingOAuth(options = {})",
  );
  const discoveryEnd = mcpServersSource.indexOf(
    "function buildServerForReauth(serverId)",
    discoveryStart,
  );
  assert.notEqual(discoveryStart, -1);
  assert.notEqual(discoveryEnd, -1);
  const discoveryBlock = mcpServersSource.slice(discoveryStart, discoveryEnd);

  assert.ok(
    !discoveryBlock.includes("!serverConfig || !serverRequiresOAuth(serverConfig)"),
    "OAuth discovery must not drop servers that backend health already marked as needing OAuth",
  );
  assertOrderedIncludes(discoveryBlock, [
    "const healthInfo = healthServers[serverId] || {};",
    'const healthStatus = healthInfo?.status || "unknown";',
    "const backendNeedsAuth = shouldShowNeedsAuth(healthStatus, healthInfo);",
    "const metadataRequiresOAuth = serverRequiresOAuth(serverConfig);",
    "if (!metadataRequiresOAuth && !backendNeedsAuth) {",
  ]);
  assertOrderedIncludes(discoveryBlock, [
    "if (!backendNeedsAuth && !needsAuthByMetadata) {",
    "continue;",
  ]);
});

test("dual-requirement OAuth completion transitions to configuration without production recovery", () => {
  const wizardSource = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );

  assertOrderedIncludes(wizardSource, [
    "const configurationPending = isWizardConfigurationPending(item);",
    "window.markMcpServerOAuthAuthenticated?.(serverId, {",
    "if (configurationPending) {",
    "postAuthSyncState: 'configuration_pending'",
    "syncState: 'configuration_pending'",
    "} else if (backendManaged) {",
  ]);
  assertIncludes(
    wizardSource,
    "!isWizardConfigurationPending(server)",
  );
  assertOrderedIncludes(wizardSource, [
    "if (isWizardConfigurationPending(wizardItem)) {",
    "state: 'configuration_pending'",
    "return task.promise;",
    "window.markMcpServerPostSuccessStarting?.(serverId, {",
  ]);
  assertIncludes(
    wizardSource,
    "Complete configuration from the Control Plane to finish setup.",
  );
  assertOrderedIncludes(mcpServersSource, [
    "configurationPending:",
    "serverRequiresConfig(serverConfig)",
    "serverConfig.isConfigured !== true",
  ]);
  assertIncludes(
    mcpServersSource,
    "window.markMcpServerOAuthAuthenticated = markMcpServerOAuthAuthenticated;",
  );
});

test("post-operation MCP refresh does not promote servers to healthy from tool inventory alone", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const normalized = normalizeWhitespace(source);

  assertOrderedIncludes(source, [
    "if (result.success && result.totalCount > 0) {",
    "enabledCount = result.enabledCount || 0;",
    "totalCount = result.totalCount || 0;",
    "state.serverToolsCache[serverId] = {",
    'if (readiness?.healthy || lastReadinessPhase === "tool_ready") {',
    "healthy = true;",
  ]);
  assert.ok(
    !normalized.includes(
      normalizeWhitespace(
        'state.healthStatus.servers[serverId] = { ...(state.healthStatus.servers[serverId] || {}), status: "healthy"',
      ),
    ),
    "tool inventory should not overwrite readiness-derived health state",
  );
});

test("post-operation MCP refresh distinguishes stable readiness from hard startup failure", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const stableBranchStart = source.indexOf("if (reachedStableReadiness) {");
  const stableBranchEnd = source.indexOf(
    "} else if (!reachedHardFailure) {",
    stableBranchStart,
  );
  const stableBranch = source.slice(stableBranchStart, stableBranchEnd);

  assertIncludes(
    source,
    "function shouldContinueWaitingForPostOperationReadiness(",
  );
  assertOrderedIncludes(source, [
    "const shouldContinueWaiting =",
    "POST_OPERATION_STABLE_READINESS_PHASES.has(lastReadinessPhase) &&",
    "!shouldContinueWaiting",
    "reachedStableReadiness = true;",
    "setPendingServerOperation(serverId, {",
    "stage: nextStage,",
  ]);
  assertOrderedIncludes(source, [
    "if (reachedStableReadiness) {",
    'stage: lastTerminalStage,',
    "detail: lastTerminalDetail,",
    "} else if (!reachedHardFailure) {",
    'stage: "continuing",',
  ]);
  assertOrderedIncludes(source, [
    "const finalStatus = lastTerminalStage === \"timeout\" ? \"timeout\" : \"failed\";",
    "status: finalStatus,",
    "stage: lastTerminalStage,",
  ]);
  assert.doesNotMatch(
    stableBranch,
    /status:\s*"failed"/,
    "stable readiness handling should not rewrite settled needs_oauth state into failed",
  );
});

test("control plane re-auth preserves durable tokens and launches a single-server OAuth wizard", () => {
  const mcpServersSource = readRepoFile(
    "electron-app/src/renderer/components/mcp-servers.js",
  );
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const apiSource = readRepoFile("electron-app/src/services/api.js");
  const wizardSource = readRepoFile(
    "electron-app/src/renderer/components/oauth-wizard-modal.js",
  );
  const sharedModalSource = readRepoFile(
    "electron-app/src/renderer/components/oauth-modal-shared.js",
  );
  const guidedSetupSource = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-oauth.js",
  );

  const confirmReauthBlock = extractFunctionBlock(
    mcpServersSource,
    "async function confirmReauth()",
  );

  assertIncludes(
    mcpServersSource,
    "async function runReauthFlowForServer(serverId)",
  );
  assertOrderedIncludes(mcpServersSource, [
    "window.runOAuthWizard([serverForReauth], {",
    "preferredServerId: serverId,",
    "forceAuthServerIds: [serverId],",
    'flowSource: "manual"',
  ]);
  assert.ok(!confirmReauthBlock.includes("window.electronAPI.clearOAuthTokens(serverId)"));
  assert.ok(!confirmReauthBlock.includes("resetClientRegistration"));
  assert.ok(!confirmReauthBlock.includes("runOAuthFlowForServer(serverId)"));
  assertNormalizedIncludes(
    preloadSource,
    "prepareOAuthStart: (serverId) => ipcRenderer.invoke('prepare-oauth-start', serverId)",
  );
  assertNormalizedIncludes(
    preloadSource,
    "clearOAuthTokens: (serverId) => ipcRenderer.invoke('clear-oauth-tokens', serverId)",
  );
  assertIncludes(ipcSource, 'ipcMain.handle("prepare-oauth-start"');
  assertOrderedIncludes(ipcSource, [
    'ipcMain.handle("prepare-oauth-start"',
    "clearLegacyOAuthFiles(serverId,",
    "preservedSecureRecord=true",
  ]);
  assertIncludes(ipcSource, 'ipcMain.handle("clear-oauth-tokens"');
  assertIncludes(apiSource, "const forceAuth = Boolean(req.body?.force_auth);");
  assertOrderedIncludes(apiSource, [
    'if (oauthTriggerDisposition.type === "already_authorized") {',
    "already_authorized: true",
  ]);
  assertIncludes(apiSource, "function prepareFreshOAuthFlow(serverId)");
  assertOrderedIncludes(apiSource, [
    "if (completedOAuthFlows.has(server_id)) {",
    "const clearResult = prepareFreshOAuthFlow(server_id);",
    "const session = startTrackedOAuthSession(server_id, {",
  ]);
  assert.ok(!apiSource.includes("const existingOAuthSession = oauthFlowSessions.get(server_id);"));
  assertNormalizedIncludes(
    apiSource,
    "function startTrackedOAuthSession(serverId, options)",
  );
  assertNormalizedIncludes(
    apiSource,
    "function runTrackedOAuthFlowSession(serverId, options)",
  );
  assertOrderedIncludes(apiSource, [
    "function broadcastOAuthFlowRequested(payload)",
    'sendBackendModalRequest("oauth-flow-requested", payload);',
  ]);
  assert.ok(!apiSource.includes("resetClientRegistration"));
  assert.ok(!wizardSource.includes("reauthServerIds"));
  assert.ok(!wizardSource.includes("clientResetFallbackAttemptedServerIds"));
  assert.ok(!wizardSource.includes("shouldAttemptWizardClientResetFallback"));
  assert.ok(!wizardSource.includes("retryWizardAuthorizationAfterClientReset"));
  assertIncludes(
    wizardSource,
    "async function prepareWizardForFreshOAuthStart(serverId)",
  );
  assertIncludes(
    wizardSource,
    "function shouldReuseBackendPreparedOAuthState(serverId)",
  );
  assertOrderedIncludes(wizardSource, [
    "if (shouldReuseBackendPreparedOAuthState(serverId)) {",
    "updateWizardTestStep('standalone', 'running', 'Using prepared OAuth state...');",
    "} else {",
    "updateWizardTestStep('standalone', 'running', 'Preparing OAuth state...');",
    "await prepareWizardForFreshOAuthStart(serverId);",
    "const startResult = await window.electronAPI.startSingleMcpServer(",
    "{ oauthMode: 'bootstrap' },",
  ]);
  assertOrderedIncludes(wizardSource, [
    "await window.electronAPI.stopSingleMcpServer(serverId, {",
    "sessionId: singleServerSessionId,",
    "await prepareWizardForFreshOAuthStart(serverId);",
    "const restartResult = await window.electronAPI.startSingleMcpServer(",
    "{ oauthMode: 'bootstrap' },",
  ]);
  assert.ok(!wizardSource.includes("window.electronAPI.clearOAuthTokens(serverId)"));
  assertIncludes(
    sharedModalSource,
    "async function prepareForFreshOAuthStart(serverId)",
  );
  assertIncludes(
    sharedModalSource,
    "window.electronAPI.prepareOAuthStart(serverId)",
  );
  assertOrderedIncludes(sharedModalSource, [
    "await prepareForFreshOAuthStart(serverId);",
    "const refreshResult = await window.electronAPI.refreshOAuthUrl(serverId);",
  ]);
  assertOrderedIncludes(sharedModalSource, [
    "await prepareForFreshOAuthStart(serverId);",
    "await window.electronAPI.apiRestartMcpServers([serverId]);",
  ]);
  assertIncludes(
    guidedSetupSource,
    "async function prepareForFreshOauthStart(serverId)",
  );
  assertIncludes(
    guidedSetupSource,
    "window.electronAPI.prepareOAuthStart(serverId)",
  );
  assertOrderedIncludes(guidedSetupSource, [
    "updateTestStep('standalone', 'running', 'Preparing OAuth state...');",
    "await prepareForFreshOauthStart(serverId);",
    "const startResult = await window.electronAPI.startSingleMcpServer(",
    "{ oauthMode: 'bootstrap' },",
  ]);
  assertOrderedIncludes(guidedSetupSource, [
    "await window.electronAPI.stopSingleMcpServer(serverId, {",
    "sessionId: singleServerSessionId,",
    "await prepareForFreshOauthStart(serverId);",
    "const restartResult = await window.electronAPI.startSingleMcpServer(",
    "{ oauthMode: 'bootstrap' },",
  ]);
});

test("MCP Assistant authorize_integration routes through trigger-oauth-flow for agentic OAuth", () => {
  const rustSource = readRepoFile(
    "src/core-mcp-rust/crates/mcp-assistant-server/src/native/mcp_assistant.rs",
  );

  assertOrderedIncludes(rustSource, [
    "handle_authorize_integration",
    "trigger_payload[\"chat_id\"]",
    '"/api/trigger-oauth-flow"',
  ]);
});

test("single-server IPC performs one bounded Compose recovery and preserves typed diagnostics", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const composeCommandSource = readRepoFile(
    "electron-app/src/services/docker-compose-command.js",
  );

  assertIncludes(
    ipcSource,
    "let singleServerComposeRecoveryAttempted = false;",
  );
  assertOrderedIncludes(ipcSource, [
    "const composeFailure = classifyDockerComposeFailure(error);",
    "singleServerComposeRecoveryAttempted = true;",
    "await dockerMcp.restartOrbStackAndWaitForDocker({",
    "await waitForDockerComposeFrontendReady(",
    "startOutput = await runStartAttempt();",
  ]);
  assertIncludes(
    composeCommandSource,
    'code: "docker_compose_unavailable"',
  );
  assertIncludes(ipcSource, "selectedFrontend:");
  assertIncludes(ipcSource, "probeDiagnostics:");
  assertIncludes(ipcSource, "recoveryAttempted: true");
});
