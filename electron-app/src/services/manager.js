// Enhanced Manager with Log Streaming Support

// Log viewer window reference
let logWindow = null;
let currentProcessId = null;

// ANSI to HTML converter for inline logs
function ansiToHtml(text) {
  const ansiRegex = /\x1b\[([0-9;]+)m/g;
  let html = text;

  const ansiMap = {
    '0': '</span>',
    '1': '<span style="font-weight:bold">',
    '31': '<span style="color:#f7768e">',
    '32': '<span style="color:#9ece6a">',
    '33': '<span style="color:#e0af68">',
    '34': '<span style="color:#7aa2f7">',
    '35': '<span style="color:#bb9af7">',
    '36': '<span style="color:#7dcfff">',
    '91': '<span style="color:#f7768e">',
    '92': '<span style="color:#9ece6a">',
    '93': '<span style="color:#ff9e64">',
  };

  html = html.replace(ansiRegex, (match, codes) => {
    const codeList = codes.split(';');
    let result = '';
    for (const code of codeList) {
      if (ansiMap[code]) {
        result += ansiMap[code];
      }
    }
    return result || '';
  });

  // Escape HTML
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Re-enable our span tags
  html = html
    .replace(/&lt;span style="([^"]+)"&gt;/g, '<span style="$1">')
    .replace(/&lt;\/span&gt;/g, '</span>');

  return html;
}

