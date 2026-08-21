// MCP badge component - placeholder for now
// The actual implementation needs to be extracted from renderer.js

function updateMcpBadge(servers) {
  const badgeCount = document.querySelector('.mcp-badge-count');
  const badge = document.getElementById('mcp-badge');

  if (badgeCount) {
    badgeCount.textContent = servers ? servers.length : 0;
  }

  if (badge) {
    badge.style.background = 'linear-gradient(135deg, rgba(122, 162, 247, 0.15), rgba(122, 162, 247, 0.05))';
    badge.style.borderColor = '#7aa2f7';
  }
}

function updateMcpBadgeWithHealth() {
  // Simplified version - just use regular update for now
  const state = window.appState;
  if (!state) return;

  const configuredServers = state.servers ? state.servers.filter(s => s.isConfigured) : [];
  let enabledServers = configuredServers.filter(
    (s) => s.isCore || state.toggles[s.id] === true,
  );

  updateMcpBadge(enabledServers);
}

function setupMcpBadgeHover() {
  const badge = document.getElementById('mcp-badge');
  const tooltip = document.getElementById('mcp-tooltip');

  if (!badge || !tooltip) return;

  badge.addEventListener('mouseenter', () => {
    tooltip.style.display = 'block';
  });

  badge.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

// Export functions
window.updateMcpBadge = updateMcpBadge;
window.updateMcpBadgeWithHealth = updateMcpBadgeWithHealth;
window.setupMcpBadgeHover = setupMcpBadgeHover;
