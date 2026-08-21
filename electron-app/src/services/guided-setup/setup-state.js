// Setup state management for guided setup wizard
// Extracted from guided-setup.js

// State management object
const setupState = {
  currentStage: 'welcome',
  onboardingMode: null,
  savedOnboardingMode: null,
  serverSelectionHydrated: false,
  selectedServers: [],
  mcpToggleState: {
    baseline: {
      loaded: false,
      exists: false,
      contentHash: null,
      parseError: null,
      toggles: {},
    },
    changes: {},
    writeMode: 'preserve'
  },
  serverConfigs: [],
  currentServerIndex: 0,
  envVars: {},
  mcpServers: [],
  browserVisible: false,
  hostModeSupported: true, // Track if HOST mode dependencies are installed
  skipPrerequisites: false,
  launchContext: {
    source: 'unknown',
    trigger: 'unknown',
    startedAt: 0,
    setupMode: null,
    setupReason: null,
    setupRequirementId: null,
    safeErrorCode: null,
    setupOperationId: null,
    seedDefaults: false
  },
  prereqReadiness: {
    readyForAuth: false,
    reason: 'unknown',
    missingImages: []
  },
  prereqPolicy: {
    showStep: true,
    noInteractiveWorkRequired: false,
    reason: 'unknown'
  },
  prerequisitesManualVisit: false,
  completedSteps: {
    prerequisites: false,
    prerequisitesWarning: false,
    serverSelection: false,
    oauth: false,
    servers: {}
  },
  configuredServers: new Set(), // Track which servers are configured
  preConfiguredServers: new Set(), // Track servers configured before this setup run
  skippedServers: new Set(), // Track which servers were skipped
  guidedSetupDisabledServerIds: new Set(), // Servers visible in guided setup but intentionally disabled
  guidedSetupDisabledTooltips: {}, // Tooltip copy for guided-setup-disabled servers
  // OAuth flow tracking
  oauthServers: [], // List of servers needing OAuth (from selection)
  oauthStepRequired: null,
  completedOAuthServers: new Set(), // Servers that completed OAuth successfully
  connectedOAuthServers: new Set(), // Servers authorized during this setup run
  skippedOAuthServers: new Set(), // Servers where OAuth was skipped
  currentOAuthIndex: 0, // Current server index in OAuth flow
  pendingOAuthConfigurationServerId: null // Dual-requirement server awaiting config before OAuth
};

// Get current stage
function getCurrentStage() {
  return setupState.currentStage;
}

function getOnboardingMode() {
  return setupState.onboardingMode;
}

function setOnboardingMode(mode) {
  setupState.onboardingMode = mode;
}

// Set current stage
function setCurrentStage(stage) {
  setupState.currentStage = stage;
}

// Get selected servers
function getSelectedServers() {
  return setupState.selectedServers;
}

// Set selected servers
function setSelectedServers(servers) {
  setupState.selectedServers = servers;
}

// Add server to selected
function addSelectedServer(index) {
  if (!setupState.selectedServers.includes(index)) {
    setupState.selectedServers.push(index);
  }
}

// Remove server from selected
function removeSelectedServer(index) {
  setupState.selectedServers = setupState.selectedServers.filter(i => i !== index);
}

// Get server configs
function getServerConfigs() {
  return setupState.serverConfigs;
}

// Set server configs
function setServerConfigs(configs) {
  setupState.serverConfigs = configs;
}

// Get current server index
function getCurrentServerIndex() {
  return setupState.currentServerIndex;
}

// Set current server index
function setCurrentServerIndex(index) {
  setupState.currentServerIndex = index;
}

// Get env vars
function getEnvVars() {
  return setupState.envVars;
}

// Get single env var
function getEnvVar(key) {
  return setupState.envVars[key];
}

// Set env var
function setEnvVar(key, value) {
  setupState.envVars[key] = value;
}

// Get MCP servers
function getMcpServers() {
  return setupState.mcpServers;
}

// Set MCP servers
function setMcpServers(servers) {
  setupState.mcpServers = servers;
}

// Get browser visibility
function isBrowserVisible() {
  return setupState.browserVisible;
}

// Set browser visibility
function setBrowserVisible(visible) {
  setupState.browserVisible = visible;
}

// Get host mode support
function isHostModeSupported() {
  return setupState.hostModeSupported;
}

// Set host mode support
function setHostModeSupported(supported) {
  setupState.hostModeSupported = supported;
}

// Get completed steps
function getCompletedSteps() {
  return setupState.completedSteps;
}

// Mark prerequisites step as completed
function markPrerequisitesCompleted(completed = true) {
  setupState.completedSteps.prerequisites = completed;
}

// Mark server selection step as completed
function markServerSelectionCompleted(completed = true) {
  setupState.completedSteps.serverSelection = completed;
}

// Mark server as completed
function markServerCompleted(serverId) {
  setupState.completedSteps.servers[serverId] = true;
}

// Get configured servers
function getConfiguredServers() {
  return setupState.configuredServers;
}

// Add to configured servers
function addConfiguredServer(serverId) {
  setupState.configuredServers.add(serverId);
}

// Remove from configured servers
function removeConfiguredServer(serverId) {
  setupState.configuredServers.delete(serverId);
}

// Check if server is configured
function hasConfiguredServer(serverId) {
  return setupState.configuredServers.has(serverId);
}

// Get skipped servers
function getSkippedServers() {
  return setupState.skippedServers;
}

// Add to skipped servers
function addSkippedServer(serverId) {
  setupState.skippedServers.add(serverId);
}

// Remove from skipped servers
function removeSkippedServer(serverId) {
  setupState.skippedServers.delete(serverId);
}

// Check if server is skipped
function hasSkippedServer(serverId) {
  return setupState.skippedServers.has(serverId);
}

