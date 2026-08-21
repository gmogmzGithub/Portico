// Server navigation component for guided setup
// Uses same HTML/CSS patterns as OAuth screen preview cards for consistency

// Get clean server name for display
function getCleanServerName(name) {
  return name.replace(' MCP Server', '');
}

// Create server navigation UI
// Uses exact same CSS classes as OAuth screen preview cards
function createServerNavigation(serverConfigs, currentServerIndex, configuredServers, skippedServers, preConfiguredServers = new Set()) {
  const container = document.getElementById('server-nav-container');
  if (!container || serverConfigs.length === 0) return;

  // Use same container classes as OAuth screen
  let html = '<div class="oauth-stage-preview-container"><div class="oauth-stage-preview">';

  serverConfigs.forEach((server, index) => {
    const isActive = index === currentServerIndex;
    const isCompleted = configuredServers.has(server.id);
    const isSkipped = skippedServers.has(server.id);
    const isPreConfigured = preConfiguredServers.has(server.id);

    // Get display name
    const displayName = server.display_name || server.name;
    const cleanName = getCleanServerName(server.name);
    const iconSrc = server.icon || '';

    // Status badge - same as OAuth screen
    let statusBadge = '';
    if (isCompleted || isPreConfigured) {
      const badgeClass = isPreConfigured ? 'done preconfigured' : 'done';
      const tooltip = isPreConfigured ? 'Already configured' : 'Configured';
      statusBadge = `<div class="oauth-preview-status-badge ${badgeClass}" title="${tooltip}">✓</div>`;
    } else if (isSkipped) {
      statusBadge = `<div class="oauth-preview-status-badge skipped" title="Skipped">⊘</div>`;
    }

    // Build card class - same pattern as OAuth screen
    let cardClass = 'oauth-stage-preview-card';
    if (isActive) cardClass += ' current';
    if (isCompleted) cardClass += ' done';
    if (isSkipped) cardClass += ' skipped';
    if (isPreConfigured) cardClass += ' done preconfigured';

    html += `
      <div class="${cardClass}"
           onclick="jumpToServer(${index})"
           title="${server.name}${isSkipped ? ' (Skipped)' : ''}"
           style="cursor: pointer;">
        <div class="oauth-preview-icon-container">
          ${iconSrc ? `<img class="oauth-stage-preview-icon" src="${iconSrc}" alt="${displayName}" onerror="this.style.display='none'" />` : ''}
          ${statusBadge}
        </div>
        <span class="oauth-stage-preview-name" title="${cleanName}">${cleanName}</span>
      </div>
    `;
  });

  html += '</div></div>';  // Close oauth-stage-preview and oauth-stage-preview-container

  container.innerHTML = html;
  container.style.display = 'block';
}

// Update server navigation after changes
function updateServerNavigation(serverConfigs, currentServerIndex, configuredServers, skippedServers, preConfiguredServers = new Set()) {
  const container = document.getElementById('server-nav-container');
  if (!container || container.style.display === 'none') return;

  createServerNavigation(serverConfigs, currentServerIndex, configuredServers, skippedServers, preConfiguredServers);
}

// Show server navigation container
function showServerNavContainer() {
  const container = document.getElementById('server-nav-container');
  if (container) {
    container.style.display = 'block';
  }
}

// Hide server navigation container
function hideServerNavContainer() {
  const container = document.getElementById('server-nav-container');
  if (container) {
    container.style.display = 'none';
  }
}

// Export functions
module.exports = {
  getCleanServerName,
  createServerNavigation,
  updateServerNavigation,
  showServerNavContainer,
  hideServerNavContainer
};