// Create inline log display
function createInlineLogDisplay() {
  const logPanel = document.createElement('div');
  logPanel.id = 'inline-log-panel';
  logPanel.innerHTML = `
    <div class="log-panel">
      <div class="log-panel-header">
        <span class="log-panel-title">Operation Logs</span>
        <div class="log-panel-controls">
          <button id="copy-logs" class="log-btn-small" title="Copy logs to clipboard">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button id="clear-logs" class="log-btn-small">Clear</button>
          <button id="expand-logs" class="log-btn-small">Expand</button>
          <button id="close-logs" class="log-btn-small">×</button>
        </div>
      </div>
      <div class="log-panel-content" id="log-content"></div>
    </div>
  `;
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    .log-panel {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #1a1b26;
      border-top: 2px solid #7aa2f7;
      max-height: 400px;
      display: flex;
      flex-direction: column;
      transition: all 0.3s ease;
      z-index: 1000;
    }
    
    .log-panel.hidden {
      transform: translateY(100%);
    }
    
    .log-panel.expanded {
      max-height: 80vh;
    }
    
    .log-panel-header {
      background: #24283b;
      padding: 10px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #414868;
    }
    
    .log-panel-title {
      color: #7aa2f7;
      font-weight: 600;
      font-size: 14px;
    }
    
    .log-panel-controls {
      display: flex;
      gap: 8px;
    }
    
    .log-btn-small {
      background: #414868;
      border: none;
      color: #c0caf5;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    
    .log-btn-small:hover {
      background: #565f89;
    }
    
    .log-panel-content {
      flex: 1;
      overflow-y: auto;
      padding: 15px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #c0caf5;
      background: #1a1b26;
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }
    
    .log-entry {
      margin-bottom: 2px;
      white-space: pre-wrap;
      word-wrap: break-word;
      user-select: text;
      -webkit-user-select: text;
    }
    
    .log-entry.error {
      color: #f7768e;
    }
    
    .log-entry.success {
      color: #9ece6a;
    }
    
    .log-entry.warning {
      color: #e0af68;
    }
  `;
  
  document.head.appendChild(style);
  document.body.appendChild(logPanel);
  
  // Setup controls
  document.getElementById('copy-logs').addEventListener('click', () => {
    copyLogsToClipboard();
  });
  
  document.getElementById('clear-logs').addEventListener('click', () => {
    document.getElementById('log-content').innerHTML = '';
  });
  
  document.getElementById('expand-logs').addEventListener('click', () => {
    logPanel.querySelector('.log-panel').classList.toggle('expanded');
    const btn = document.getElementById('expand-logs');
    btn.textContent = logPanel.querySelector('.log-panel').classList.contains('expanded') ? 'Collapse' : 'Expand';
  });
  
  document.getElementById('close-logs').addEventListener('click', () => {
    logPanel.querySelector('.log-panel').classList.add('hidden');
  });
  
  return logPanel;
}

// Show inline logs
function showInlineLogs() {
  let panel = document.getElementById('inline-log-panel');
  if (!panel) {
    panel = createInlineLogDisplay();
  }
  panel.querySelector('.log-panel').classList.remove('hidden');
}

// Add log entry to inline display
function addInlineLog(text, type = 'info') {
  const logContent = document.getElementById('log-content');
  if (!logContent) return;
  
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = ansiToHtml(text);
  logContent.appendChild(entry);
  
  // Auto-scroll to bottom
  logContent.scrollTop = logContent.scrollHeight;
}

// Enhanced start services with logging
async function startServicesWithLogs() {
  // Use the main process handler which will show the loading screen
  try {
    const result = await window.electronAPI.dockerStart();
    console.log('Start services result:', result);
    return result.success;
  } catch (error) {
    console.error('Start services error:', error);
    showManagerNotification('Start Failed', error.message, 'error');
    return false;
  }
}

// Enhanced stop services with logging
async function stopServicesWithLogs() {
  showInlineLogs();
  addInlineLog('Stopping Portico services...\n', 'info');
  
  try {
    const result = await window.electronAPI.dockerStopWithLogs();
    
    if (result.success) {
      addInlineLog('\n✅ All services stopped successfully\n', 'success');
      showManagerNotification('Services Stopped', 'All services have been stopped');
    } else {
      addInlineLog(`\n❌ Failed to stop services: ${result.error}\n`, 'error');
      showManagerNotification('Stop Failed', result.error, 'error');
    }
    
    return result.success;
  } catch (error) {
    addInlineLog(`\n❌ Error: ${error.message}\n`, 'error');
    showManagerNotification('Stop Failed', error.message, 'error');
    return false;
  }
}

// Enhanced restart services with logging
async function restartServicesWithLogs() {
  // Use the main process handler which will show the loading screen
  try {
    const result = await window.electronAPI.dockerRestart();
    console.log('Restart services result:', result);
    return result.success;
  } catch (error) {
    console.error('Restart services error:', error);
    showManagerNotification('Restart Failed', error.message, 'error');
    return false;
  }
}

// In-app DOM toasts are retired; route through the shared global (itself a
// console-only no-op) so this file never grows a second toast implementation.
function showManagerNotification(title, message, type = 'info') {
  window.showNotification?.(`${title}: ${message}`, type);
}

// Setup log output listeners
window.electronAPI.onLogOutput((data) => {
  // Add to inline log display
  addInlineLog(data.data, data.type === 'stderr' ? 'error' : 'info');
});

window.electronAPI.onLogComplete((data) => {
  if (data.code === 0) {
    console.log('Process completed successfully');
  } else {
    console.error(`Process failed with code ${data.code}`);
  }
});

// Copy logs to clipboard
function copyLogsToClipboard() {
  const logContent = document.getElementById('log-content');
  if (!logContent) return;
  
  // Get text content without HTML tags but preserve structure
  const textContent = Array.from(logContent.querySelectorAll('.log-entry'))
    .map(entry => entry.textContent)
    .join('\n');
  
  if (!textContent) {
    showManagerNotification('No logs to copy', 'There are no logs to copy', 'warning');
    return;
  }
  
  // Copy to clipboard
  navigator.clipboard.writeText(textContent)
    .then(() => {
      // Visual feedback - flash the copy button
      const copyBtn = document.getElementById('copy-logs');
      if (copyBtn) {
        const originalBg = copyBtn.style.background;
        copyBtn.style.background = '#9ece6a';
        copyBtn.style.color = '#1a1b26';
        setTimeout(() => {
          copyBtn.style.background = originalBg;
          copyBtn.style.color = '';
        }, 200);
      }
      showManagerNotification('Copied!', 'Logs copied to clipboard', 'success');
    })
    .catch(err => {
      console.error('Failed to copy:', err);
      // Fallback method
      const textarea = document.createElement('textarea');
      textarea.value = textContent;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showManagerNotification('Copied!', 'Logs copied to clipboard', 'success');
      } catch (e) {
        showManagerNotification('Copy failed', 'Failed to copy logs to clipboard', 'error');
      }
      document.body.removeChild(textarea);
    });
}

// Service logs panel management
let serviceLogsPanel = null;
let currentService = null;
let serviceLogInterval = null;

// Service name mappings for display and Docker container names
const serviceMap = {
  'llm-gateway': {
    displayName: 'LLM Gateway',
    containerName: 'llm-gateway',
    type: 'docker',
    lines: 100
  },
  'mcpo-core': { displayName: 'MCP Control Plane', containerName: 'mcpo', type: 'docker', lines: 100 },
  'mcpo-openapi-aggregator': { displayName: 'MCP Control Plane', containerName: 'mcpo', type: 'docker', lines: 100 },
  'mcpo-core-openapi-aggregator': { displayName: 'MCP Control Plane', containerName: 'mcpo', type: 'docker', lines: 100 },
  'mcpo': { displayName: 'MCP Control Plane', containerName: 'mcpo', type: 'docker', lines: 100 },
  'host-mcpo': { displayName: 'Host MCP Runtime', type: 'host', lines: 100 },
  'host-mcp-bridge': { displayName: 'Host MCP Bridge', type: 'host-bridge', lines: 100 },
  'portico-open-webui': { displayName: 'Open WebUI', containerName: 'portico-open-webui', type: 'docker', lines: 100 },
  'open-webui-health-check': { displayName: 'Health Check', containerName: 'health-check', type: 'docker', lines: 1000 }
};

// Initialize service logs panel
function initServiceLogsPanel() {
  try {
    serviceLogsPanel = document.getElementById('service-logs-panel');
    const closeBtn = document.getElementById('close-service-logs');
    const copyBtn = document.getElementById('copy-service-logs');

    // Close button handler
    if (closeBtn) {
      closeBtn.addEventListener('click', closeServiceLogsPanel);
    }

    // Copy button handler
    if (copyBtn) {
      copyBtn.addEventListener('click', copyServiceLogs);
    }

    // Add click handlers to all service log buttons
    const logButtons = document.querySelectorAll('.service-logs-btn');
    logButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const serviceName = btn.getAttribute('data-service');
        openServiceLogsPanel(serviceName);
      });
    });

    // Add Escape key handler to close the panel
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && serviceLogsPanel && serviceLogsPanel.classList.contains('visible')) {
        closeServiceLogsPanel();
      }
    });
  } catch (error) {
    console.error('Error initializing service logs panel:', error);
  }
}

// Open service logs panel
// Get service info for static or dynamic per-server MCP runtime containers
function getServiceInfo(serviceName) {
  // Check static map first
  if (serviceMap[serviceName]) {
    return serviceMap[serviceName];
  }

  // Handle dynamic per-server MCP runtime containers (format: mcpo-{serverId})
  if (serviceName.startsWith('mcpo-')) {
    const serverName = serviceName.replace('mcpo-', '').replace(/-/g, ' ');
    // Capitalize first letter of each word for display
    const displayName = serverName.split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return {
      displayName: `${displayName} MCP`,
      containerName: serviceName,
      type: 'docker',
      lines: 100
    };
  }

  return null;
}

async function openServiceLogsPanel(serviceName) {
  if (!serviceLogsPanel) return;

  currentService = serviceName;
  const serviceInfo = getServiceInfo(serviceName);

  if (!serviceInfo) {
    console.error('Unknown service:', serviceName);
    return;
  }

  // Update panel title
  const titleElement = document.getElementById('service-logs-title');
  if (titleElement) {
    titleElement.textContent = `${serviceInfo.displayName} Logs`;
  }

  // Clear existing logs
  const logsBody = document.getElementById('service-logs-body');
  if (logsBody) {
    logsBody.innerHTML = '<div class="service-log-entry info">Loading logs...</div>';
  }

  // Show panel
  serviceLogsPanel.classList.add('visible');

  // Fetch logs
  await fetchServiceLogs(serviceName);

  // Start polling for new logs every 2 seconds
  if (serviceLogInterval) {
    clearInterval(serviceLogInterval);
  }
  serviceLogInterval = setInterval(() => {
    fetchServiceLogs(serviceName);
  }, 2000);
}

// Close service logs panel
function closeServiceLogsPanel() {
  if (!serviceLogsPanel) return;

  serviceLogsPanel.classList.remove('visible');
  currentService = null;

  // Stop polling
  if (serviceLogInterval) {
    clearInterval(serviceLogInterval);
    serviceLogInterval = null;
  }
}

// Fetch logs for a service
async function fetchServiceLogs(serviceName) {
  const serviceInfo = getServiceInfo(serviceName);
  if (!serviceInfo) return;

  const logsBody = document.getElementById('service-logs-body');
  if (!logsBody) return;

  try {
    let logs = '';

    if (serviceInfo.type === 'docker') {
      // Try the canonical service name first, then hidden compatibility aliases.
      const containerNames = [
        serviceInfo.containerName,
        ...(serviceInfo.fallbackContainerNames || []),
      ];

      let result = null;
      for (const containerName of containerNames) {
        result = await window.electronAPI.dockerLogs(containerName, serviceInfo.lines);
        if (result.success) {
          logs = result.logs || 'No logs available';
          break;
        }
      }

      if (!logs) {
        logs = `Error fetching logs: ${result?.error || 'Unknown error'}`;
      }
    } else if (serviceInfo.type === 'host') {
      // Fetch Host MCP runtime logs
      const result = await window.electronAPI.hostMcpoLogs(serviceInfo.lines);
      if (result.success) {
        logs = result.logs || 'No logs available';
      } else {
        logs = `Error fetching logs: ${result.error || 'Unknown error'}`;
      }
    } else if (serviceInfo.type === 'host-bridge') {
      const result = await window.electronAPI.hostMcpBridgeLogs(serviceInfo.lines);
      if (result.success) {
        logs = result.logs || 'No logs available';
      } else {
        logs = `Error fetching logs: ${result.error || 'Unknown error'}`;
      }
    }

    // Process and display logs
    displayServiceLogs(logs);

  } catch (error) {
    console.error('Error fetching service logs:', error);
    logsBody.innerHTML = `<div class="service-log-entry error">Error: ${error.message}</div>`;
  }
}

// Display logs in the panel
function displayServiceLogs(logs) {
  const logsBody = document.getElementById('service-logs-body');
  if (!logsBody) return;

  // Store current scroll position
  const wasAtBottom = logsBody.scrollHeight - logsBody.scrollTop <= logsBody.clientHeight + 50;

  // Split logs into lines and classify each line
  const lines = logs.split('\n');
  const html = lines.map(line => {
    if (!line.trim()) return '';

    // Classify log entry type based on content
    let type = 'info';
    const lowerLine = line.toLowerCase();

    if (lowerLine.includes('error') || lowerLine.includes('failed') || lowerLine.includes('exception')) {
      type = 'error';
    } else if (lowerLine.includes('warn') || lowerLine.includes('warning')) {
      type = 'warning';
    } else if (lowerLine.includes('success') || lowerLine.includes('started') || lowerLine.includes('ready')) {
      type = 'success';
    }

    // Escape HTML and convert ANSI codes
    const escapedLine = escapeHtml(line);
    return `<div class="service-log-entry ${type}">${escapedLine}</div>`;
  }).join('');

  logsBody.innerHTML = html || '<div class="service-log-entry info">No logs available</div>';

  // Auto-scroll to bottom if user was already at bottom
  if (wasAtBottom) {
    logsBody.scrollTop = logsBody.scrollHeight;
  }
}

// Escape HTML entities
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Copy service logs to clipboard
function copyServiceLogs() {
  const logsBody = document.getElementById('service-logs-body');
  if (!logsBody) return;

  // Get text content
  const logEntries = logsBody.querySelectorAll('.service-log-entry');
  const textContent = Array.from(logEntries)
    .map(entry => entry.textContent)
    .join('\n');

  if (!textContent || textContent === 'No logs available' || textContent === 'Loading logs...') {
    showManagerNotification('No logs to copy', 'There are no logs to copy', 'warning');
    return;
  }

  // Copy to clipboard
  navigator.clipboard.writeText(textContent)
    .then(() => {
      // Show feedback
      showCopyFeedback();
      showManagerNotification('Copied!', 'Logs copied to clipboard', 'success');
    })
    .catch(err => {
      console.error('Failed to copy:', err);
      // Fallback method
      const textarea = document.createElement('textarea');
      textarea.value = textContent;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showCopyFeedback();
        showManagerNotification('Copied!', 'Logs copied to clipboard', 'success');
      } catch (e) {
        showManagerNotification('Copy failed', 'Failed to copy logs to clipboard', 'error');
      }
      document.body.removeChild(textarea);
    });
}

// Show copy feedback toast
function showCopyFeedback() {
  const feedback = document.getElementById('service-logs-copy-feedback');
  if (!feedback) return;

  feedback.classList.add('visible');
  setTimeout(() => {
    feedback.classList.remove('visible');
  }, 2000);
}

// Enhanced stop services function to also stop the host MCP runtime
async function stopServicesWithLogs() {
  showInlineLogs();
  addInlineLog('Stopping Portico services...\n', 'info');

  try {
    addInlineLog('Stopping Host MCP Bridge...\n', 'info');
    const hostBridgeResult = await window.electronAPI.stopHostMcpBridge();
    if (hostBridgeResult.success) {
      addInlineLog('✅ Host MCP Bridge stopped\n', 'success');
    } else {
      addInlineLog(`⚠️ Host MCP Bridge stop: ${hostBridgeResult.message || hostBridgeResult.error}\n`, 'warning');
    }

    // Stop the host MCP runtime first
    addInlineLog('Stopping Host MCP Runtime...\n', 'info');
    const hostMcpoResult = await window.electronAPI.stopHostMcpo();
    if (hostMcpoResult.success) {
      addInlineLog('✅ Host MCP Runtime stopped\n', 'success');
    } else {
      addInlineLog(`⚠️ Host MCP Runtime stop: ${hostMcpoResult.message}\n`, 'warning');
    }

    // Stop Docker services
    const result = await window.electronAPI.dockerStopWithLogs();

    if (result.success) {
      addInlineLog('\n✅ All services stopped successfully\n', 'success');
      showManagerNotification('Services Stopped', 'All services have been stopped');
    } else {
      addInlineLog(`\n❌ Failed to stop services: ${result.error}\n`, 'error');
      showManagerNotification('Stop Failed', result.error, 'error');
    }

    return result.success;
  } catch (error) {
    addInlineLog(`\n❌ Error: ${error.message}\n`, 'error');
    showManagerNotification('Stop Failed', error.message, 'error');
    return false;
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Small delay to ensure all other scripts have initialized
  setTimeout(() => {
    initServiceLogsPanel();
  }, 100);
});

// Export functions for use in HTML
window.startServicesWithLogs = startServicesWithLogs;
window.stopServicesWithLogs = stopServicesWithLogs;
window.restartServicesWithLogs = restartServicesWithLogs;
window.showInlineLogs = showInlineLogs;
window.copyLogsToClipboard = copyLogsToClipboard;
window.openServiceLogsPanel = openServiceLogsPanel;
window.closeServiceLogsPanel = closeServiceLogsPanel;
