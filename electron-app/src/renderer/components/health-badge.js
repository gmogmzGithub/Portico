// Health badge component - extracted from renderer.js
function updateHealthBadge() {
  const state = window.appState;
  const healthIndicator = document.querySelector('.health-indicator');
  if (!healthIndicator || !state.healthStatus) return;

  const summary = state.healthStatus.summary;
  if (!summary) return;

  const total = summary.total;
  const healthy = summary.healthy;
  const disabled = summary.disabled || 0;
  const allHealthy = healthy === total - disabled;

  healthIndicator.className = allHealthy ? 'health-indicator healthy' : 'health-indicator unhealthy';
  healthIndicator.title = 'MCP Health: ' + healthy + '/' + (total - disabled) + ' servers healthy';
}

function setupHealthStatusListener() {
  if (window.electronAPI && window.electronAPI.onHealthStatusUpdate) {
    window.electronAPI.onHealthStatusUpdate((healthStatus) => {
    console.log('[Renderer] Received health status update:', healthStatus);
    const state = window.appState;

    if (!healthStatus || healthStatus.error) {
      console.warn('[Renderer] Invalid health status received:', healthStatus);
      state.healthStatus = null;
      return;
    }

    const oldStatus = state.healthStatus;
    state.healthStatus = healthStatus;

    const oldHealthy = oldStatus && oldStatus.summary ? oldStatus.summary.healthy : null;
    const newHealthy = healthStatus.summary ? healthStatus.summary.healthy : null;

    if (oldHealthy !== newHealthy) {
      console.log('[Renderer] Health status changed');
      if (window.updateMcpBadgeWithHealth) {
        window.updateMcpBadgeWithHealth();
      }
    }

    updateHealthBadge();
    });
  } else {
    console.warn('onHealthStatusUpdate not available in electronAPI');
  }
}

window.updateHealthBadge = updateHealthBadge;
window.setupHealthStatusListener = setupHealthStatusListener;