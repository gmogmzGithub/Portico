// Browser panel component for guided setup
// Extracted from guided-setup.js
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

// Show browser panel
function showBrowser(setupState) {
  if (!setupState.browserVisible) {
    const mainContainer = document.getElementById('main-container');
    mainContainer.classList.remove('browser-hidden');
    setupState.browserVisible = true;
    if (typeof addLog === 'function') {
      addLog('Browser panel opened', 'info');
    }
  }
}

// Hide browser panel
function hideBrowser(setupState) {
  if (setupState.browserVisible) {
    const mainContainer = document.getElementById('main-container');
    mainContainer.classList.add('browser-hidden');
    setupState.browserVisible = false;
    if (typeof addLog === 'function') {
      addLog('Browser panel closed', 'info');
    }
  }
}

// Load URL in browser webview
function loadBrowserUrl(url) {
  console.log('[loadBrowserUrl] Function called with URL:', url);

  const webview = document.getElementById('browser-webview');
  console.log('[loadBrowserUrl] webview element:', webview);

  if (!webview) {
    console.error('[loadBrowserUrl] ERROR: webview not found!');
    if (typeof addLog === 'function') {
      addLog('ERROR: Cannot find browser webview!', 'error');
    }
    alert('Browser webview not found. The browser panel may not be loaded properly.');
    return;
  }

  // Try to load the URL
  try {
    console.log('[loadBrowserUrl] Current webview src:', webview.src);
    console.log('[loadBrowserUrl] Loading URL in webview:', url);

    // Use webview loadURL method
    if (url.startsWith('http://') || url.startsWith('https://')) {
      webview.loadURL(url);
      console.log('[loadBrowserUrl] webview.loadURL called successfully');
      if (typeof addLog === 'function') {
        addLog(`Loading ${url}...`, 'info');
      }
    } else {
      console.error('[loadBrowserUrl] Invalid URL format:', url);
      if (typeof addLog === 'function') {
        addLog(`Invalid URL: ${url}`, 'error');
      }
    }

  } catch (error) {
    console.error('[loadBrowserUrl] Exception:', error);
    if (typeof addLog === 'function') {
      addLog(`Error loading URL: ${error.message}`, 'error');
    }
    // Fallback: try to open in external browser via secure IPC
    console.log('[loadBrowserUrl] Attempting to open in external browser...');
    if (window.electronAPI && window.electronAPI.openUrl) {
      window.electronAPI.openUrl(url);
    }
  }
}

// Open URL in external browser
function openExternalUrl(url) {
  console.log('[openExternalUrl] Opening URL in external browser:', url);

  // Use Electron's shell.openExternal via secure IPC
  if (window.electronAPI && window.electronAPI.openUrl) {
    window.electronAPI.openUrl(url).then(() => {
      console.log('[openExternalUrl] URL opened successfully');
      if (typeof addLog === 'function') {
        addLog(`Opening ${url} in external browser...`, 'info');
      }
    }).catch(error => {
      console.error('[openExternalUrl] Error opening URL:', error);
      if (typeof addLog === 'function') {
        addLog(`Error opening URL: ${error.message}`, 'error');
      }
      // Last resort: try window.open
      window.open(url, '_blank');
    });
  } else {
    // Fallback if electronAPI not available
    window.open(url, '_blank');
  }
}

// Set up webview event listeners
function setupWebview() {
  const webview = document.getElementById('browser-webview');
  if (!webview) {
    console.error('[setupWebview] Webview not found!');
    return;
  }

  console.log('[setupWebview] Setting up webview event listeners');

  // Handle webview events
  webview.addEventListener('dom-ready', () => {
    console.log('[setupWebview] Webview DOM ready');
  });

  webview.addEventListener('did-start-loading', () => {
    console.log('[setupWebview] Webview started loading');
    if (typeof addLog === 'function') {
      addLog('Loading page...', 'info');
    }
  });

  webview.addEventListener('did-stop-loading', () => {
    console.log('[setupWebview] Webview stopped loading');
  });

  webview.addEventListener('did-finish-load', () => {
    console.log('[setupWebview] Webview finished loading');
    const url = webview.getURL();
    console.log('[setupWebview] Current URL:', url);
    if (typeof addLog === 'function') {
      addLog(`Page loaded: ${url}`, 'success');
    }
  });

  webview.addEventListener('did-fail-load', (event) => {
    console.error('[setupWebview] Webview failed to load:', event);
    // Don't show error for aborted requests
    if (event.errorCode !== -3 && event.errorCode !== 0) {
      if (typeof addLog === 'function') {
        addLog(`Failed to load page: ${event.errorDescription}`, 'error');
      }
    }
  });

  webview.addEventListener('new-window', (event) => {
    console.log('[setupWebview] New window requested:', event.url);
    // Open in external browser via secure IPC
    if (window.electronAPI && window.electronAPI.openUrl) {
      window.electronAPI.openUrl(event.url);
    }
    event.preventDefault();
  });
}

// Set up resize handle for browser panel
function setupResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const setupPanel = document.querySelector('.setup-panel');
  let isResizing = false;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const containerWidth = document.querySelector('.main-container').offsetWidth;
    const newWidth = e.clientX;
    const percentage = (newWidth / containerWidth) * 100;

    if (percentage > 30 && percentage < 70) {
      setupPanel.style.width = `${percentage}%`;
      setupPanel.style.minWidth = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = 'default';
  });
}

// Export functions
module.exports = {
  showBrowser,
  hideBrowser,
  loadBrowserUrl,
  openExternalUrl,
  setupWebview,
  setupResizeHandle
};

// Also expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.loadBrowserUrl = loadBrowserUrl;
  window.openExternalUrl = openExternalUrl;
  window.setupWebview = setupWebview;
}
