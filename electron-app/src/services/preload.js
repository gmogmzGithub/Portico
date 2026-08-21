const { contextBridge, ipcRenderer } = require('electron');

function sendLogToMain(levelOrPayload, message, meta) {
  if (
    typeof levelOrPayload === 'object' &&
    levelOrPayload !== null &&
    !Array.isArray(levelOrPayload)
  ) {
    ipcRenderer.send('log-to-main', levelOrPayload);
    return;
  }

  ipcRenderer.send('log-to-main', {
    level: levelOrPayload,
    message,
    meta,
  });
}

// Consolidated preload script for all windows
contextBridge.exposeInMainWorld('electronAPI', {
  // Environment configuration
  loadEnv: () => ipcRenderer.invoke('load-env'),
  updateEnvVar: (varName, value) => ipcRenderer.invoke('update-env-var', varName, value),

  // Raw .env file operations (for guided-setup)
  readEnvFile: () => ipcRenderer.invoke('read-env-file'),
  writeEnvFile: (content) => ipcRenderer.invoke('write-env-file', content),
  upsertRuntimeSecret: (key, value) =>
    ipcRenderer.invoke('upsert-runtime-secret', key, value),
  getMcpSensitiveSecretPresence: (serverId) =>
    ipcRenderer.invoke('get-mcp-sensitive-secret-presence', serverId),
  getProjectRoot: () => ipcRenderer.invoke('get-project-root'),
  getGuidedSetupBootstrapState: () => ipcRenderer.invoke('get-guided-setup-bootstrap-state'),
  getSetupLaunchDecision: () => ipcRenderer.invoke('get-setup-launch-decision'),
  saveGuidedSetupModePreference: (mode) => ipcRenderer.invoke('save-guided-setup-mode-preference', mode),
  getChatWebviewPreloadPath: () => ipcRenderer.invoke('get-chat-webview-preload-path'),
  readSetupGuide: (guideName) => ipcRenderer.invoke('read-setup-guide', guideName),
  
  // MCP server configuration
  loadMcpServers: () => ipcRenderer.invoke('load-mcp-servers'),
  addMcpServer: (serverId, fragment) => ipcRenderer.invoke('add-mcp-server', serverId, fragment),
  removeMcpServer: (serverId) => ipcRenderer.invoke('remove-mcp-server', serverId),
  loadMcpToggles: () => ipcRenderer.invoke('load-mcp-toggles'),
  loadMcpDisableModes: () => ipcRenderer.invoke('load-mcp-disable-modes'),
  setMcpDisableMode: (serverId, mode) =>
    ipcRenderer.invoke('set-mcp-disable-mode', serverId, mode),
  loadGuidedSetupMcpToggles: () => ipcRenderer.invoke('load-guided-setup-mcp-toggles'),
  applyGuidedSetupMcpToggleChanges: (payload) =>
    ipcRenderer.invoke('apply-guided-setup-mcp-toggle-changes', payload),
  saveMcpToggles: (toggles) => ipcRenderer.invoke('save-mcp-toggles', toggles),
  checkHostMode: () => ipcRenderer.invoke('check-host-mode'),
  shouldSkipPrerequisites: () => ipcRenderer.invoke('should-skip-prerequisites'),
  checkVpnConnectivity: () => ipcRenderer.invoke('check-vpn-connectivity'),

  // MCP tool configuration
  getServerTools: (serverId, options = {}) => ipcRenderer.invoke('get-server-tools', serverId, options),
  saveServerTools: (serverId, disabledTools) => ipcRenderer.invoke('save-server-tools', serverId, disabledTools),
  invokeMcpTool: (serverId, toolName, inputs, mcpoPort) => ipcRenderer.invoke('invoke-mcp-tool', serverId, toolName, inputs, mcpoPort),
  
  // System operations
  saveConfig: () => ipcRenderer.invoke('save-config'),
  openHttpUrl: (url) => ipcRenderer.invoke('open-url', url),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openExternal: (url, context = {}) =>
    ipcRenderer.invoke('open-external', url, context),
  openLocalPath: (targetPath) => ipcRenderer.invoke('open-local-path', targetPath),
  probeUrlStatus: (url) => ipcRenderer.invoke('probe-url-status', url),
  getUsername: () => ipcRenderer.invoke('get-username'),
  getBuildInfo: () => ipcRenderer.invoke('get-build-info'),
  getMarketplaceAutoApprove: () => ipcRenderer.invoke('marketplace-auto-approve-get'),
  setMarketplaceAutoApprove: (enabled) => ipcRenderer.invoke('marketplace-auto-approve-set', enabled),
  markSetupRequirementCompleted: () => ipcRenderer.invoke('mark-setup-requirement-completed'),
  generateMcpConfig: (projectRoot) => ipcRenderer.invoke('generate-mcp-config', projectRoot),
  checkDocker: () => ipcRenderer.invoke('check-docker'),
  startContainers: () => ipcRenderer.invoke('start-containers'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openTerminalWithCommand: (command) => ipcRenderer.invoke('open-terminal-with-command', command),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  startUpdatePreparation: (updateInfo, options = {}) => ipcRenderer.invoke('start-update-preparation', updateInfo, options),
  getUpdatePreparationStatus: () => ipcRenderer.invoke('get-update-preparation-status'),
  cancelUpdatePreparation: () => ipcRenderer.invoke('cancel-update-preparation'),
  runUpdate: (updateInfo) => ipcRenderer.invoke('run-update', updateInfo),
  executeUpdate: (updateInfo) => ipcRenderer.invoke('execute-update', updateInfo),
  restartAfterUpdate: () => ipcRenderer.invoke('restart-after-update'),
  showUpdateDialog: (updateInfo) => ipcRenderer.invoke('show-update-dialog', updateInfo),
  showLaunchUpdateDialog: (updateInfo) => ipcRenderer.invoke('show-launch-update-dialog', updateInfo),
  startUpdateFromMainWindow: (updateInfo) => ipcRenderer.invoke('start-update-from-main-window', updateInfo),
  
  // Docker operations (manager mode)
  dockerStart: () => ipcRenderer.invoke('docker-start'),
  dockerStop: () => ipcRenderer.invoke('docker-stop'),
  dockerRestart: () => ipcRenderer.invoke('docker-restart'),
  dockerStatus: () => ipcRenderer.invoke('docker-status'),
  dockerLogs: (container, lines) => ipcRenderer.invoke('docker-logs', container, lines),
  checkOpenWebuiReady: () => ipcRenderer.invoke('check-open-webui-ready'),
  detectOpenWebuiDbCorruption: (options = {}) => ipcRenderer.invoke('detect-open-webui-db-corruption', options),
  repairOpenWebuiDb: (options = {}) => ipcRenderer.invoke('repair-open-webui-db', options),
  restoreOpenWebuiDbFromBackup: (options = {}) => ipcRenderer.invoke('restore-open-webui-db-from-backup', options),
  rollbackOpenWebuiDbRepair: (options = {}) => ipcRenderer.invoke('rollback-open-webui-db-repair', options),

  // Host MCPO operations
  hostMcpoStatus: () => ipcRenderer.invoke('host-mcpo-status'),
  hostMcpoRestart: () => ipcRenderer.invoke('host-mcpo-restart'),
  hostMcpoLogs: (lines) => ipcRenderer.invoke('host-mcpo-logs', lines),
  stopHostMcpo: () => ipcRenderer.invoke('stop-host-mcpo'),
  hostMcpBridgeStatus: () => ipcRenderer.invoke('host-mcp-bridge-status'),
  hostMcpBridgeStart: () => ipcRenderer.invoke('start-host-mcp-bridge'),
  hostMcpBridgeRestart: () => ipcRenderer.invoke('host-mcp-bridge-restart'),
  hostMcpBridgeLogs: (lines) => ipcRenderer.invoke('host-mcp-bridge-logs', lines),
  stopHostMcpBridge: () => ipcRenderer.invoke('stop-host-mcp-bridge'),
  hostMcpBridgeConfigDetect: () => ipcRenderer.invoke('host-mcp-bridge-config-detect'),
  hostMcpBridgeConfigureClients: (payload) => ipcRenderer.invoke('host-mcp-bridge-configure-clients', payload),
  hostMcpBridgeRemoveClientConfigs: (payload) => ipcRenderer.invoke('host-mcp-bridge-remove-client-configs', payload),
  hostMcpBridgeRevealClientConfig: (payload) => ipcRenderer.invoke('host-mcp-bridge-reveal-client-config', payload),

  // Diagnostics operations (one-shot, triggered by user button press only)
  collectDiagnosticSnapshot: () => ipcRenderer.invoke('collect-diagnostic-snapshot'),
  saveDiagnosticReport: (payload) => ipcRenderer.invoke('save-diagnostic-report', payload),
  openDiagnosticsFolder: (dirPath) => ipcRenderer.invoke('open-local-path', dirPath),

  // Debug operations
  collectDebugInfo: () => ipcRenderer.invoke('collect-debug-info'),
  onDebugCollectProgress: (callback) => {
    ipcRenderer.on('debug-collect-progress', (_event, payload) => callback(payload));
  },
  uploadDebugLogs: (opts) => ipcRenderer.invoke('upload-debug-logs', opts),
  getBugReportIdentity: () => ipcRenderer.invoke('get-bug-report-identity'),
  getGuidedSetupDebugSections: () => ipcRenderer.invoke('get-guided-setup-debug-sections'),
  saveControlPaneLogs: (logs) => ipcRenderer.invoke('save-control-panel-logs', logs),
  clearWebviewCache: () => ipcRenderer.invoke('clear-webview-cache'),
  logToMain: (levelOrPayload, message, meta) =>
    sendLogToMain(levelOrPayload, message, meta),
  onOwuiDebugRequestModal: (callback) => {
    ipcRenderer.on('owui-debug-request-modal', (_event, payload) => callback(payload));
  },
  onOwuiDebugModeChanged: (callback) => {
    ipcRenderer.on('owui-debug-mode-changed', (_event, payload) => callback(payload));
  },
  
  // Streaming operations
  dockerStopWithLogs: () => ipcRenderer.invoke('docker-stop-with-logs'),
  
  // Window operations
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
  isCurrentWindowFullscreen: () => ipcRenderer.invoke('window-is-full-screen'),
  setMacTrafficLightPosition: (x, y) =>
    ipcRenderer.invoke('set-mac-traffic-light-position', { x, y }),
  openChat: () => ipcRenderer.invoke('open-chat'),
  requestOpenNewChatTab: (options = {}) =>
    ipcRenderer.invoke('request-open-new-chat-tab', options),
  completeOpenNewChatTabRequest: (result = {}) =>
    ipcRenderer.send('complete-open-new-chat-tab-request', result),
  detachConversation: (conversationId, url, title, windowType, options = {}) =>
    ipcRenderer.invoke('conversation-detach', {
      conversationId,
      url,
      title,
      windowType,
      ...options,
    }),
  focusConversationWindowIfOpen: (conversationId) =>
    ipcRenderer
      .invoke('conversation-window-focus-if-open', { conversationId })
      .then((result) => result?.focused === true)
      .catch(() => false),
  setDetachedConversationWindowTitle: (title) =>
    ipcRenderer.invoke('detached-conversation-set-title', title),
  attachConversationToMain: (payload = {}) =>
    ipcRenderer.invoke('conversation-attach', payload),
  completeConversationAttach: (requestId, result = {}) =>
    ipcRenderer.send('conversation-attach-complete', { requestId, result }),
  launchGuidedSetup: () => ipcRenderer.invoke('launch-electron-app'),
  showConfig: () => ipcRenderer.send('show-config'),
  openManager: () => ipcRenderer.send('open-manager'),
  setLoadingWindowLogsDrawerOpen: (open) => ipcRenderer.invoke('set-loading-window-logs-drawer-open', open),
  setupWebviewLinkHandler: (webviewId) => ipcRenderer.send('setup-webview-link-handler', webviewId),
  mcpTooltip: {
    show: async (payload) => {
      const result = await ipcRenderer.invoke('mcp-tooltip-show', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to show MCP tooltip');
      return result.shown;
    },
    hide: async () => {
      const result = await ipcRenderer.invoke('mcp-tooltip-hide');
      if (!result?.success) throw new Error(result?.error || 'Failed to hide MCP tooltip');
      return true;
    },
  },
  updatePrepTooltip: {
    show: async (payload) => {
      const result = await ipcRenderer.invoke('update-prep-tooltip-show', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to show update preparation tooltip');
      return result.shown;
    },
    hide: async () => {
      const result = await ipcRenderer.invoke('update-prep-tooltip-hide');
      if (!result?.success) throw new Error(result?.error || 'Failed to hide update preparation tooltip');
      return true;
    },
  },
  artifactVersionMenu: {
    show: async (payload) => {
      const result = await ipcRenderer.invoke('artifact-version-menu-show', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to show artifact version menu');
      return result.shown;
    },
    hide: async (payload = {}) => {
      const result = await ipcRenderer.invoke('artifact-version-menu-hide', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to hide artifact version menu');
      return true;
    },
    onEvent: (callback) => {
      ipcRenderer.on('artifact-version-menu-event', (_event, payload) => callback(payload));
    },
  },
  artifactDividerOverlay: {
    sync: async (bounds) => {
      const result = await ipcRenderer.invoke('artifact-divider-overlay-sync', { bounds });
      if (!result?.success) throw new Error(result?.error || 'Failed to sync artifact divider overlay');
      return result.state;
    },
    hide: async (payload = {}) => {
      const result = await ipcRenderer.invoke('artifact-divider-overlay-hide', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to hide artifact divider overlay');
      return true;
    },
    onEvent: (callback) => {
      ipcRenderer.on('artifact-divider-overlay-event', (_event, payload) => callback(payload));
    },
  },
  localFindOverlay: {
    sync: async (payload = {}) => {
      const result = await ipcRenderer.invoke('local-find-overlay-sync', payload);
      if (!result?.success) throw new Error(result?.error || 'Failed to sync local find overlay');
      return result.state;
    },
    onEvent: (callback) => {
      ipcRenderer.on('local-find-overlay-event', (_event, payload) => callback(payload));
    },
  },
  owui: {
    createOrAdoptView: async (options) => {
      const result = await ipcRenderer.invoke('owui-create-or-adopt-view', options);
      if (!result?.success) throw new Error(result?.error || 'Failed to create OWUI view');
      return result.state;
    },
    destroyView: async (viewKey, expectedWebContentsId) => {
      const result = await ipcRenderer.invoke('owui-destroy-view', {
        viewKey,
        expectedWebContentsId,
      });
      if (!result?.success) throw new Error(result?.error || 'Failed to destroy OWUI view');
      return result.destroyed;
    },
    recreateView: async (viewKey, url) => {
      const result = await ipcRenderer.invoke('owui-recreate-view', { viewKey, url });
      if (!result?.success) throw new Error(result?.error || 'Failed to recreate OWUI view');
      return result.state;
    },
    setBounds: async (viewKey, bounds) => {
      const result = await ipcRenderer.invoke('owui-set-bounds', { viewKey, bounds });
      if (!result?.success) throw new Error(result?.error || 'Failed to set OWUI bounds');
      return result.state;
    },
    setVisible: async (viewKey, visible) => {
      const result = await ipcRenderer.invoke('owui-set-visible', { viewKey, visible });
      if (!result?.success) throw new Error(result?.error || 'Failed to set OWUI visibility');
      return result.state;
    },
    loadUrl: async (viewKey, url) => {
      const result = await ipcRenderer.invoke('owui-load-url', { viewKey, url });
      if (!result?.success) throw new Error(result?.error || 'Failed to load OWUI URL');
      return result.state;
    },
    reloadView: async (viewKey) => {
      const result = await ipcRenderer.invoke('owui-reload-view', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to reload OWUI view');
      return result.state;
    },
    executeJavaScript: async (viewKey, script) => {
      const result = await ipcRenderer.invoke('owui-execute-javascript', { viewKey, script });
      if (!result?.success) throw new Error(result?.error || 'Failed to execute script in OWUI view');
      return result.result;
    },
    insertCss: async (viewKey, css) => {
      const result = await ipcRenderer.invoke('owui-insert-css', { viewKey, css });
      if (!result?.success) throw new Error(result?.error || 'Failed to insert CSS in OWUI view');
      return result.key;
    },
    sendArtifactsUpdate: async (viewKey, detail) => {
      const result = await ipcRenderer.invoke('owui-send-artifacts-update', { viewKey, detail });
      if (!result?.success) throw new Error(result?.error || 'Failed to send OWUI artifacts update');
      return result.state;
    },
    broadcastOwnerEvent: async (channel, payload) => {
      const result = await ipcRenderer.invoke('owui-broadcast-owner-event', { channel, payload });
      if (!result?.success) throw new Error(result?.error || 'Failed to broadcast owner event to OWUI views');
      return true;
    },
    setDebugMode: async (enabled) => {
      const result = await ipcRenderer.invoke('owui-set-debug-mode', enabled);
      if (!result?.success) throw new Error(result?.error || 'Failed to set OWUI debug mode');
      return Boolean(result.enabled);
    },
    getDebugMode: async () => {
      const result = await ipcRenderer.invoke('owui-get-debug-mode');
      if (!result?.success) throw new Error(result?.error || 'Failed to get OWUI debug mode');
      return Boolean(result.enabled);
    },
    setTheme: async (viewKey, theme) => {
      const result = await ipcRenderer.invoke('owui-set-theme', { viewKey, theme });
      if (!result?.success) throw new Error(result?.error || 'Failed to set OWUI theme');
      return result.state;
    },
    getViewState: async (viewKey) => {
      const result = await ipcRenderer.invoke('owui-get-view-state', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to get OWUI view state');
      return result.state;
    },
    listViews: async () => {
      const result = await ipcRenderer.invoke('owui-list-views');
      if (!result?.success) throw new Error(result?.error || 'Failed to list OWUI views');
      return result.views;
    },
    focusView: async (viewKey) => {
      const result = await ipcRenderer.invoke('owui-focus-view', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to focus OWUI view');
      return result.state;
    },
    capturePage: async (viewKey) => {
      const result = await ipcRenderer.invoke('owui-capture-page', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to capture OWUI page');
      return result.png;
    },
    sendInputEvent: async (viewKey, input) => {
      const result = await ipcRenderer.invoke('owui-send-input-event', { viewKey, input });
      if (!result?.success) throw new Error(result?.error || 'Failed to send OWUI input event');
      return result.state;
    },
    onEvent: (callback) => {
      ipcRenderer.on('owui-event', (_event, payload) => callback(payload));
    },
  },
  artifactView: {
    createOrAdoptView: async (options) => {
      const result = await ipcRenderer.invoke('artifact-view-create-or-adopt-view', options);
      if (!result?.success) throw new Error(result?.error || 'Failed to create artifact view');
      return result.state;
    },
    destroyView: async (viewKey) => {
      const result = await ipcRenderer.invoke('artifact-view-destroy-view', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to destroy artifact view');
      return result.destroyed;
    },
    setBounds: async (viewKey, bounds) => {
      const result = await ipcRenderer.invoke('artifact-view-set-bounds', { viewKey, bounds });
      if (!result?.success) throw new Error(result?.error || 'Failed to set artifact bounds');
      return result.state;
    },
    setVisible: async (viewKey, visible) => {
      const result = await ipcRenderer.invoke('artifact-view-set-visible', { viewKey, visible });
      if (!result?.success) throw new Error(result?.error || 'Failed to set artifact visibility');
      return result.state;
    },
    loadUrl: async (viewKey, url, options = {}) => {
      const result = await ipcRenderer.invoke('artifact-view-load-url', { viewKey, url, options });
      if (!result?.success) throw new Error(result?.error || 'Failed to load artifact URL');
      return result.state;
    },
    reloadView: async (viewKey) => {
      const result = await ipcRenderer.invoke('artifact-view-reload-view', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to reload artifact view');
      return result.state;
    },
    getViewState: async (viewKey) => {
      const result = await ipcRenderer.invoke('artifact-view-get-view-state', viewKey);
      if (!result?.success) throw new Error(result?.error || 'Failed to get artifact view state');
      return result.state;
    },
    listViews: async () => {
      const result = await ipcRenderer.invoke('artifact-view-list-views');
      if (!result?.success) throw new Error(result?.error || 'Failed to list artifact views');
      return result.views;
    },
    onEvent: (callback) => {
      ipcRenderer.on('artifact-view-event', (_event, payload) => callback(payload));
    },
  },

  // Guided-setup specific operations
  maximizeElectronApp: (options) => ipcRenderer.send('maximize-electron-app', options),
  restoreGuidedSetupWindow: () => ipcRenderer.send('restore-guided-setup-window'),
  electronAppComplete: () => ipcRenderer.send('electron-app-complete'),
  setupAuth: {
    start: () => ipcRenderer.invoke('setup-auth-start'),
    status: () => ipcRenderer.invoke('setup-auth-status'),
    clearError: () => ipcRenderer.invoke('setup-auth-clear-error'),
    getCachedSessionSummary: () => ipcRenderer.invoke('setup-auth-cached-session'),
  },
  currentUser: {
    get: () => ipcRenderer.invoke('current-user-get'),
    ensureAuthenticated: () => ipcRenderer.invoke('current-user-ensure-authenticated'),
    repairIdentity: () => ipcRenderer.invoke('current-user-repair-identity'),
    status: () => ipcRenderer.invoke('current-user-status'),
    clearError: () => ipcRenderer.invoke('current-user-clear-error'),
  },
  gitlabMarketplaceAuth: {
    status: (host) => ipcRenderer.invoke('gitlab-marketplace-auth-status', host),
    ensureAuthenticated: (host) =>
      ipcRenderer.invoke('gitlab-marketplace-auth-ensure-authenticated', host),
    clearError: (host) => ipcRenderer.invoke('gitlab-marketplace-auth-clear-error', host),
    getCachedSessionSummary: (host) =>
      ipcRenderer.invoke('gitlab-marketplace-auth-cached-session', host),
  },

  // Prerequisites operations (invoke patterns)
  prerequisitesStartBackgroundPrefetch: (options) => ipcRenderer.invoke('prerequisites-start-background-prefetch', options),
  prerequisitesResumeInteractive: (options) => ipcRenderer.invoke('prerequisites-resume-interactive', options),
  prerequisitesRun: (options) => ipcRenderer.invoke('prerequisites-run', options),
  prerequisitesGetStatus: () => ipcRenderer.invoke('prerequisites-get-status'),
  prerequisitesGetDetailedStatus: () => ipcRenderer.invoke('prerequisites-get-detailed-status'),
  prerequisitesCancel: () => ipcRenderer.invoke('prerequisites-cancel'),
  prerequisitesCheckAuthorizeReadiness: () => ipcRenderer.invoke('prerequisites-check-authorize-readiness'),
  prerequisitesCheckFinalizeReadiness: (options) => ipcRenderer.invoke('prerequisites-check-finalize-readiness', options),

  // Prerequisites progress event listeners
  onPrerequisitesStart: (callback) => {
    ipcRenderer.on('prerequisites-start', (event, data) => callback(data));
  },
  onPrerequisitesProgress: (callback) => {
    ipcRenderer.on('prerequisites-progress', (event, data) => callback(data));
  },
  onPrerequisitesPhaseStart: (callback) => {
    ipcRenderer.on('prerequisites-phase-start', (event, data) => callback(data));
  },
  onPrerequisitesPhaseComplete: (callback) => {
    ipcRenderer.on('prerequisites-phase-complete', (event, data) => callback(data));
  },
  onPrerequisitesStepUpdate: (callback) => {
    ipcRenderer.on('prerequisites-step-update', (event, data) => callback(data));
  },
  onPrerequisitesDockerPull: (callback) => {
    ipcRenderer.on('prerequisites-docker-pull', (event, data) => callback(data));
  },
  onPrerequisitesDockerPullStart: (callback) => {
    ipcRenderer.on('prerequisites-docker-pull-start', (event, data) => callback(data));
  },
  onPrerequisitesDockerPullComplete: (callback) => {
    ipcRenderer.on('prerequisites-docker-pull-complete', (event, data) => callback(data));
  },
  onPrerequisitesDockerPullDeferred: (callback) => {
    ipcRenderer.on('prerequisites-docker-pull-deferred', (event, data) => callback(data));
  },
  onPrerequisitesLog: (callback) => {
    ipcRenderer.on('prerequisites-log', (event, data) => callback(data));
  },
  onPrerequisitesWarning: (callback) => {
    ipcRenderer.on('prerequisites-warning', (event, data) => callback(data));
  },
  onPrerequisitesBlockingReady: (callback) => {
    ipcRenderer.on('prerequisites-blocking-ready', (event, data) => callback(data));
  },
  onPrerequisitesRetry: (callback) => {
    ipcRenderer.on('prerequisites-retry', (event, data) => callback(data));
  },
  onPrerequisitesHostMode: (callback) => {
    ipcRenderer.on('prerequisites-host-mode', (event, data) => callback(data));
  },
  onPrerequisitesComplete: (callback) => {
    ipcRenderer.on('prerequisites-complete', (event, data) => callback(data));
  },
  onPrerequisitesError: (callback) => {
    ipcRenderer.on('prerequisites-error', (event, data) => callback(data));
  },

  // Cleanup helper to remove all prerequisites listeners at once
  removePrerequisitesListeners: () => {
    const channels = [
      'prerequisites-start',
      'prerequisites-progress',
      'prerequisites-phase-start',
      'prerequisites-phase-complete',
      'prerequisites-step-update',
      'prerequisites-docker-pull',
      'prerequisites-docker-pull-start',
      'prerequisites-docker-pull-complete',
      'prerequisites-docker-pull-deferred',
      'prerequisites-log',
      'prerequisites-warning',
      'prerequisites-blocking-ready',
      'prerequisites-retry',
      'prerequisites-host-mode',
      'prerequisites-complete',
      'prerequisites-error'
    ];
    channels.forEach(channel => ipcRenderer.removeAllListeners(channel));
  },

  // Single MCP server operations (for setup wizard testing)
  startSingleMcpServer: (serverId, options) => ipcRenderer.invoke('start-single-mcp-server', serverId, options),
  stopSingleMcpServer: (serverId, options = {}) => ipcRenderer.invoke('stop-single-mcp-server', serverId, options),
  checkSingleMcpServer: (serverId, options = {}) => ipcRenderer.invoke('check-single-mcp-server', serverId, options),
  getSingleMcpServerLogs: (serverId, lines = 100, options = {}) => ipcRenderer.invoke('get-single-mcp-server-logs', serverId, lines, options),
  getWizardMcpServerLogs: (serverId, lines = 100, options = {}) => ipcRenderer.invoke('get-single-mcp-server-logs', serverId, lines, { ...options, preferSingleServer: true }),
  getSingleMcpServerBaseUrl: (options = {}) => ipcRenderer.invoke('get-single-mcp-server-base-url', options),

  // Welcome screen
  continueFromWelcome: () => ipcRenderer.invoke('continue-from-welcome'),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  
  // Event listeners
  onDockerStatusUpdate: (callback) => {
    ipcRenderer.on('docker-status-update', (event, status) => callback(status));
  },
  onShowConfig: (callback) => {
    ipcRenderer.on('show-config', () => callback());
  },
  onLogOutput: (callback) => {
    ipcRenderer.on('log-output', (event, data) => callback(data));
  },
  onLogComplete: (callback) => {
    ipcRenderer.on('log-complete', (event, data) => callback(data));
  },
  
  // Loading screen specific events
  onLoadingLog: (callback) => {
    ipcRenderer.on('loading-log', (event, data) => callback(data));
  },
  onLoadingLogAppend: (callback) => {
    ipcRenderer.on('loading-log-append', (event, data) => callback(data));
  },
  onLoadingStatus: (callback) => {
    ipcRenderer.on('loading-status', (event, message) => callback(message));
  },
  onLoadingProgress: (callback) => {
    ipcRenderer.on('loading-progress', (event, percent) => callback(percent));
  },
  onLoadingStep: (callback) => {
    ipcRenderer.on('loading-step', (event, stepId) => callback(stepId));
  },
  onLoadingStepComplete: (callback) => {
    ipcRenderer.on('loading-step-complete', (event, stepId) => callback(stepId));
  },
  onLoadingStepSkipped: (callback) => {
    ipcRenderer.on('loading-step-skipped', (event, stepId) => callback(stepId));
  },
  onLoadingStepFailed: (callback) => {
    ipcRenderer.on('loading-step-failed', (event, stepId) => callback(stepId));
  },
  onLoadingComplete: (callback) => {
    ipcRenderer.on('loading-complete', () => callback());
  },
  onLoadingError: (callback) => {
    ipcRenderer.on('loading-error', (event, message) => callback(message));
  },
  onStartInitializationForRestart: (callback) => {
    ipcRenderer.on('start-initialization-for-restart', () => callback());
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, updateInfo) => callback(updateInfo));
  },
  onMenuUpdateRequested: (callback) => {
    ipcRenderer.on('menu-update-requested', (event, payload) => callback(payload));
  },
  onClearUpdateState: (callback) => {
    ipcRenderer.on('clear-update-state', () => callback());
  },
  onProceedWithInitialization: (callback) => {
    ipcRenderer.on('proceed-with-initialization', () => callback());
  },
  onStoppingServices: (callback) => {
    ipcRenderer.on('stopping-services', () => callback());
  },
  onSetupWizardNeeded: (callback) => {
    ipcRenderer.on('setup-wizard-needed', () => callback());
  },
  onStartUpdate: (callback) => {
    ipcRenderer.on('start-update', (event, updateInfo) => callback(updateInfo));
  },
  onUpdateOutput: (callback) => {
    ipcRenderer.on('update-output', (event, data) => callback(data));
  },
  onUpdateComplete: (callback) => {
    ipcRenderer.on('update-complete', (event, data) => callback(data));
  },
  onUpdatePreparationStatus: (callback) => {
    ipcRenderer.on('update-prep-status', (event, data) => callback(data));
  },
  onUpdatePreparationLog: (callback) => {
    ipcRenderer.on('update-prep-log', (event, data) => callback(data));
  },
  onUpdatePreparationDockerPullStart: (callback) => {
    ipcRenderer.on('update-prep-docker-pull-start', (event, data) => callback(data));
  },
  onUpdatePreparationDockerPull: (callback) => {
    ipcRenderer.on('update-prep-docker-pull', (event, data) => callback(data));
  },
  onUpdatePreparationDockerPullProgress: (callback) => {
    ipcRenderer.on('update-prep-docker-pull-progress', (event, data) => callback(data));
  },
  onUpdatePreparationDockerPullComplete: (callback) => {
    ipcRenderer.on('update-prep-docker-pull-complete', (event, data) => callback(data));
  },
  onUpdatePreparationBuildProgress: (callback) => {
    ipcRenderer.on('update-prep-build-progress', (event, data) => callback(data));
  },
  removeUpdatePreparationListeners: () => {
    const channels = [
      'update-prep-status',
      'update-prep-log',
      'update-prep-docker-pull-start',
      'update-prep-docker-pull',
      'update-prep-docker-pull-progress',
      'update-prep-docker-pull-complete',
      'update-prep-build-progress'
    ];
    channels.forEach(channel => ipcRenderer.removeAllListeners(channel));
  },
  onOpenConversationTab: (callback) => {
    ipcRenderer.on('open-conversation-tab', (event, url, conversationId, options) =>
      callback(url, conversationId, options),
    );
  },
  onAttachDetachedConversation: (callback) => {
    ipcRenderer.on('attach-detached-conversation', (event, payload) => callback(payload));
  },
  onSwitchToTab: (callback) => {
    ipcRenderer.on('switch-to-tab', (event, tab) => callback(tab));
  },
  showTabContextMenu: (payload) => ipcRenderer.invoke('show-tab-context-menu', payload),
  onTabContextMenuCommand: (callback) => {
    ipcRenderer.on('tab-context-menu-command', (_event, payload) => callback(payload));
  },
  setActiveViewKey: (viewKey) => {
    ipcRenderer.send('set-active-view-key', viewKey);
  },
  onOpenNewChatTab: (callback) => {
    ipcRenderer.on('open-new-chat-tab', (_event, payload) => callback(payload));
  },
  onCloseActiveTab: (callback) => {
    ipcRenderer.on('close-active-tab', () => callback());
  },
  onSwitchToTabIndex: (callback) => {
    ipcRenderer.on('switch-to-tab-index', (event, index) => callback(index));
  },
  onSwitchTabNext: (callback) => {
    ipcRenderer.on('switch-tab-next', () => callback());
  },
  onSwitchTabPrev: (callback) => {
    ipcRenderer.on('switch-tab-prev', () => callback());
  },
  onForceWebviewRecovery: (callback) => {
    ipcRenderer.on('force-webview-recovery', (event, payload) => callback(payload));
  },
  onSystemResume: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('system-resumed', listener);
    return () => ipcRenderer.removeListener('system-resumed', listener);
  },

  // Loading screen actions
  startInitialization: () => ipcRenderer.send('start-initialization'),
  startInitializationWithRetry: () => ipcRenderer.send('start-initialization-with-retry'),
  showMainWindow: (options) => ipcRenderer.send('show-main-window', options || {}),
  launchGuidedSetupFromInit: (context = {}) =>
    ipcRenderer.send('launch-electron-app-from-init', context),
  saveInitLogs: (logs) => ipcRenderer.send('save-init-logs', logs),
  sendInitLog: (message, type) => ipcRenderer.invoke('send-init-log', message, type),

  // OAuth coordination
  getOAuthStatus: () => ipcRenderer.invoke('get-oauth-status'),
  getOAuthCurrent: () => ipcRenderer.invoke('get-oauth-current'),
  getOAuthPending: () => ipcRenderer.invoke('get-oauth-pending'),
  getServerMetadata: (serverId) => ipcRenderer.invoke('get-server-metadata', serverId),
  pollOAuthCompletion: (serverId, timeoutMs) => ipcRenderer.invoke('poll-oauth-completion', serverId, timeoutMs),
  refreshOAuthUrl: (serverId) => ipcRenderer.invoke('refresh-oauth-url', serverId),
  prepareOAuthStart: (serverId) => ipcRenderer.invoke('prepare-oauth-start', serverId),
  clearOAuthTokens: (serverId) => ipcRenderer.invoke('clear-oauth-tokens', serverId),

  // OAuth logging (unified logging across layers)
  logOAuthEvent: (data) => ipcRenderer.invoke('log-oauth-event', data),

  // Single-server OAuth operations (dynamic host port)
  getOAuthStatusSingle: (options = {}) => ipcRenderer.invoke('get-oauth-status-single', options),
  refreshOAuthUrlSingle: (serverId, options = {}) => ipcRenderer.invoke('refresh-oauth-url-single', serverId, options),
  pollOAuthCompletionSingle: (serverId, timeoutMs, options = {}) => ipcRenderer.invoke('poll-oauth-completion-single', serverId, timeoutMs, options),
  checkOAuthTokensExist: (serverId) => ipcRenderer.invoke('check-oauth-tokens-exist', serverId),

  // Health check operations
  rerunHealthCheck: () => ipcRenderer.invoke('rerun-health-check'),
  getHealthStatus: () => ipcRenderer.invoke('get-health-status'),
  startHealthMonitoring: () => ipcRenderer.invoke('start-health-monitoring'),
  stopHealthMonitoring: () => ipcRenderer.invoke('stop-health-monitoring'),
  getLastHealthStatus: () => ipcRenderer.invoke('get-last-health-status'),

  // Main-process API operations avoid coupling privileged actions to renderer
  // origin/CORS behavior.
  apiRestartMcp: () => ipcRenderer.invoke('api-restart-mcp'),
  apiHealthCheck: () => ipcRenderer.invoke('api-health-check'),
  waitForPostOauthServerRecovery: (serverId, options = {}) => ipcRenderer.invoke('wait-post-oauth-server-recovery', serverId, options),
  apiRestartMcpServers: (serverIds, options = {}) => ipcRenderer.invoke('api-restart-mcp-servers', serverIds, options),
  apiRestartAllMcpServers: () => ipcRenderer.invoke('api-restart-all-mcp-servers'),
  resyncMcpServerData: (serverId) => ipcRenderer.invoke('resync-mcp-server-data', serverId),
  deleteUserMcpServer: (serverId) => ipcRenderer.invoke('delete-user-mcp-server', serverId),
  toggleMcpServer: (serverId, enabled, deploymentType, options = {}) => ipcRenderer.invoke('toggle-mcp-server', serverId, enabled, deploymentType, options),
  toggleMcpServersBulk: (serverIds, enabled) => ipcRenderer.invoke('toggle-mcp-servers-bulk', serverIds, enabled),
  startMcpOperation: (request) => ipcRenderer.invoke('start-mcp-operation', request),
  getActiveMcpOperation: () => ipcRenderer.invoke('get-active-mcp-operation'),
  getMcpOperation: (operationId) => ipcRenderer.invoke('get-mcp-operation', operationId),
  onMcpOperationUpdated: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('mcp-operation-updated', listener);
    return () => ipcRenderer.removeListener('mcp-operation-updated', listener);
  },

  // Agent Skills
  getSkills: () => ipcRenderer.invoke('get-skills'),
  listAgentSkillUsage: () => ipcRenderer.invoke('list-agent-skill-usage'),
  listAgentFlags: () => ipcRenderer.invoke('list-agent-flags'),
  getSkillFiles: (skillName, skillPath) => ipcRenderer.invoke('get-skill-files', skillName, skillPath),
  readSkillFile: (filePath) => ipcRenderer.invoke('read-skill-file', filePath),
  writeSkillFile: (filePath, content) => ipcRenderer.invoke('write-skill-file', filePath, content),
  duplicateSkill: (skillPath, preferredName = null, options = {}) =>
    ipcRenderer.invoke('duplicate-skill', {
      skillPath,
      preferredName,
      exact: Boolean(options && options.exact),
    }),
  openSkillFolder: (skillPath) => ipcRenderer.invoke('open-skill-folder', { skillPath }),
  exportSkill: (skillPath) => ipcRenderer.invoke('export-skill', { skillPath }),
  openMcpServerFolder: (serverPath) => ipcRenderer.invoke('open-mcp-server-folder', { serverPath }),
  exportMcpServer: (serverPath) => ipcRenderer.invoke('export-mcp-server', { serverPath }),
  deleteSkill: (skillName, skillPath) => ipcRenderer.invoke('delete-skill', skillName, skillPath),

  // Workspace file operations (for agent VM output files)
  workspaces: {
    revealFile: (chatId, filePath) => ipcRenderer.invoke('reveal-workspace-file', { chatId, filePath }),
    listFiles: (chatId, directory) => ipcRenderer.invoke('list-workspace-files', { chatId, directory }),
    getFileUrl: (chatId, filePath) => ipcRenderer.invoke('get-workspace-file-url', { chatId, filePath }),
  },

  // Artifact operations (for live web app previews)
  artifacts: {
    detach: (artifactId, previewUrl, name, chatId, currentVersion, preferredVersion) =>
      ipcRenderer.invoke('artifact-detach', { artifactId, previewUrl, name, chatId, currentVersion, preferredVersion }),
    attach: (artifactId, chatId = null) => ipcRenderer.invoke('artifact-attach', { artifactId, chatId }),
    getList: (chatId) => ipcRenderer.invoke('artifact-get-list', { chatId }),
    getDetachedWindows: () => ipcRenderer.invoke('artifact-get-detached-windows'),
    switchVersion: (artifactId, version) => ipcRenderer.invoke('artifact-switch-version', { artifactId, version }),
    getRunningVersions: (artifactId) => ipcRenderer.invoke('artifact-get-running-versions', { artifactId }),
    pingServers: (ports) => ipcRenderer.invoke('artifact-ping-servers', { ports }),
    publish: (payload) => ipcRenderer.invoke('artifact-publish', payload),
    openSmart: (artifactId, chatId) => ipcRenderer.invoke('artifact-open-smart', { artifactId, chatId }),
    canAttach: (payload = {}) => ipcRenderer.invoke('artifact-can-attach', payload),
    notifyPanelState: (isOpen, chatId = null, artifactId = null) =>
      ipcRenderer.invoke('artifact-notify-panel-state', { isOpen, chatId, artifactId }),
    retainView: (artifactId, viewKey) => ipcRenderer.invoke('artifact-retain-view', { artifactId, viewKey }),
    releaseView: (artifactId, viewKey) => ipcRenderer.invoke('artifact-release-view', { artifactId, viewKey }),
    refreshRuntime: (payload = {}) => ipcRenderer.invoke('artifact-refresh-runtime', payload),
    closeAllForChat: (chatId) => ipcRenderer.invoke('artifact-close-all-for-chat', { chatId }),
  },
  setArtifactLayoutActive: (payload = {}) => ipcRenderer.invoke('window-set-artifact-layout-active', payload),

  // Artifact event listeners
  onArtifactOpen: (callback) => {
    ipcRenderer.on('artifact-open', (event, data) => callback(data));
  },
  onArtifactClose: (callback) => {
    ipcRenderer.on('artifact-close', (event, data) => callback(data));
  },
  onArtifactVersionChanged: (callback) => {
    ipcRenderer.on('artifact-version-changed', (event, data) => callback(data));
  },
  onArtifactWindowClosed: (callback) => {
    ipcRenderer.on('artifact-window-closed', (event, data) => callback(data));
  },
  onArtifactWindowOpened: (callback) => {
    console.log('[Preload] Registering artifact-window-opened listener');
    ipcRenderer.on('artifact-window-opened', (event, data) => {
      console.log('[Preload] Received artifact-window-opened:', data);
      callback(data);
    });
  },
  onArtifactSmartOpen: (callback) => {
    ipcRenderer.on('artifact-smart-open', (event, data) => callback(data));
  },
  onArtifactSessionVersionSelected: (callback) => {
    ipcRenderer.on('artifact-session-version-selected', (event, data) => callback(data));
  },

  // Marketplaces
  getMarketplaces: () => ipcRenderer.invoke('get-marketplaces'),
  addMarketplace: (source) => ipcRenderer.invoke('add-marketplace', source),
  isMarketplaceSourceAllowed: (sourceInput) => ipcRenderer.invoke('marketplace-source-allowed', sourceInput),
  removeMarketplace: (marketplaceId, removeSkills) => ipcRenderer.invoke('remove-marketplace', marketplaceId, removeSkills),
  syncMarketplace: (marketplaceId) => ipcRenderer.invoke('sync-marketplace', marketplaceId),
  syncAllMarketplaces: () => ipcRenderer.invoke('sync-all-marketplaces'),
  applyMarketplaceSyncRemovals: (marketplaceId, removals) => ipcRenderer.invoke('apply-marketplace-sync-removals', marketplaceId, removals),
  getMarketplaceSkills: (marketplaceId) => ipcRenderer.invoke('get-marketplace-skills', marketplaceId),
  getMarketplaceSkillsCached: (marketplaceId) => ipcRenderer.invoke('get-marketplace-skills-cached', marketplaceId),
  getMarketplaceSkillBundle: (marketplaceId, skillId, pluginName = null) => ipcRenderer.invoke('get-marketplace-skill-bundle', marketplaceId, skillId, pluginName),
  installMarketplaceSkill: (marketplaceId, skillId, skillPath, skillSource, pluginName = null) => ipcRenderer.invoke('install-marketplace-skill', marketplaceId, skillId, skillPath, skillSource, pluginName),
  uninstallMarketplaceSkill: (marketplaceId, skillId, pluginName = null) => ipcRenderer.invoke('uninstall-marketplace-skill', marketplaceId, skillId, pluginName),
  detachMarketplaceSkillToUserSkill: (marketplaceId, skillId, targetSkillName = null, pluginName = null) => ipcRenderer.invoke('detach-marketplace-skill-to-user-skill', marketplaceId, skillId, targetSkillName, pluginName),
  checkSkillUpdates: (options = {}) => ipcRenderer.invoke('check-skill-updates', options),
  updateMarketplaceSkill: (marketplaceId, skillId, options = {}) => ipcRenderer.invoke('update-marketplace-skill', marketplaceId, skillId, options),

  // Cost reporting
  getCostDashboard: (options = {}) => ipcRenderer.invoke('get-cost-dashboard', options),
  revealCostReportingFolder: () => ipcRenderer.invoke('reveal-cost-reporting-folder'),

  // AI Marketplace (shared registry for agents + skills + future mcp-servers)
  aiMarketplace: {
    search: (params) => ipcRenderer.invoke('ai-marketplace-search', params),
    getSolution: (id) => ipcRenderer.invoke('ai-marketplace-get-solution', id),
    getBundle: (id) => ipcRenderer.invoke('ai-marketplace-get-bundle', id),
    listPublished: (type = null) =>
      ipcRenderer.invoke('ai-marketplace-list-published', type),
    install: (id, options = {}) => ipcRenderer.invoke('ai-marketplace-install', id, options),
    onInstallProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('ai-marketplace-install-progress', listener);
      return () => ipcRenderer.removeListener('ai-marketplace-install-progress', listener);
    },
    publish: (solutionInput, options = {}) =>
      ipcRenderer.invoke('ai-marketplace-publish', solutionInput, options),
    update: (id, patch, options = {}) =>
      ipcRenderer.invoke('ai-marketplace-update', id, patch, options),
    syncSolutionAcl: (id, options = {}) =>
      ipcRenderer.invoke('ai-marketplace-sync-solution-acl', id, options),
    preflightPublishListings: (payload = {}) =>
      ipcRenderer.invoke('ai-marketplace-preflight-publish-listings', payload),
    probeInstallRefs: (payload = {}) =>
      ipcRenderer.invoke('ai-marketplace-probe-install-refs', payload),
    delete: (id) => ipcRenderer.invoke('ai-marketplace-delete', id),
    buildPublishBundle: (args) => ipcRenderer.invoke('ai-marketplace-build-publish-bundle', args),
    hasApiKey: () => ipcRenderer.invoke('ai-marketplace-has-api-key'),
    setApiKey: (value) => ipcRenderer.invoke('ai-marketplace-set-api-key', value),
    clearApiKey: () => ipcRenderer.invoke('ai-marketplace-clear-api-key'),
    getBaseUrl: () => ipcRenderer.invoke('ai-marketplace-base-url'),
    listLinks: () => ipcRenderer.invoke('ai-marketplace-link-list'),
    getLink: (localAgentId) => ipcRenderer.invoke('ai-marketplace-link-get', localAgentId),
    clearLink: (localAgentId) => ipcRenderer.invoke('ai-marketplace-link-clear', localAgentId),
    reportLinkSightings: (sightings) =>
      ipcRenderer.invoke('ai-marketplace-link-report-sightings', sightings),
    markLinkDirty: (localAgentId) =>
      ipcRenderer.invoke('ai-marketplace-link-mark-dirty', localAgentId),
    setLinkRemoteUpdatedAt: (localAgentId, remoteUpdatedAt) =>
      ipcRenderer.invoke(
        'ai-marketplace-link-set-remote-updated-at',
        localAgentId,
        remoteUpdatedAt,
      ),
    reclaimAgent: (localAgentId) =>
      ipcRenderer.invoke('ai-marketplace-reclaim-agent', localAgentId),
    reclaimSkill: (localSkillId) =>
      ipcRenderer.invoke('ai-marketplace-reclaim-skill', localSkillId),
    repairLinkedAgentAccess: (options = {}) =>
      ipcRenderer.invoke('ai-marketplace-repair-linked-agent-access', options),
    getSkillLink: (localSkillName) =>
      ipcRenderer.invoke('ai-marketplace-skill-link-get', localSkillName),
    getInstalledSkillSource: (localSkillName) =>
      ipcRenderer.invoke('ai-marketplace-installed-skill-source-get', localSkillName),
    setSkillLink: (localSkillName, solutionId) =>
      ipcRenderer.invoke('ai-marketplace-skill-link-set', localSkillName, solutionId),
    clearSkillLink: (localSkillName) =>
      ipcRenderer.invoke('ai-marketplace-skill-link-clear', localSkillName),
    listSkillLinks: () => ipcRenderer.invoke('ai-marketplace-skill-link-list'),
    markSkillLinkDirty: (localSkillName) =>
      ipcRenderer.invoke('ai-marketplace-skill-link-mark-dirty', localSkillName),
  },

  // Health status events
  onHealthStatusUpdate: (callback) => {
    ipcRenderer.on('health-status-update', (event, data) => callback(data));
  },
  onServerLifecycleTransition: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('server-lifecycle-transition', listener);
    return () => ipcRenderer.removeListener('server-lifecycle-transition', listener);
  },
  getServerLifecycle: (serverId) => ipcRenderer.invoke('get-server-lifecycle', serverId),
  onCostReportUpdated: (callback) => {
    ipcRenderer.on('cost-report-updated', (event, data) => callback(data));
  },
  onDbCorruptionDetected: (callback) => {
    ipcRenderer.on('db-corruption-detected', (event, data) => callback(data));
  },

  // MCP restart events (for agent-initiated restarts)
  onMcpRestartStarted: (callback) => {
    ipcRenderer.on('mcp-restart-started', () => callback());
  },
  onMcpRestartComplete: (callback) => {
    ipcRenderer.on('mcp-restart-complete', (event, data) => callback(data));
  },
  onMcpServerToggled: (callback) => {
    ipcRenderer.on('mcp-server-toggled', (event, data) => callback(data));
  },
  onMcpDisableModesChanged: (callback) => {
    ipcRenderer.on('mcp-disable-modes-changed', (event, data) => callback(data));
  },
  // A marketplace publish/republish/unpublish succeeded — visible control-plane
  // views should refresh their publish-state badges.
  onMarketplaceLinksChanged: (callback) => {
    ipcRenderer.on('marketplace-links-changed', (event, data) => callback(data));
  },

  // OAuth flow events (for LLM-triggered OAuth)
  onOAuthFlowRequested: (callback) => {
    ipcRenderer.on('oauth-flow-requested', (event, data) => callback(data));
  },
  onOAuthFlowCompleted: (callback) => {
    ipcRenderer.on('oauth-flow-completed', (event, data) => callback(data));
  },
  notifyOAuthDismissed: (serverId) => ipcRenderer.send('oauth-flow-dismissed', serverId),
  notifyOAuthServerDone: (serverId) => ipcRenderer.send('oauth-flow-server-done', serverId),
  notifyOAuthContractorDenied: (serverId) => ipcRenderer.send('oauth-flow-contractor-denied', serverId),
  notifyOAuthContractorAcknowledged: (serverId) => ipcRenderer.send('oauth-flow-contractor-acknowledged', serverId),

  // Guided setup events (for LLM-triggered server configuration)
  onGuidedSetupRequested: (callback) => {
    ipcRenderer.on('guided-setup-requested', (event, data) => callback(data));
  },
  notifyGuidedSetupCompleted: (
    serverId,
    outcomeOrSuccess,
    flowId = null,
    details = {},
  ) => {
    const outcome =
      typeof outcomeOrSuccess === 'string'
        ? outcomeOrSuccess
        : outcomeOrSuccess === true
          ? 'completed'
          : 'dismissed';
    ipcRenderer.send('guided-setup-completed', {
      server_id: serverId,
      outcome,
      success: outcome === 'completed',
      flow_id: flowId,
      details,
    });
  },

  // User question events (for backend-requested user decisions)
  onUserQuestionRequested: (callback) => {
    ipcRenderer.on('user-question-requested', (_event, data) => callback(data));
  },

  // Shared presentation events for blocking native input modals.
  onNativeInputReopenRequested: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('native-input-reopen-requested', listener);
    return () => ipcRenderer.removeListener('native-input-reopen-requested', listener);
  },
  onNativeInputTerminal: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('native-input-terminal', listener);
    return () => ipcRenderer.removeListener('native-input-terminal', listener);
  },
  setNativeInputPresentation: (payload) =>
    ipcRenderer.invoke('native-input-set-presentation', payload),

  // Sensitive information events (for backend-requested masked input)
  onSensitiveInfoRequested: (callback) => {
    ipcRenderer.on('sensitive-info-requested', (_event, data) => callback(data));
  },
  notifySensitiveInfoCompleted: (payload) => ipcRenderer.send('sensitive-info-completed', payload),

  // Chat workspace consent events (for Agent VM workspace changes)
  onChatWorkspaceConsentRequested: (callback) => {
    ipcRenderer.on('chat-workspace-consent-requested', (_event, data) => callback(data));
  },
  notifyChatWorkspaceConsentCompleted: (payload) =>
    ipcRenderer.send('chat-workspace-consent-completed', payload),
  openChatWorkspaceConsentPath: (payload) =>
    ipcRenderer.invoke('chat-workspace-consent-open-path', payload),
  onAiMarketplacePublishConfirmRequested: (callback) => {
    ipcRenderer.on('ai-marketplace-publish-confirm-requested', (_event, data) => callback(data));
  },
  notifyAiMarketplacePublishConfirmCompleted: (payload) =>
    ipcRenderer.send('ai-marketplace-publish-confirm-completed', payload),
  // Flow-keyed outcome of an approved marketplace write (the batch modal
  // holds main-side items busy until this arrives).
  onAiMarketplacePublishOutcome: (callback) => {
    ipcRenderer.on('ai-marketplace-publish-outcome', (_event, data) => callback(data));
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // Theme synchronization across windows
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
  },
  onWindowFullscreenChanged: (callback) => {
    ipcRenderer.on('window-fullscreen-changed', (_event, isFullscreen) =>
      callback(Boolean(isFullscreen)));
  },

  konami: {
    getState: (options = {}) => ipcRenderer.invoke('konami-get-state', options),
    unlock: (options = {}) => ipcRenderer.invoke('konami-unlock', options),
    onChanged: (callback) => {
      ipcRenderer.on('konami-unlock-changed', (_event, payload) => callback(payload));
    },
  },

  // Find-in-page
  focusRenderer: () => ipcRenderer.invoke('focus-renderer'),
  owuiFindInPage: (text, options) => ipcRenderer.invoke('owui-find-in-page', text, options),
  owuiStopFindInPage: (action) => ipcRenderer.invoke('owui-stop-find-in-page', action),
  setupFindInPageForwarding: () => ipcRenderer.invoke('owui-setup-find-forwarding'),
  onFindInPageResult: (callback) => {
    ipcRenderer.on('found-in-page-result', (_event, result) => callback(result));
  },
  onFindInPageOpen: (callback) => {
    ipcRenderer.on('find-in-page-open', () => callback());
  },
  onFindInPageNext: (callback) => {
    ipcRenderer.on('find-in-page-next', () => callback());
  },
  onFindInPagePrev: (callback) => {
    ipcRenderer.on('find-in-page-prev', () => callback());
  },

  // Multi-window awareness
  getOpenConversationTabs: () => ipcRenderer.invoke('get-open-conversation-tabs'),
  notifyChatStatus: (payload) =>
    ipcRenderer.invoke('show-chat-native-notification', payload),
  // Generic native notification (title + body). In-app DOM toasts are
  // retired; the renderer's global showNotification forwards here.
  showNativeNotification: (payload) =>
    ipcRenderer.invoke('show-native-notification', payload),
  // Platform info
  platform: process.platform,
  nativeSidebarVibrancy: process.argv.includes('--portico-native-sidebar-vibrancy')
});
