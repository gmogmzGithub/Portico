// Server Selection screen module for guided setup
// Displays unified server grid (single view) and handles selection

const {
  getGuidedSetupDisabledTooltip,
  isGuidedSetupDisabledServer,
  isGuidedSetupSelectableServer,
  isGuidedSetupVisibleServer,
  preserveGuidedSetupToggleState,
  recordGuidedSetupToggleChange,
} = require('../../../services/guided-setup/server-selection-state');
const {
  getGuidedSetupRequirements,
  serverRequiresConfig,
  serverRequiresOAuth,
} = require('../../../services/guided-setup/server-requirements');

// Helper to check if server is user-installed
function isUserInstalled(server) {
  return server.userInstalled === true;
}

// Helper to check if server is core
function serverIsCore(server) {
  return server.isCore === true;
}

// Get server category for sorting (lower number = higher priority in display)
// Order: OAuth first (1), then Config (2), then non-core (3), then core (4)
function getServerCategory(server) {
  const { requiresOAuth, requiresConfig } = getGuidedSetupRequirements(server);
  const isCore = serverIsCore(server);

  if (requiresOAuth) return 1;  // OAuth servers first
  if (requiresConfig) return 2;  // Config-required servers second
  if (!isCore) return 3;        // Non-core servers third
  return 4;                      // Core servers last
}

function getGuidedSetupSelectionOptions(setupState = {}) {
  return {
    hostModeSupported: setupState.hostModeSupported,
    guidedSetupDisabledServerIds: setupState.guidedSetupDisabledServerIds,
    guidedSetupDisabledTooltips: setupState.guidedSetupDisabledTooltips,
  };
}

// Populate server selection grid (single unified view)
function populateServerGrid(setupState, callbacks = {}) {
  const serverGrid = document.getElementById('all-server-grid');

  if (!serverGrid) return;

  // Clear grid
  serverGrid.innerHTML = '';
  if (Array.isArray(serverGrid.children)) {
    serverGrid.children = [];
  }

  // Add HOST warning message if HOST mode is not supported
  if (!setupState.hostModeSupported) {
    const subtitle = document.querySelector('#stage-server-selection .subtitle');
    if (subtitle && !document.getElementById('host-warning-message')) {
      if (callbacks.createHostWarning) {
        const warningDiv = callbacks.createHostWarning();
        subtitle.parentNode.insertBefore(warningDiv, subtitle.nextSibling);
      }
    }
  } else {
    const existingWarning = document.getElementById('host-warning-message');
    if (existingWarning) existingWarning.remove();
  }

  // Filter and collect eligible servers
  const eligibleServers = [];
  const selectionOptions = getGuidedSetupSelectionOptions(setupState);

  setupState.mcpServers.forEach((server, originalIndex) => {
    if (!isGuidedSetupVisibleServer(server, selectionOptions)) {
      return;
    }

    eligibleServers.push({ server, originalIndex });
  });

  // Sort by category first, then alphabetically within each category
  eligibleServers.sort((a, b) => {
    const catA = getServerCategory(a.server);
    const catB = getServerCategory(b.server);

    // Sort by category first
    if (catA !== catB) {
      return catA - catB;
    }

    // Within same category, sort alphabetically
    const nameA = a.server.display_name || a.server.name;
    const nameB = b.server.display_name || b.server.name;
    return nameA.localeCompare(nameB);
  });

  const fragment = typeof document.createDocumentFragment === 'function'
    ? document.createDocumentFragment()
    : null;

  // Render all servers in single grid
  eligibleServers.forEach(({ server, originalIndex }) => {
    const isConfigured = callbacks.isServerConfigured ? callbacks.isServerConfigured(server) : false;
    const guidedSetupDisabled = isGuidedSetupDisabledServer(server, selectionOptions);
    const guidedSetupDisabledTooltip = getGuidedSetupDisabledTooltip(server, selectionOptions);
    const card = callbacks.createServerCard
      ? callbacks.createServerCard(server, originalIndex, isConfigured, setupState.hostModeSupported, {
        guidedSetupDisabled,
        guidedSetupDisabledTooltip,
      })
      : createBasicCard(server, originalIndex);
    const hasRequiredVars = serverRequiresConfig(server);

    if (setupState.selectedServers.includes(originalIndex)) {
      applySelectedCardState(card, {
        configured: isConfigured && hasRequiredVars,
      });
    }

    if (guidedSetupDisabledTooltip) {
      card.dataset.tooltip = guidedSetupDisabledTooltip;
      card.title = guidedSetupDisabledTooltip;
      card.setAttribute('aria-label', guidedSetupDisabledTooltip);
      card.setAttribute('tabindex', '0');
    }

    if (!guidedSetupDisabled) {
      card.addEventListener('click', () => toggleServerSelection(originalIndex, setupState, callbacks));
    }

    if (fragment) {
      fragment.appendChild(card);
      return;
    }

    serverGrid.appendChild(card);
  });

  if (fragment) {
    serverGrid.appendChild(fragment);
  }

  // Update button states
  updateProceedButton(setupState);
  updateSelectAllButton(setupState);
}

