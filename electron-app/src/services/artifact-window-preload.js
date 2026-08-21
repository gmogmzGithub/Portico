// Preload script for detached artifact windows
// Provides API for attach/refresh/version management functionality
// Note: Due to context isolation, page variables are not accessible here.
// All data must be passed as function arguments from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Attach artifact back to main window panel
  // artifactId must be passed from the page since we can't access window.ARTIFACT_ID
  attachToMain: (artifactId, chatId = null) => {
    if (artifactId) {
      console.log('[Artifacts] Detached window: Attaching to main, artifactId:', artifactId, 'chatId:', chatId);
      return ipcRenderer.invoke('artifact-attach', { artifactId, chatId });
    } else {
      console.error('[Artifacts] No artifact ID provided for attach');
      return Promise.resolve({ success: false, error: 'No artifact ID' });
    }
  },

  // Refresh the webview by reloading its src
  // currentSrc must be passed from the page
  refresh: (currentSrc) => {
    console.log('[Artifacts] Detached window: Refreshing webview');
    // We can't directly call webview.reload() due to context isolation
    // Instead, the page will handle the refresh by resetting the src
    return { refresh: true, src: currentSrc };
  },

  refreshRuntime: (artifactId, version, previewUrl) => {
    return ipcRenderer.invoke('artifact-refresh-runtime', {
      artifactId,
      version,
      previewUrl,
      detached: true,
    });
  },

  // Switch to a different version
  switchVersion: (artifactId, version) => {
    if (!artifactId) {
      console.error('[Artifacts] No artifact ID provided for version switch');
      return Promise.resolve({ success: false, error: 'No artifact ID' });
    }
    console.log(`[Artifacts] Detached window: Switching to version ${version}`);
    return ipcRenderer.invoke('artifact-switch-version', { artifactId, version });
  },

  // Sync version state to main process (called after successful version switch)
  // This ensures re-attach preserves the version that was active in detached window
  syncDetachedVersion: (artifactId, version, userInitiated, previewUrl = null) => {
    if (!artifactId) {
      return Promise.resolve({ success: false, error: 'No artifact ID' });
    }
    console.log(`[Artifacts] Detached window: Syncing version state v${version}`);
    return ipcRenderer.invoke('artifact-sync-detached-version', { artifactId, version, userInitiated, previewUrl });
  },

  // Get list of artifacts (to extract versions)
  getVersionList: (chatId) => {
    if (!chatId || chatId === 'null') {
      console.error('[Artifacts] No valid chat ID provided for version list');
      return Promise.resolve({ artifacts: [] });
    }
    console.log('[Artifacts] Detached window: Getting version list for chat:', chatId);
    return ipcRenderer.invoke('artifact-get-list', { chatId, includeAllVersions: true });
  },

  // Get running versions for health indicators
  getRunningVersions: (artifactId) => {
    if (!artifactId) {
      return Promise.resolve({ success: false, running_versions: [] });
    }
    return ipcRenderer.invoke('artifact-get-running-versions', { artifactId });
  },

  // Ping servers for health checks
  pingServers: (ports) => {
    return ipcRenderer.invoke('artifact-ping-servers', { ports });
  },

  // Check if can attach (main panel not occupied)
  canAttach: (chatId = null, artifactId = null) => {
    return ipcRenderer.invoke('artifact-can-attach', { chatId, artifactId });
  },

  // Listen for version changes from backend
  onVersionChanged: (callback) => {
    ipcRenderer.on('artifact-version-changed', (event, data) => callback(data));
  },

  // Listen for panel state changes (when main panel opens/closes)
  // This allows detached windows to immediately update their attach button state
  onPanelStateChanged: (callback) => {
    ipcRenderer.on('artifact-panel-state-changed', (event, data) => callback(data));
  },

  // Listen for artifact-open events (server became ready)
  // This handles the case where the window was created before the server was fully running
  onArtifactOpen: (callback) => {
    ipcRenderer.on('artifact-open', (event, data) => callback(data));
  }
});
