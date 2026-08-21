// MCP toggles component - extracted from renderer.js
function toggleMcpServer(serverId, enabled) {
  const state = window.appState;
  state.toggles[serverId] = enabled;
  state.togglesModified = true;
  
  // Update button visibility
  if (window.showSaveButton) window.showSaveButton();
  
  // Update badge count
  const configuredServers = state.servers.filter(s => s.isConfigured);
  let enabledServers = configuredServers.filter(
    (s) => s.isCore || state.toggles[s.id] === true,
  );
  
  if (!state.hostModeSupported) {
    enabledServers = enabledServers.filter(s => (s.deploymentType || 'docker') !== 'host');
  }
  
  if (window.updateMcpBadge) window.updateMcpBadge(enabledServers);
}

async function saveMcpToggles() {
  const state = window.appState;
  if (!state.togglesModified) return;
  
  window.showLoading('Reloading MCP servers (partial restart)...');
  
  try {
    const result = await window.electronAPI.saveMcpToggles(state.toggles);
    if (result.success) {
      state.togglesModified = false;
      if (window.hideSaveButton) window.hideSaveButton();
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const healthStatus = await window.electronAPI.getHealthStatus();
      if (healthStatus && !healthStatus.error) {
        state.healthStatus = healthStatus;
        if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
      }
      
      window.showNotification('MCP servers updated', 'success');
    } else {
      window.showNotification('Failed to update MCP servers', 'error');
    }
  } catch (error) {
    console.error('Failed to save toggles:', error);
    window.showNotification('Failed to update MCP servers', 'error');
  }
  
  window.hideLoading();
}

window.toggleMcpServer = toggleMcpServer;
window.saveMcpToggles = saveMcpToggles;