// Create basic card as fallback
function createBasicCard(server, index) {
  const card = document.createElement('div');
  card.className = 'mcp-server-card';
  card.dataset.serverId = server.id;
  card.dataset.index = index;
  card.innerHTML = `
    <div class="mcp-card-header">
      <div class="mcp-card-title-info">
        <h3 class="mcp-card-name">${server.display_name || server.name}</h3>
      </div>
    </div>
  `;
  return card;
}

function applySelectedCardState(card, options = {}) {
  if (!card) return;

  card.classList.add('selected');
  card.classList.toggle('configured', options.configured === true);

  const indicator = card.querySelector('.mcp-card-selection-indicator');
  if (indicator) {
    indicator.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  }
}

function clearSelectedCardState(card) {
  if (!card) return;

  card.classList.remove('selected');
  card.classList.remove('configured');

  const indicator = card.querySelector('.mcp-card-selection-indicator');
  if (indicator) indicator.innerHTML = '';
}

// Toggle server selection
function toggleServerSelection(index, setupState, callbacks = {}) {
  const server = setupState.mcpServers[index];
  const hasRequiredVars = serverRequiresConfig(server);
  const selectionOptions = getGuidedSetupSelectionOptions(setupState);

  if (!isGuidedSetupSelectableServer(server, selectionOptions)) {
    return;
  }

  // Find the card (use mcp-server-card class)
  const card = document.querySelector(`.mcp-server-card[data-index="${index}"]`);
  if (!card) return;

  const isConfigured = callbacks.isServerConfigured ? callbacks.isServerConfigured(server) : false;

  if (setupState.selectedServers.includes(index)) {
    // Deselecting
    setupState.selectedServers = setupState.selectedServers.filter(i => i !== index);
    clearSelectedCardState(card);
  } else {
    // Selecting
    setupState.selectedServers.push(index);
    applySelectedCardState(card, {
      configured: isConfigured && hasRequiredVars,
    });
  }

  recordGuidedSetupToggleChange(
    setupState,
    server.id,
    setupState.selectedServers.includes(index),
  );

  updateProceedButton(setupState);
  updateSelectAllButton(setupState);
}

// Update proceed button state
function updateProceedButton(setupState) {
  const btn = document.getElementById('proceed-btn');
  if (btn) {
    const hasSelections = setupState.selectedServers.length > 0;
    btn.disabled = !hasSelections;
    btn.classList.toggle('is-pulsing', hasSelections);
  }
}

// Update Select All button text
function updateSelectAllButton(setupState) {
  const btn = document.getElementById('select-all-btn');
  if (!btn) return;

  // Count eligible servers (excluding HOST-disabled, user-installed, and core servers)
  // Core servers don't count since they can't be toggled
  let eligibleCount = 0;
  let selectedCount = 0;

  setupState.mcpServers.forEach((server, index) => {
    if (!isGuidedSetupSelectableServer(server, getGuidedSetupSelectionOptions(setupState))) return;

    eligibleCount++;
    if (setupState.selectedServers.includes(index)) {
      selectedCount++;
    }
  });

  const allEligibleSelected = eligibleCount > 0 && selectedCount === eligibleCount;
  btn.classList.toggle('is-hidden', eligibleCount === 0);
  btn.textContent = allEligibleSelected
    ? 'Deselect all'
    : 'Select all';
  btn.title = allEligibleSelected
    ? 'Clear the current guided setup selection'
    : 'Select all visible guided setup integrations';
  btn.setAttribute('aria-pressed', allEligibleSelected ? 'true' : 'false');
}

