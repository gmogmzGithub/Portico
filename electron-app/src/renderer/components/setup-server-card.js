// Server card component for guided setup
// Using same styling as Control Plane mcp-servers.js

const {
  getGuidedSetupDescription,
  getGuidedSetupRequirements,
  serverRequiresConfig,
  serverRequiresOAuth,
} = require('../../services/guided-setup/server-requirements');

// Helper to check if server is core
function serverIsCore(server) {
  return server.isCore === true;
}

// Create a server card element (Control Plane style)
function createServerCard(server, originalIndex, isConfigured, hostModeSupported, options = {}) {
  const card = document.createElement('div');
  card.className = 'mcp-server-card';
  card.dataset.serverId = server.id;
  card.dataset.index = originalIndex;

  const {
    requiresConfig: hasRequiredVars,
    requiresOAuth,
  } = getGuidedSetupRequirements(server);
  const isCore = serverIsCore(server);
  const deploymentType = server.deploymentType || 'docker';
  const isHostServer = deploymentType === 'host';
  const isHostDisabled = isHostServer && !hostModeSupported;
  const guidedSetupDisabled = options.guidedSetupDisabled === true;
  const guidedSetupDisabledTooltip =
    typeof options.guidedSetupDisabledTooltip === 'string' &&
    options.guidedSetupDisabledTooltip.trim().length > 0
      ? options.guidedSetupDisabledTooltip.trim()
      : null;

  if (isHostDisabled) {
    card.classList.add('host-disabled');
  }
  if (guidedSetupDisabled) {
    card.classList.add('guided-setup-disabled');
    card.setAttribute('aria-disabled', 'true');
  }
  if (guidedSetupDisabledTooltip) {
    card.dataset.tooltip = guidedSetupDisabledTooltip;
    card.title = guidedSetupDisabledTooltip;
    card.setAttribute('aria-label', guidedSetupDisabledTooltip);
    card.setAttribute('tabindex', '0');
  }

  // Mark core servers with a special class
  if (isCore) {
    card.classList.add('core-server');
  }

  // Get display name and clean it up
  let displayName = server.display_name || server.name;
  let cleanName = displayName.replace(' MCP Server', '');

  // Create icon HTML - use server icon if available, otherwise use placeholder
  let iconHtml = '';
  if (server.icon) {
    cleanName = cleanName.replace(/^[🦊💬📧🔍📋⏰🕐🔌📝🎯🚨🐙]\s*/, '');
    iconHtml = `<img src="${server.icon}" alt="${cleanName}" class="mcp-card-icon-img">`;
  } else {
    // Default icon placeholder
    iconHtml = `<div class="mcp-card-icon-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="9" y1="9" x2="15" y2="9"></line>
        <line x1="9" y1="13" x2="15" y2="13"></line>
        <line x1="9" y1="17" x2="12" y2="17"></line>
      </svg>
    </div>`;
  }

  // Build badges HTML - show Core, OAuth Required, and Config Required badges
  let badgesHtml = '';

  if (isCore) {
    badgesHtml += '<span class="mcp-card-badge badge-core">CORE</span>';
  }
  if (requiresOAuth) {
    badgesHtml += '<span class="mcp-card-badge badge-oauth">Auth Required</span>';
  }
  if (hasRequiredVars) {
    badgesHtml += '<span class="mcp-card-badge badge-config">Config Required</span>';
  }
  if (server.deprecated) {
    badgesHtml += '<span class="mcp-card-badge badge-deprecated">DEPRECATED</span>';
  }

  const cardDescription = getGuidedSetupDescription(server);

  card.innerHTML = `
    <div class="mcp-card-header">
      <div class="mcp-card-icon-wrapper">
        ${iconHtml}
      </div>
      <div class="mcp-card-title-info">
        <h3 class="mcp-card-name">${cleanName}</h3>
        <p class="mcp-card-description">${cardDescription}</p>
      </div>
      <div class="mcp-card-selection-indicator"></div>
    </div>
    <div class="mcp-card-body">
      <div class="mcp-card-badges">${badgesHtml}</div>
    </div>
  `;

  return card;
}

// Add selection state to card
function selectServerCard(card) {
  card.classList.add('selected');
  const indicator = card.querySelector('.mcp-card-selection-indicator');
  if (indicator) {
    indicator.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  }
}

// Remove selection state from card
function deselectServerCard(card) {
  card.classList.remove('selected');
  card.classList.remove('configured');
  const indicator = card.querySelector('.mcp-card-selection-indicator');
  if (indicator) {
    indicator.innerHTML = '';
  }
  const checkmark = card.querySelector('.configured-checkmark');
  if (checkmark) {
    checkmark.remove();
  }
}

// Add configured checkmark to card
function addConfiguredCheckmark(card) {
  card.classList.add('configured');
  const indicator = card.querySelector('.mcp-card-selection-indicator');
  if (indicator) {
    indicator.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
  }
}

// Create HOST mode warning message
function createHostWarning() {
  const warningDiv = document.createElement('div');
  warningDiv.id = 'host-warning-message';
  warningDiv.className = 'host-warning';
  warningDiv.innerHTML = `
    <div class="host-warning-icon">⚠️</div>
    <div class="host-warning-content">
      The necessary dependencies needed to run Host-mode integrations are not installed. These servers will be unavailable. For help, please ask in <a href="#" class="slack-channel" onclick="return false;">#help-portico</a> on Slack.
    </div>
  `;
  return warningDiv;
}

// Export functions
module.exports = {
  createServerCard,
  selectServerCard,
  deselectServerCard,
  addConfiguredCheckmark,
  createHostWarning,
  serverRequiresOAuth,
  serverRequiresConfig,
  getGuidedSetupDescription,
  serverIsCore
};