// Clear configured and skipped servers
function clearServerTracking() {
  setupState.configuredServers.clear();
  setupState.preConfiguredServers.clear();
  setupState.skippedServers.clear();
}

// OAuth-related functions

// Get OAuth servers
function getOAuthServers() {
  return setupState.oauthServers;
}

// Set OAuth servers
function setOAuthServers(servers) {
  setupState.oauthServers = servers;
}

// Get current OAuth index
function getCurrentOAuthIndex() {
  return setupState.currentOAuthIndex;
}

// Set current OAuth index
function setCurrentOAuthIndex(index) {
  setupState.currentOAuthIndex = index;
}

// Get completed OAuth servers
function getCompletedOAuthServers() {
  return setupState.completedOAuthServers;
}

// Add to completed OAuth servers
function addCompletedOAuthServer(serverId) {
  setupState.completedOAuthServers.add(serverId);
}

// Check if OAuth server is completed
function hasCompletedOAuthServer(serverId) {
  return setupState.completedOAuthServers.has(serverId);
}

// Get skipped OAuth servers
function getSkippedOAuthServers() {
  return setupState.skippedOAuthServers;
}

// Get OAuth servers connected during this setup flow
function getConnectedOAuthServers() {
  return setupState.connectedOAuthServers;
}

// Add to connected OAuth servers
function addConnectedOAuthServer(serverId) {
  setupState.connectedOAuthServers.add(serverId);
}

// Check if OAuth server was connected during this setup flow
function hasConnectedOAuthServer(serverId) {
  return setupState.connectedOAuthServers.has(serverId);
}

// Add to skipped OAuth servers
function addSkippedOAuthServer(serverId) {
  setupState.skippedOAuthServers.add(serverId);
}

// Check if OAuth server is skipped
function hasSkippedOAuthServer(serverId) {
  return setupState.skippedOAuthServers.has(serverId);
}

// Mark OAuth step as completed
function markOAuthCompleted(completed = true) {
  setupState.completedSteps.oauth = completed;
}

// Clear OAuth tracking
function clearOAuthTracking() {
  setupState.oauthServers = [];
  setupState.oauthStepRequired = null;
  setupState.completedOAuthServers.clear();
  setupState.connectedOAuthServers.clear();
  setupState.skippedOAuthServers.clear();
  setupState.currentOAuthIndex = 0;
}

// Reset state to initial values
function resetState() {
  setupState.currentStage = 'welcome';
  setupState.onboardingMode = null;
  setupState.savedOnboardingMode = null;
  setupState.serverSelectionHydrated = false;
  setupState.selectedServers = [];
  setupState.mcpToggleState = {
    baseline: {
      loaded: false,
      exists: false,
      contentHash: null,
      parseError: null,
      toggles: {},
    },
    changes: {},
    writeMode: 'preserve'
  };
  setupState.serverConfigs = [];
  setupState.currentServerIndex = 0;
  setupState.browserVisible = false;
  setupState.skipPrerequisites = false;
  setupState.launchContext = {
    source: 'unknown',
    trigger: 'unknown',
    startedAt: 0,
    setupMode: null,
    setupReason: null,
    setupRequirementId: null,
    safeErrorCode: null,
    setupOperationId: null,
    seedDefaults: false
  };
  setupState.prereqReadiness = {
    readyForAuth: false,
    reason: 'unknown',
    missingImages: []
  };
  setupState.prereqPolicy = {
    showStep: true,
    noInteractiveWorkRequired: false,
    reason: 'unknown'
  };
  setupState.prerequisitesManualVisit = false;
  setupState.completedSteps = {
    prerequisites: false,
    prerequisitesWarning: false,
    serverSelection: false,
    oauth: false,
    servers: {}
  };
  setupState.configuredServers.clear();
  setupState.preConfiguredServers.clear();
  setupState.skippedServers.clear();
  setupState.guidedSetupDisabledServerIds.clear();
  setupState.guidedSetupDisabledTooltips = {};
  // Reset OAuth state
  setupState.oauthServers = [];
  setupState.oauthStepRequired = null;
  setupState.completedOAuthServers.clear();
  setupState.connectedOAuthServers.clear();
  setupState.skippedOAuthServers.clear();
  setupState.currentOAuthIndex = 0;
}

// Export state and functions
module.exports = {
  setupState,
  getCurrentStage,
  getOnboardingMode,
  setCurrentStage,
  setOnboardingMode,
  getSelectedServers,
  setSelectedServers,
  addSelectedServer,
  removeSelectedServer,
  getServerConfigs,
  setServerConfigs,
  getCurrentServerIndex,
  setCurrentServerIndex,
  getEnvVars,
  getEnvVar,
  setEnvVar,
  getMcpServers,
  setMcpServers,
  isBrowserVisible,
  setBrowserVisible,
  isHostModeSupported,
  setHostModeSupported,
  getCompletedSteps,
  markPrerequisitesCompleted,
  markServerSelectionCompleted,
  markServerCompleted,
  getConfiguredServers,
  addConfiguredServer,
  removeConfiguredServer,
  hasConfiguredServer,
  getSkippedServers,
  addSkippedServer,
  removeSkippedServer,
  hasSkippedServer,
  clearServerTracking,
  resetState,
  // OAuth exports
  getOAuthServers,
  setOAuthServers,
  getCurrentOAuthIndex,
  setCurrentOAuthIndex,
  getCompletedOAuthServers,
  addCompletedOAuthServer,
  hasCompletedOAuthServer,
  getConnectedOAuthServers,
  addConnectedOAuthServer,
  hasConnectedOAuthServer,
  getSkippedOAuthServers,
  addSkippedOAuthServer,
  hasSkippedOAuthServer,
  markOAuthCompleted,
  clearOAuthTracking
};