// Select/Deselect all servers
function selectAllServers(setupState, callbacks = {}) {
  const btn = document.getElementById('select-all-btn');
  const isSelectAll = !btn || btn.getAttribute('aria-pressed') !== 'true';
  const selectionOptions = getGuidedSetupSelectionOptions(setupState);

  setupState.mcpServers.forEach((server, index) => {
    if (!isGuidedSetupSelectableServer(server, selectionOptions)) return;

    const card = document.querySelector(`.mcp-server-card[data-index="${index}"]`);
    if (!card) return;

    if (isSelectAll) {
      if (!setupState.selectedServers.includes(index)) {
        setupState.selectedServers.push(index);
      }
      applySelectedCardState(card);
    } else {
      setupState.selectedServers = setupState.selectedServers.filter(i => i !== index);
      clearSelectedCardState(card);
    }
    recordGuidedSetupToggleChange(setupState, server.id, isSelectAll);
  });

  updateProceedButton(setupState);
  updateSelectAllButton(setupState);
}

// Legacy functions for backward compatibility (no-op)
function updateSelectAllButtons(setupState, callbacks = {}) {
  updateSelectAllButton(setupState);
}

function selectAllUnconfigured(setupState, callbacks = {}) {
  selectAllServers(setupState, callbacks);
}

function selectAllConfigured(setupState, callbacks = {}) {
  selectAllServers(setupState, callbacks);
}

function selectAllOAuth(setupState, callbacks = {}) {
  selectAllServers(setupState, callbacks);
}

function selectAllConfig(setupState, callbacks = {}) {
  selectAllServers(setupState, callbacks);
}

function selectAllReady(setupState, callbacks = {}) {
  selectAllServers(setupState, callbacks);
}

// Skip server selection
function skipServerSelection(setupState, callbacks = {}) {
  // Skip means "leave the existing integration state alone", not "disable all".
  preserveGuidedSetupToggleState(setupState);
  setupState.selectedServers = [];

  if (callbacks.proceedToConfiguration) {
    callbacks.proceedToConfiguration();
  }
}

function getRequiredEnvVarName(envVar) {
  return typeof envVar === 'string' ? envVar : envVar?.name;
}

function collectSensitiveRequiredEnvNames(servers = []) {
  const keys = new Set();
  for (const server of Array.isArray(servers) ? servers : []) {
    for (const envVar of server?.required_env_vars || server?.requiredVars || []) {
      const name = getRequiredEnvVarName(envVar);
      if (name && typeof envVar === 'object' && envVar.sensitive === true) {
        keys.add(name);
      }
    }
  }
  return keys;
}

function hasUsableEnvValue(value, callbacks = {}) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    return false;
  }
  if (typeof callbacks.isPlaceholderValue === 'function') {
    return !callbacks.isPlaceholderValue(normalizedValue);
  }
  return true;
}

function mergeSelectedServerPresetEnvVars(selectedServersList, setupState, callbacks = {}) {
  if (!setupState?.envVars) {
    return;
  }

  const sensitiveRequiredKeys = collectSensitiveRequiredEnvNames(selectedServersList);
  for (const server of selectedServersList) {
    const presets = Array.isArray(server?.presetVars)
      ? server.presetVars
      : Array.isArray(server?.preset_env_vars)
        ? server.preset_env_vars
        : [];

    for (const preset of presets) {
      const name = typeof preset?.name === 'string' ? preset.name.trim() : '';
      if (!name || preset.value === undefined || preset.value === null) {
        continue;
      }
      if (sensitiveRequiredKeys.has(name)) {
        continue;
      }
      if (hasUsableEnvValue(setupState.envVars[name], callbacks)) {
        continue;
      }
      setupState.envVars[name] = String(preset.value);
    }
  }
}

