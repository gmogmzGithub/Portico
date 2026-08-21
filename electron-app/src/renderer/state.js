// Centralized state management for renderer
const state = {
  env: {},
  servers: [],
  dockerStatus: {
    running: false,
    containers: {},
    lastCheck: null
  },
  isLoading: false,
  chatLoaded: false,
  toggles: {},  // MCP server enable/disable toggles
  disableModes: {},  // PORTICO-410: serverId -> "hard" for hard-disabled servers
  togglesModified: false,  // Track if toggles have been changed
  updateAvailable: false,  // Track if an update is available
  updateInfo: null,  // Store update information
  updateCheckInterval: null,  // Store interval ID for update checks
  updatePromptedKey: null,  // Tracks which prepared update has already prompted the user
  updatePrep: {
    state: 'idle',
    updateKey: null,
    phase: 'idle',
    message: '',
    overallPercent: 0,
    error: null,
    docker: {
      totalImages: 0,
      completed: 0,
      pulled: 0,
      failed: 0,
      images: {}
    },
    prepared: null
  },
  hostModeSupported: true,  // Track if HOST mode dependencies are installed
  debuggerTabs: {},  // Track open MCP debugger tabs by serverId
  conversationTabs: {},  // Track open conversation detail tabs by conversationId
  healthStatus: null,  // Track health status from continuous monitoring
  healthStatusStale: false,  // True when initial on-disk health snapshot is stale
  lastHealthSequence: 0,  // Monotonic sequence from backend health broadcasts
  currentUser: {
    authenticated: false,
    sessionSummary: null,
    error: null,
    loadedAt: null
  },
  activeTab: 'chat',  // Track currently active top-level tab
  controlPlaneView: 'mcp-servers',  // Track Control Plane sub-tab
  toolsRefreshInProgress: false,  // Guard against overlapping tool count refreshes
  pendingServerOperations: {},  // Temporary client-side operation state during MCP enable/restart flows
  activeMcpOperationTracker: null,  // Visible per-server progress overlay state

  tabOrder: ['chat'],  // Ordered visible tab IDs; permanent tabs always first
  tabMeta: {
    control: { title: 'Control Plane', type: 'permanent' },
    chat: { title: 'Chat', type: 'permanent' },
  },
};

const TAB_PERSIST_KEY = 'portico-tab-state';
const PERSISTED_PERMANENT_TABS = new Set(['chat']);

function persistTabState() {
  try {
    const serializable = {
      tabOrder: state.tabOrder,
      tabMeta: {},
      activeTab: state.activeTab,
    };
    for (const [id, meta] of Object.entries(state.tabMeta)) {
      if (meta.type === 'permanent' && !PERSISTED_PERMANENT_TABS.has(id)) continue;
      serializable.tabMeta[id] = {
        url: meta.url,
        title: meta.title,
        customTitle: meta.customTitle || null,
        autoTitle: meta.autoTitle || null,
        conversationId: meta.conversationId,
        type: meta.type,
        unread: meta.unread === true,
        attentionRequired: meta.attentionRequired === true,
        // Last responding model (drives the tab's model-logo icon).
        modelIdentity:
          meta.modelIdentity && typeof meta.modelIdentity === 'object'
            ? meta.modelIdentity
            : null,
      };
    }
    localStorage.setItem(TAB_PERSIST_KEY, JSON.stringify(serializable));
  } catch (e) {
    console.warn('[State] Failed to persist tab state:', e);
  }
}

function loadPersistedTabState() {
  try {
    const raw = localStorage.getItem(TAB_PERSIST_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getTabDisplayTitle(tabId) {
  const meta = state.tabMeta[tabId];
  if (!meta) return tabId;
  return meta.customTitle || meta.autoTitle || meta.title || 'Chat';
}

// Export for use by other components
window.appState = state;
window.persistTabState = persistTabState;
window.loadPersistedTabState = loadPersistedTabState;
window.getTabDisplayTitle = getTabDisplayTitle;