// Proceed to next step after server selection
// Now goes to OAuth stage first (if needed), then configuration
async function proceedToConfiguration(setupState, callbacks = {}) {
  const selectionOptions = getGuidedSetupSelectionOptions(setupState);
  setupState.selectedServers = (Array.isArray(setupState.selectedServers) ? setupState.selectedServers : [])
    .filter((index) => isGuidedSetupSelectableServer(setupState.mcpServers[index], selectionOptions));

  if (setupState.selectedServers.length === 0) {
    setupState.oauthStepRequired = false;
    setupState.completedSteps.oauth = true;
    if (callbacks.showStage) {
      await callbacks.showStage('finalize');
    }
    if (callbacks.finalizeSetup) {
      callbacks.finalizeSetup();
    }
    return;
  }

  // Mark server selection as completed
  setupState.completedSteps.serverSelection = true;
  if (callbacks.updateProgressTracker) {
    callbacks.updateProgressTracker();
  }

  // Get selected servers
  const selectedServersList = setupState.selectedServers.map(i => setupState.mcpServers[i]);
  mergeSelectedServerPresetEnvVars(selectedServersList, setupState, callbacks);

  // Reset tracking
  setupState.configuredServers.clear();
  setupState.preConfiguredServers?.clear?.();
  setupState.skippedServers.clear();
  setupState.completedOAuthServers.clear();
  setupState.connectedOAuthServers?.clear?.();
  setupState.skippedOAuthServers.clear();
  setupState.pendingOAuthConfigurationServerId = null;

  const selectedServerRequirements = selectedServersList.map((server) => ({
    server,
    ...getGuidedSetupRequirements(server),
  }));

  // OAuth and configuration are independent requirements. A server may be in both queues.
  const oauthServers = selectedServerRequirements
    .filter(({ requiresOAuth }) => requiresOAuth)
    .map(({ server }) => server);
  setupState.oauthServers = oauthServers;
  setupState.oauthStepRequired = oauthServers.length > 0;
  setupState.completedSteps.oauth = oauthServers.length === 0;

  if (oauthServers.length > 0 && callbacks.analyzeOAuthServers) {
    const oauthAnalysis = await callbacks.analyzeOAuthServers(oauthServers);
    setupState.oauthServers = oauthAnalysis.servers;
    setupState.completedOAuthServers.clear();
    oauthAnalysis.completedServerIds.forEach((serverId) => {
      setupState.completedOAuthServers.add(serverId);
    });
    setupState.oauthStepRequired = oauthAnalysis.pendingCount > 0;
    setupState.completedSteps.oauth = oauthAnalysis.pendingCount === 0;
  }

  setupState.serverConfigs = selectedServerRequirements
    .filter(({ requiresConfig }) => requiresConfig)
    .map(({ server }) => server);

  // Check which servers are already configured
  setupState.serverConfigs.forEach(server => {
    if (callbacks.isServerConfigured && callbacks.isServerConfigured(server)) {
      setupState.configuredServers.add(server.id);
      setupState.preConfiguredServers?.add?.(server.id);
    }
  });

  // Determine next step based on what servers need
  if (callbacks.updateProgressTracker) {
    callbacks.updateProgressTracker();
  }

  if (setupState.oauthStepRequired) {
    // Go to OAuth stage first
    setupState.currentOAuthIndex = 0;
    if (callbacks.showStage) {
      callbacks.showStage('oauth');
    }
  } else if (setupState.serverConfigs.length > 0) {
    // Skip OAuth, go directly to configuration
    const nextConfigIndex = callbacks.findNextPendingConfigurationIndex
      ? callbacks.findNextPendingConfigurationIndex(0)
      : 0;

    if (nextConfigIndex !== -1 && callbacks.loadServerConfiguration) {
      setupState.currentServerIndex = nextConfigIndex;
      await callbacks.loadServerConfiguration(nextConfigIndex);
    } else if (nextConfigIndex !== -1) {
      setupState.currentServerIndex = nextConfigIndex;
    } else {
      if (callbacks.showStage) {
        await callbacks.showStage('finalize');
      }
      if (callbacks.finalizeSetup) {
        callbacks.finalizeSetup();
      }
    }
  } else {
    // No servers need OAuth or configuration - go to finalize
    if (callbacks.showStage) {
      await callbacks.showStage('finalize');
    }
    if (callbacks.finalizeSetup) {
      callbacks.finalizeSetup();
    }
  }
}

// Export functions
module.exports = {
  populateServerGrid,
  toggleServerSelection,
  updateProceedButton,
  updateSelectAllButton,
  updateSelectAllButtons,
  selectAllServers,
  selectAllUnconfigured,
  selectAllConfigured,
  selectAllOAuth,
  selectAllConfig,
  selectAllReady,
  skipServerSelection,
  proceedToConfiguration,
  serverRequiresOAuth,
  serverRequiresConfig,
  getServerCategory,
  mergeSelectedServerPresetEnvVars,
  isUserInstalled,
  serverIsCore
};

// NOTE: Window exports are handled by the main guided-setup.js orchestrator
// to ensure proper callback and state injection
