// Main index page bootstrap - EXACT code from services/renderer.js
// NO BUSINESS LOGIC CHANGES

const dbCorruptionPromptState = {
  active: false,
  lastSignature: null,
};

const dbRepairModalState = {
  initialized: false,
  running: false,
  resolver: null,
  elements: {},
};

const serviceDrawerState = {
  initialized: false,
  isOpen: false,
};
const debugModeState = {
  enabled: false,
};
const debugRequestModalState = {
  initialized: false,
  jsonText: '',
  elements: {},
};
const SERVICE_DRAWER_STORAGE_KEY = 'service-drawer-open';
const nativeOverlaySuppressionReasons = new Set();
let mainWindowFullscreenListenerBound = false;
let currentUserRefreshPromise = null;

function syncMacTitlebarSafeArea() {
  if (window.electronAPI?.platform !== 'darwin') {
    return;
  }

  document.documentElement.classList.add('platform-darwin');
  let safeAreaPx = 56;

  try {
    const overlay = navigator.windowControlsOverlay;
    if (overlay && typeof overlay.getTitlebarAreaRect === 'function') {
      const rect = overlay.getTitlebarAreaRect();
      const height = Number(rect?.height);
      if (Number.isFinite(height) && height > 0) {
        safeAreaPx = Math.ceil(height);
      }
    }
  } catch (error) {
    console.warn('[WindowControlsOverlay] Failed to read titlebar area:', error);
  }

  document.documentElement.style.setProperty('--mac-titlebar-safe-area', `${safeAreaPx}px`);
}

if (window.electronAPI?.platform === 'darwin') {
  if (window.electronAPI?.nativeSidebarVibrancy) {
    document.documentElement.classList.add('native-sidebar-vibrancy');
  }
  syncMacTitlebarSafeArea();

  const overlay = navigator.windowControlsOverlay;
  if (overlay && typeof overlay.addEventListener === 'function') {
    overlay.addEventListener('geometrychange', syncMacTitlebarSafeArea);
  }
}

function syncNativeOverlaySuppression() {
  const suppressed = nativeOverlaySuppressionReasons.size > 0;

  document.body?.classList.toggle('overlay-interaction-suppressed', suppressed);

  window.setOwuiInteractionSuppressed?.('renderer-overlay', suppressed);

  const artifactHost = document.getElementById('artifact-webview-host');
  if (artifactHost) {
    artifactHost.classList.toggle('artifact-view-suppressed', suppressed);
  }
  window.syncArtifactViewHosts?.();
}

function setNativeOverlayInteractionSuppressed(reason, suppressed) {
  if (!reason) {
    return;
  }

  if (suppressed) {
    nativeOverlaySuppressionReasons.add(reason);
  } else {
    nativeOverlaySuppressionReasons.delete(reason);
  }

  syncNativeOverlaySuppression();
}

window.setNativeOverlayInteractionSuppressed = setNativeOverlayInteractionSuppressed;

const SUPPRESSION_SAFETY_CHECK_MS = 10_000;
const SUPPRESSION_STALE_THRESHOLD_MS = 15_000;
let _suppressionActiveTimestamp = 0;

setInterval(() => {
  if (nativeOverlaySuppressionReasons.size === 0) {
    _suppressionActiveTimestamp = 0;
    return;
  }

  if (_suppressionActiveTimestamp === 0) {
    _suppressionActiveTimestamp = Date.now();
    return;
  }

  if (Date.now() - _suppressionActiveTimestamp < SUPPRESSION_STALE_THRESHOLD_MS) {
    return;
  }

  const modalSelectors = {
    'oauth-wizard': '#oauth-wizard-modal.visible',
    'sensitive-info-modal': '#sensitive-info-modal.visible',
    'chat-workspace-consent-modal': '#chat-workspace-consent-modal.visible',
    'oauth-modal': '#oauth-modal.visible',
    'konami-modal': '#konami-modal.visible',
    'tool-config-modal': '#tool-config-modal.visible',
    'mcp-config-modal': '#mcp-config-modal.visible',
    'collect-debug-info': '#loading-overlay.visible',
    'debug-request-modal': '#debug-request-modal.visible',
    'mcp-operation-overlay': '#mcp-operation-overlay.visible',
    // Marketplace approval surfaces (2026-08-03 incident): a reason with no
    // entry here gets cleared as "stale" after 15s, which re-enabled the
    // overlay UNDER a live approvals modal — clicks stopped landing and the
    // publish flows silently expired while chat reported success.
    'ai-marketplace-publish-modal': '#ai-marketplace-publish-modal.visible',
    // The agents publish modal overlay exists only while open (openModal
    // creates it, closeModal removes it) — existence IS visibility.
    'agents-publish-modal': '#agents-modal-overlay',
  };

  let anyVisible = false;
  for (const reason of nativeOverlaySuppressionReasons) {
    const selector = modalSelectors[reason];
    if (selector && document.querySelector(selector)) {
      anyVisible = true;
      break;
    }
  }

  if (!anyVisible) {
    const staleReasons = [...nativeOverlaySuppressionReasons];
    console.warn(
      `[UI] Suppression safety net: clearing stale reasons (${staleReasons.join(', ')}) — no matching modal visible for >${SUPPRESSION_STALE_THRESHOLD_MS}ms`,
    );
    nativeOverlaySuppressionReasons.clear();
    _suppressionActiveTimestamp = 0;
    syncNativeOverlaySuppression();
  }
}, SUPPRESSION_SAFETY_CHECK_MS);

function applyMacFullscreenState(isFullscreen) {
  if (window.electronAPI?.platform !== 'darwin') {
    document.body?.classList.remove('mac-fullscreen');
    return;
  }

  document.body?.classList.toggle('mac-fullscreen', Boolean(isFullscreen));
}

async function syncMainWindowFullscreenState() {
  if (window.electronAPI?.platform !== 'darwin') {
    return;
  }

  if (!mainWindowFullscreenListenerBound && window.electronAPI?.onWindowFullscreenChanged) {
    window.electronAPI.onWindowFullscreenChanged((isFullscreen) => {
      applyMacFullscreenState(isFullscreen);
    });
    mainWindowFullscreenListenerBound = true;
  }

  if (!window.electronAPI?.isCurrentWindowFullscreen) {
    return;
  }

  try {
    const isFullscreen = await window.electronAPI.isCurrentWindowFullscreen();
    applyMacFullscreenState(isFullscreen);
  } catch (error) {
    console.warn('[Window] Failed to fetch initial fullscreen state:', error);
  }
}

function formatServiceDrawerRelativeDuration(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 1000) return 'just now';
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  const hours = Math.floor(ageMs / 3600000);
  const minutes = Math.floor((ageMs % 3600000) / 60000);
  return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

function formatServiceDrawerSyncTimestamp(timestamp, ageMs) {
  if (!timestamp) return 'never';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'invalid';
  const relative = formatServiceDrawerRelativeDuration(ageMs);
  const absolute = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return relative ? `${absolute} (${relative})` : absolute;
}

function updateServiceDrawerHealthSync(healthStatus = null) {
  const lastAttempt = document.getElementById('service-sync-last-attempt');
  const lastSuccess = document.getElementById('service-sync-last-success');
  const pending = document.getElementById('service-sync-pending');
  const lagging = document.getElementById('service-sync-lagging');

  if (!lastAttempt || !lastSuccess || !pending || !lagging) {
    return;
  }

  const sync = healthStatus?.sync;
  const syncDiagnostics = healthStatus?.sync_diagnostics;

  if (!sync || typeof sync !== 'object') {
    lastAttempt.textContent = 'never';
    lastSuccess.textContent = 'never';
    pending.textContent = 'none';
    lagging.textContent = '0';
    return;
  }

  const pendingSync = sync.pending_full_sync || {};
  const pendingText = pendingSync.queued
    ? `${pendingSync.reason_count || 1} queued (${formatServiceDrawerRelativeDuration(pendingSync.queued_age_ms) || 'pending'})`
    : 'none';

  lastAttempt.textContent = formatServiceDrawerSyncTimestamp(
    sync.last_full_sync_attempt_at,
    sync.last_full_sync_attempt_age_ms,
  );
  lastSuccess.textContent = formatServiceDrawerSyncTimestamp(
    sync.last_full_sync_success_at,
    sync.last_full_sync_success_age_ms,
  );
  pending.textContent = pendingText;
  lagging.textContent = String(Number(syncDiagnostics?.lagging_servers || 0));
}

function getServiceDrawerUserLabel(value, fallback = 'Unavailable') {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function updateServiceDrawerCurrentUser(currentUser = null) {
  const emailEl = document.getElementById('service-user-email');
  if (!emailEl) {
    return;
  }

  const sessionSummary = currentUser?.sessionSummary || null;
  const user = sessionSummary?.user || {};
  const authenticated = Boolean(currentUser?.authenticated && sessionSummary);

  if (!authenticated) {
    emailEl.textContent = 'Not signed in';
    return;
  }

  const email = getServiceDrawerUserLabel(user.email, 'Unavailable');
  emailEl.textContent = email;
}

async function refreshServiceDrawerCurrentUser() {
  const state = window.appState;

  if (currentUserRefreshPromise) {
    return currentUserRefreshPromise;
  }

  if (typeof window.electronAPI?.currentUser?.get !== 'function') {
    updateServiceDrawerCurrentUser(state?.currentUser || null);
    return state?.currentUser || null;
  }

  currentUserRefreshPromise = (async () => {
    try {
      const result = await window.electronAPI.currentUser.get();
      state.currentUser = {
        authenticated: Boolean(result?.authenticated && result?.sessionSummary),
        sessionSummary: result?.sessionSummary || null,
        error: result?.error || null,
        loadedAt: Date.now(),
      };
    } catch (error) {
      console.warn('[Renderer] Failed to refresh current user:', error);
      state.currentUser = {
        authenticated: false,
        sessionSummary: null,
        error: error?.message || 'Failed to load current user',
        loadedAt: Date.now(),
      };
    }

    updateServiceDrawerCurrentUser(state.currentUser);
    return state.currentUser;
  })();

  try {
    return await currentUserRefreshPromise;
  } finally {
    currentUserRefreshPromise = null;
  }
}

function syncServiceDrawerLayout() {
  const activeTab = String(window.appState?.activeTab || '');
  const usesOwuiLayer = activeTab === 'chat' || activeTab.startsWith('conversation-');
  const drawer = document.getElementById('service-drawer');
  const drawerWidth = serviceDrawerState.isOpen && drawer
    ? Math.round(drawer.getBoundingClientRect().width || 0)
    : 0;

  window.setOwuiViewportInset?.(
    'service-drawer',
    usesOwuiLayer && serviceDrawerState.isOpen ? { right: drawerWidth } : { right: 0 }
  );

  window.requestAnimationFrame(() => {
    window.syncOwuiHosts?.();
  });
}

window.syncServiceDrawerLayout = syncServiceDrawerLayout;

function setServiceDrawerOpen(isOpen, options = {}) {
  const { persist = true } = options;
  const drawer = document.getElementById('service-drawer');
  const backdrop = document.getElementById('service-drawer-backdrop');
  const toggle = document.getElementById('service-drawer-toggle');

  if (!drawer || !backdrop || !toggle) {
    return;
  }

  const shouldOpen = Boolean(isOpen);
  serviceDrawerState.isOpen = shouldOpen;
  drawer.classList.toggle('open', shouldOpen);
  backdrop.classList.toggle('visible', shouldOpen);
  toggle.classList.toggle('active', shouldOpen);
  toggle.setAttribute('aria-expanded', String(shouldOpen));
  drawer.setAttribute('aria-hidden', String(!shouldOpen));
  if (shouldOpen) {
    void refreshServiceDrawerCurrentUser();
  }
  syncServiceDrawerLayout();

  if (persist) {
    localStorage.setItem(SERVICE_DRAWER_STORAGE_KEY, shouldOpen ? '1' : '0');
  }
}

function toggleServiceDrawer() {
  setServiceDrawerOpen(!serviceDrawerState.isOpen);
}

function waitForNextAnimationFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function openServiceDrawerInControlPlane() {
  if (window.appState?.activeTab !== 'control') {
    window.ensureControlPlaneTabActive?.();
    await waitForNextAnimationFrame();

    if (window.appState?.activeTab !== 'control') {
      console.warn('[Service Drawer] Control Plane tab did not become active before opening drawer');
      return;
    }

    setServiceDrawerOpen(true);
    return;
  }

  setServiceDrawerOpen(!serviceDrawerState.isOpen);
}

function initServiceDrawer() {
  if (serviceDrawerState.initialized) {
    return;
  }
  serviceDrawerState.initialized = true;

  const toggle = document.getElementById('service-drawer-toggle');
  const backdrop = document.getElementById('service-drawer-backdrop');

  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openServiceDrawerInControlPlane();
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', () => {
      setServiceDrawerOpen(false);
    });
  }

  window.addEventListener('resize', syncServiceDrawerLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncServiceDrawerLayout);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && serviceDrawerState.isOpen) {
      setServiceDrawerOpen(false);
    }
  });

  // Always start closed on app launch. Persisted open state caused the drawer
  // to unexpectedly reopen every time the main window booted.
  localStorage.setItem(SERVICE_DRAWER_STORAGE_KEY, '0');
  setServiceDrawerOpen(false, { persist: false });
  updateServiceDrawerCurrentUser(window.appState?.currentUser || null);
  updateServiceDrawerHealthSync(window.appState?.healthStatus || null);
}

function ensureDebugRequestModal() {
  if (debugRequestModalState.initialized) {
    return debugRequestModalState.elements;
  }

  const overlay = document.getElementById('debug-request-modal');
  const subtitle = document.getElementById('debug-request-modal-subtitle');
  const body = document.getElementById('debug-request-modal-body');
  const copyBtn = document.getElementById('debug-request-copy-btn');
  const closeBtn = document.getElementById('debug-request-close-btn');

  if (!overlay || !subtitle || !body || !copyBtn || !closeBtn) {
    debugRequestModalState.elements = {};
    return debugRequestModalState.elements;
  }

  const hide = () => {
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    setNativeOverlayInteractionSuppressed('debug-request-modal', false);
  };

  closeBtn.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      hide();
    }
  });
  copyBtn.addEventListener('click', async () => {
    const text = debugRequestModalState.jsonText || '';
    if (!text) {
      return;
    }
    try {
      if (window.electronAPI?.copyToClipboard) {
        await window.electronAPI.copyToClipboard(text);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      window.showNotification?.('Copied request JSON to clipboard', 'success');
    } catch (error) {
      window.showNotification?.(
        `Failed to copy request JSON: ${error?.message || error}`,
        'error',
      );
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('visible')) {
      hide();
    }
  });

  debugRequestModalState.elements = {
    overlay,
    subtitle,
    body,
  };
  debugRequestModalState.initialized = true;
  return debugRequestModalState.elements;
}

function showDebugRequestModal(payload = {}) {
  const elements = ensureDebugRequestModal();
  if (!elements.overlay) {
    return;
  }

  const normalizedJson =
    typeof payload?.json === 'string'
      ? payload.json
      : JSON.stringify(payload?.json ?? {}, null, 2);
  const subtitleParts = [
    typeof payload?.model === 'string' && payload.model ? payload.model : null,
    typeof payload?.requestPhase === 'string' && payload.requestPhase
      ? `phase=${payload.requestPhase}`
      : null,
    typeof payload?.requestId === 'string' && payload.requestId
      ? `request=${payload.requestId}`
      : null,
  ].filter(Boolean);

  debugRequestModalState.jsonText = normalizedJson;
  elements.subtitle.textContent =
    typeof payload?.subtitle === 'string' && payload.subtitle
      ? payload.subtitle
      : subtitleParts.join(' • ');
  elements.body.textContent = normalizedJson;
  elements.overlay.classList.add('visible');
  elements.overlay.setAttribute('aria-hidden', 'false');
  setNativeOverlayInteractionSuppressed('debug-request-modal', true);
}

// Dev-only marketplace auto-approve toggle. The row ships hidden; it is
// revealed only when main confirms a dev build, and the checkbox always
// mirrors main's effective (clamped) value.
async function initAutoApproveToggle() {
  const row = document.getElementById('auto-approve-row');
  const toggle = document.getElementById('auto-approve-toggle');
  if (!row || !toggle || !window.electronAPI?.getMarketplaceAutoApprove) {
    return;
  }
  try {
    const result = await window.electronAPI.getMarketplaceAutoApprove();
    if (!result?.success || result.isDevBuild !== true) {
      return;
    }
    toggle.checked = result.enabled === true;
    row.style.display = '';
  } catch (error) {
    console.warn('[Renderer] Failed to read marketplace auto-approve state:', error);
  }
}

async function setDebugModeEnabled(enabled, options = {}) {
  const { persistToOwui = true } = options;
  const normalized = Boolean(enabled);
  debugModeState.enabled = normalized;

  const toggle = document.getElementById('debug-mode-toggle');
  if (toggle) {
    toggle.checked = normalized;
  }

  if (!persistToOwui || !window.electronAPI?.owui?.setDebugMode) {
    return;
  }

  try {
    await window.electronAPI.owui.setDebugMode(normalized);
  } catch (error) {
    console.warn('[Renderer] Failed to propagate debug mode to OWUI:', error);
  }
}

function ensureDbRepairModal() {
  if (dbRepairModalState.initialized) {
    return dbRepairModalState.elements;
  }

  if (!document.getElementById('db-repair-modal-style')) {
    const style = document.createElement('style');
    style.id = 'db-repair-modal-style';
    style.textContent = `
      .db-repair-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(4, 8, 12, 0.72);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 12000;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s ease, visibility 0.2s ease;
      }
      .db-repair-modal-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      .db-repair-modal {
        width: min(480px, 92vw);
        background: linear-gradient(180deg, #353a3f 0%, #2f3438 100%);
        color: var(--text-primary, #e5e5e5);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        padding: 22px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
      }
      .db-repair-icon-wrap {
        width: 56px;
        height: 56px;
        margin: 0 auto 14px auto;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.12);
        border: 1px solid rgba(245, 158, 11, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .db-repair-icon-wrap svg {
        width: 28px;
        height: 28px;
        stroke: #f59e0b;
        fill: none;
      }
      .db-repair-modal h2 {
        margin: 0 0 10px 0;
        text-align: center;
        font-size: 24px;
        font-weight: 650;
      }
      .db-repair-modal p {
        margin: 0 0 10px 0;
        line-height: 1.5;
        color: #b7bdc5;
        text-align: center;
      }
      .db-repair-detail-title {
        margin-top: 12px;
        margin-bottom: 6px;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #8e97a3;
      }
      .db-repair-detail {
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(13, 18, 24, 0.58);
        border: 1px solid rgba(255, 255, 255, 0.08);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        color: #aab2bc;
        word-break: break-word;
      }
      .db-repair-progress {
        margin-top: 12px;
        display: none;
        align-items: center;
        gap: 10px;
        background: rgba(13, 18, 24, 0.58);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 10px 12px;
      }
      .db-repair-progress.visible {
        display: flex;
      }
      .db-repair-spinner {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        border: 2px solid rgba(74, 222, 128, 0.3);
        border-top-color: #76e19b;
        animation: db-repair-spin 0.8s linear infinite;
      }
      @keyframes db-repair-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .db-repair-progress-text {
        font-size: 13px;
        color: #c1c8d1;
      }
      .db-repair-actions {
        margin-top: 16px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .db-repair-btn {
        border-radius: 9px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease;
      }
      .db-repair-btn:hover {
        opacity: 0.92;
      }
      .db-repair-btn-cancel {
        background: rgba(17, 24, 31, 0.9);
        color: #c6ccd4;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .db-repair-btn-start {
        background: #76e19b;
        color: #10231a;
        border: 1px solid rgba(118, 225, 155, 0.45);
      }
      .db-repair-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      [data-theme="light"] .db-repair-modal-overlay {
        background: rgba(2, 6, 11, 0.38);
      }
      [data-theme="light"] .db-repair-modal {
        background: linear-gradient(180deg, #f5f7fa 0%, #eef2f5 100%);
        color: #1f2937;
        border-color: rgba(15, 23, 42, 0.12);
      }
      [data-theme="light"] .db-repair-modal p {
        color: #4b5563;
      }
      [data-theme="light"] .db-repair-detail {
        background: rgba(226, 232, 240, 0.75);
        color: #475569;
        border-color: rgba(15, 23, 42, 0.12);
      }
      [data-theme="light"] .db-repair-progress {
        background: rgba(226, 232, 240, 0.75);
        border-color: rgba(15, 23, 42, 0.12);
      }
      [data-theme="light"] .db-repair-btn-cancel {
        background: #e5e7eb;
        color: #374151;
        border-color: rgba(15, 23, 42, 0.12);
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement('div');
  overlay.className = 'db-repair-modal-overlay';
  overlay.innerHTML = `
    <div class="db-repair-modal" role="dialog" aria-modal="true" aria-labelledby="db-repair-title">
      <div class="db-repair-icon-wrap" aria-hidden="true">
        <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 9v4"></path>
          <path d="M12 17h.01"></path>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        </svg>
      </div>
      <h2 id="db-repair-title">Database Corruption Detected.</h2>
      <p>Oops. Your local chat database is having issues, and needs to be repaired.</p>
      <p>A backup is created first. Repair can take a few minutes for large databases.</p>
      <div class="db-repair-detail-title">Detected Error Signature</div>
      <div class="db-repair-detail" id="db-repair-detail"></div>
      <div class="db-repair-progress" id="db-repair-progress">
        <div class="db-repair-spinner"></div>
        <div class="db-repair-progress-text" id="db-repair-progress-text">Repairing database... this may take a few minutes.</div>
      </div>
      <div class="db-repair-actions">
        <button class="db-repair-btn db-repair-btn-cancel" id="db-repair-cancel-btn">Not Now</button>
        <button class="db-repair-btn db-repair-btn-start" id="db-repair-start-btn">Repair Now</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const detail = overlay.querySelector('#db-repair-detail');
  const progress = overlay.querySelector('#db-repair-progress');
  const progressText = overlay.querySelector('#db-repair-progress-text');
  const cancelBtn = overlay.querySelector('#db-repair-cancel-btn');
  const startBtn = overlay.querySelector('#db-repair-start-btn');

  const resolvePrompt = (value) => {
    if (!dbRepairModalState.resolver) return;
    const resolver = dbRepairModalState.resolver;
    dbRepairModalState.resolver = null;
    resolver(value);
  };

  cancelBtn.addEventListener('click', () => {
    if (dbRepairModalState.running) return;
    overlay.classList.remove('visible');
    resolvePrompt(false);
  });

  startBtn.addEventListener('click', () => {
    if (dbRepairModalState.running) return;
    resolvePrompt(true);
  });

  dbRepairModalState.elements = {
    overlay,
    detail,
    progress,
    progressText,
    cancelBtn,
    startBtn,
  };
  dbRepairModalState.initialized = true;
  return dbRepairModalState.elements;
}

function setDbRepairModalRunning(isRunning, message) {
  const elements = ensureDbRepairModal();
  dbRepairModalState.running = isRunning;
  elements.cancelBtn.disabled = isRunning;
  elements.startBtn.disabled = isRunning;
  elements.progress.classList.toggle('visible', isRunning);
  if (isRunning && message) {
    elements.progressText.textContent = message;
  }
}

function hideDbRepairModal() {
  const elements = ensureDbRepairModal();
  elements.overlay.classList.remove('visible');
  setDbRepairModalRunning(false);
}

function syncControlPlaneToggleActive(isActive) {
  const controlPlaneToggle = document.getElementById('control-plane-toggle');
  if (!controlPlaneToggle) {
    return;
  }
  controlPlaneToggle.classList.toggle('active', Boolean(isActive));
  controlPlaneToggle.setAttribute('aria-pressed', String(Boolean(isActive)));
}

window.syncControlPlaneToggleActive = syncControlPlaneToggleActive;

function ensureControlPlaneTabActive() {
  try {
    if (typeof window.switchTab === 'function') {
      window.switchTab('control');
      return;
    }

    if (window.appState) {
      window.appState.activeTab = 'control';
    }
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((content) => content.classList.remove('active'));
    document.getElementById('control-tab')?.classList.add('active');
    syncControlPlaneToggleActive(true);
    window.syncOwuiHosts?.();
  } catch (error) {
    console.warn('[DB Repair] Could not switch to control tab before showing modal:', error);
  }
}

window.ensureControlPlaneTabActive = ensureControlPlaneTabActive;

function openControlPlaneIntegrations() {
  ensureControlPlaneTabActive();

  const integrationsButton = document.getElementById('view-mcp-servers-btn');
  if (integrationsButton) {
    integrationsButton.click();
    return;
  }

  if (window.appState) {
    window.appState.controlPlaneView = 'mcp-servers';
  }
  window.refreshToolsCountForHealthyServers?.({ forceRender: true });
}

window.openControlPlaneIntegrations = openControlPlaneIntegrations;

function showDbRepairPrompt(matchPreview) {
  const elements = ensureDbRepairModal();
  ensureControlPlaneTabActive();
  elements.detail.textContent = matchPreview;
  elements.overlay.classList.add('visible');
  setDbRepairModalRunning(false);
  return new Promise((resolve) => {
    dbRepairModalState.resolver = resolve;
  });
}

async function handleDbCorruptionDetected(payload) {
  if (!payload || payload.detected !== true) {
    return;
  }

  const signature = payload.signature || "unknown";
  if (dbCorruptionPromptState.active) {
    return;
  }
  if (dbCorruptionPromptState.lastSignature === signature) {
    return;
  }

  dbCorruptionPromptState.active = true;
  dbCorruptionPromptState.lastSignature = signature;

  const matchPreview = Array.isArray(payload.matches) && payload.matches.length > 0
    ? payload.matches[0]
    : "Detected SQLite corruption signature in Open WebUI logs.";

  const userConfirmedRepair = await showDbRepairPrompt(matchPreview);

  if (!userConfirmedRepair) {
    hideDbRepairModal();
    dbCorruptionPromptState.active = false;
    return;
  }
  setDbRepairModalRunning(true, 'Repairing database... this may take a few minutes.');

  try {
    const result = await window.electronAPI.repairOpenWebuiDb({
      reason: "user-confirmed",
      manageContainer: true,
      restartContainerAfterRepair: false,
    });

    if (result && result.success) {
      hideDbRepairModal();
      const backupPath = result.backup?.db ? ` Backup: ${result.backup.db}` : "";
      const sqliteNotice = result.sqliteAutoInstalled
        ? " sqlite3 was installed automatically via Homebrew."
        : "";
      if (window.showNotification) {
        window.showNotification(`Database repair completed.${sqliteNotice}${backupPath} Restarting services...`, "success");
      }
      const restartResult = await window.electronAPI.dockerRestart();
      if (restartResult && restartResult.success === false) {
        window.showNotification?.(
          `Repair succeeded but restart failed: ${restartResult.error || "unknown error"}`,
          "error",
        );
      }
      dbCorruptionPromptState.active = false;
      return;
    }

    const errorMessage = result?.error || "Unknown database repair error";
    hideDbRepairModal();
    if (window.showNotification) {
      window.showNotification(`Database repair failed: ${errorMessage}`, "error");
    }

    const backupPath = result?.backup?.db;
    if (backupPath) {
      const shouldRollback = window.confirm(
        `Repair failed.\n\nAttempt rollback from backup?\n${backupPath}`,
      );
      if (shouldRollback) {
        setDbRepairModalRunning(true, 'Rolling back from backup... this may take a few minutes.');
        const modalElements = ensureDbRepairModal();
        modalElements.overlay.classList.add('visible');
        const rollbackResult = await window.electronAPI.rollbackOpenWebuiDbRepair({
          backupDbPath: backupPath,
        });
        hideDbRepairModal();
        if (rollbackResult?.success) {
          window.showNotification?.("Rollback completed from latest backup", "success");
          if (window.electronAPI?.apiHealthCheck) {
            await window.electronAPI.apiHealthCheck();
          }
        } else {
          window.showNotification?.(
            `Rollback failed: ${rollbackResult?.error || "unknown error"}`,
            "error",
          );
        }
      }
    }
  } catch (error) {
    hideDbRepairModal();
    window.showNotification?.(`Database repair error: ${error.message}`, "error");
  } finally {
    dbCorruptionPromptState.active = false;
  }
}

function setupDbCorruptionListener() {
  if (!window.electronAPI?.onDbCorruptionDetected) {
    return;
  }

  window.electronAPI.onDbCorruptionDetected((payload) => {
    void handleDbCorruptionDetected(payload);
  });

  if (window.electronAPI?.detectOpenWebuiDbCorruption) {
    setTimeout(async () => {
      try {
        const initialResult = await window.electronAPI.detectOpenWebuiDbCorruption({
          reason: "renderer-startup",
          forceScan: true,
          forceBroadcast: false,
        });
        if (initialResult?.detected) {
          await handleDbCorruptionDetected(initialResult);
        }
      } catch (error) {
        console.warn("[Health] Initial DB corruption detection failed:", error);
      }
    }, 1000);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Loading renderer components...');
  await syncMainWindowFullscreenState();
  ensureDebugRequestModal();
  try {
    const initialDebugMode = await window.electronAPI?.owui?.getDebugMode?.();
    await setDebugModeEnabled(Boolean(initialDebugMode), { persistToOwui: false });
  } catch (error) {
    console.warn('[Renderer] Failed to read initial global debug mode:', error);
    await setDebugModeEnabled(false, { persistToOwui: false });
  }
  void initAutoApproveToggle();

  if (window.electronAPI?.onOwuiDebugRequestModal) {
    window.electronAPI.onOwuiDebugRequestModal((payload) => {
      showDebugRequestModal(payload);
    });
  }

  if (window.electronAPI?.onOwuiDebugModeChanged) {
    window.electronAPI.onOwuiDebugModeChanged((payload) => {
      void setDebugModeEnabled(Boolean(payload?.enabled), { persistToOwui: false });
    });
  }

  // Register switch-to-tab listener EARLY - before any async operations
  // This ensures we can receive the message from main process when launched with a specific tab
  if (window.electronAPI && window.electronAPI.onSwitchToTab) {
    console.log('[Renderer] Registering switch-to-tab listener (early)');
    window.electronAPI.onSwitchToTab((tab) => {
      console.log('[Renderer] Received request to switch to tab:', tab);
      // Use a small delay to ensure switchTab is available from chat-tab.js
      setTimeout(() => {
        if (window.switchTab) {
          console.log('[Renderer] Calling switchTab with:', tab);
          window.switchTab(tab);
        } else {
          console.error('[Renderer] window.switchTab not available!');
        }
      }, 100);
    });
  }

  // Set up find-in-page result forwarding from OWUI views
  if (window.electronAPI?.setupFindInPageForwarding) {
    window.electronAPI.setupFindInPageForwarding().catch(() => {});
  }

  // Tab management IPC listeners
  if (window.electronAPI?.onOpenNewChatTab) {
    window.electronAPI.onOpenNewChatTab((payload = {}) => {
      const requestId =
        typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
      const options = requestId ? payload.options || {} : payload || {};
      let opened = false;
      let error = null;
      try {
        opened = window.openNewChatTab?.(options) !== false;
        if (typeof window.openNewChatTab !== 'function') {
          opened = false;
          error = 'Chat tab system not available.';
        }
      } catch (requestError) {
        opened = false;
        error = requestError?.message || String(requestError);
      }
      if (requestId) {
        window.electronAPI.completeOpenNewChatTabRequest?.({
          requestId,
          opened,
          error,
        });
      }
    });
  }
  if (window.electronAPI?.onCloseActiveTab) {
    window.electronAPI.onCloseActiveTab(() => {
      if (window.closeActiveTab) window.closeActiveTab();
    });
  }
  if (window.electronAPI?.onSwitchToTabIndex) {
    window.electronAPI.onSwitchToTabIndex((index) => {
      const fullId = window.tabBar?.getTabAtIndex(index);
      if (fullId && window.switchTab) window.switchTab(fullId);
    });
  }
  if (window.electronAPI?.onSwitchTabNext) {
    window.electronAPI.onSwitchTabNext(() => {
      const activeTab = window.appState?.activeTab || 'chat';
      const next = window.tabBar?.getNextTab(activeTab);
      if (next && window.switchTab) window.switchTab(next);
    });
  }
  if (window.electronAPI?.onSwitchTabPrev) {
    window.electronAPI.onSwitchTabPrev(() => {
      const activeTab = window.appState?.activeTab || 'chat';
      const prev = window.tabBar?.getPrevTab(activeTab);
      if (prev && window.switchTab) window.switchTab(prev);
    });
  }

  // Restore persisted conversation tabs
  const saved = window.loadPersistedTabState?.();
  if (saved?.tabOrder?.length) {
    const savedChatMeta = saved.tabMeta?.chat;
    if (savedChatMeta) {
      const state = window.appState;
      if (state?.tabMeta?.chat) {
        const restoredChatTitle = savedChatMeta.customTitle || savedChatMeta.autoTitle || savedChatMeta.title || 'Chat';
        state.tabMeta.chat.title = savedChatMeta.title || state.tabMeta.chat.title;
        state.tabMeta.chat.customTitle = savedChatMeta.customTitle || null;
        state.tabMeta.chat.autoTitle = savedChatMeta.autoTitle || null;
        window.tabBar?.updateTitle('chat', restoredChatTitle);
        if (savedChatMeta.modelIdentity) {
          state.tabMeta.chat.modelIdentity = savedChatMeta.modelIdentity;
          window.tabBar?.setModelIdentity?.('chat', savedChatMeta.modelIdentity);
        }
      }
    }

    const maxVisibleTabs = window.tabBar?.MAX_VISIBLE_TABS || 5;
    let restoredVisibleTabCount = 1;
    const restoredTabIds = new Set(['chat']);

    for (const tabId of saved.tabOrder) {
      if (tabId === 'control' || tabId === 'chat') continue;
      if (restoredVisibleTabCount >= maxVisibleTabs) break;
      const meta = saved.tabMeta?.[tabId];
      if (!meta) continue;
      const url = meta.url || 'http://localhost:3789';
      const restoredTitle = meta.customTitle || meta.autoTitle || meta.title || 'Chat';
      const opened = window.openConversationTab?.(url, tabId, {
        title: meta.title || restoredTitle,
        type: meta.type || 'chat',
        skipSwitch: true,
        deferLoad: meta.attentionRequired !== true,
        unread: meta.unread === true,
        attentionRequired: meta.attentionRequired === true,
      });
      if (opened === false) continue;
      restoredVisibleTabCount += 1;
      restoredTabIds.add(tabId);
      const state = window.appState;
      if (state?.tabMeta?.[tabId]) {
        state.tabMeta[tabId].title = meta.title || state.tabMeta[tabId].title;
        state.tabMeta[tabId].customTitle = meta.customTitle || null;
        state.tabMeta[tabId].autoTitle = meta.autoTitle || null;
        window.tabBar?.updateTitle(tabId, restoredTitle);
        if (meta.modelIdentity) {
          state.tabMeta[tabId].modelIdentity = meta.modelIdentity;
          window.tabBar?.setModelIdentity?.(tabId, meta.modelIdentity);
        }
      }
    }
    if (saved.activeTab && saved.activeTab !== 'chat' && saved.activeTab !== 'control') {
      const savedActiveTabId = saved.activeTab.replace('conversation-', '');
      if (restoredTabIds.has(savedActiveTabId)) {
        setTimeout(() => {
          if (window.switchTab) window.switchTab(saved.activeTab);
        }, 200);
      }
    }
  }

  // Initialize state first (from window.appState set by state.js)
  const state = window.appState;
  if (!state) {
    console.error('State not initialized!');
    return;
  }

  // Initialize MCP badge with 0
  if (window.updateMcpBadge) {
    window.updateMcpBadge([]);
  }

  // Set up MCP badge hover listeners
  if (window.setupMcpBadgeHover) {
    window.setupMcpBadgeHover();
  }

  await initializeApp();
  setupEventListeners();
  setupDockerStatusListener();
  setupHealthStatusListener();
  setupMcpServerToggleListener();
  setupMcpDisableModesListener();
  setupMarketplaceLinksChangedListener();
  setupMcpRestartListener();
  setupOAuthFlowListener();
  setupStoppingServicesListener();
  setupDbCorruptionListener();

  // Start checking for updates
  if (window.startUpdateChecking) {
    window.startUpdateChecking();
  }

  // Listen for release channel changes
  if (window.electronAPI.onClearUpdateState) {
    window.electronAPI.onClearUpdateState(() => {
      console.log('Release channel changed - clearing update state and rechecking');
      state.updateAvailable = false;
      state.updateInfo = null;
      state.updatePromptedKey = null;
      state.updatePrep = {
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
      };
      if (window.electronAPI.cancelUpdatePreparation) {
        window.electronAPI.cancelUpdatePreparation().catch((error) => {
          console.warn('[Update] Failed to cancel preparation after channel change:', error.message);
        });
      }
      if (window.hideUpdateButton) window.hideUpdateButton();
      if (window.checkForAppUpdates) window.checkForAppUpdates();
    });
  }

  // Always load chat interface - the retry logic in chat-tab.js will handle
  // cases where the backend isn't ready yet (shows loading spinner)
  if (window.loadChatInterface) {
    window.loadChatInterface();
  }

  // Get initial health status
  console.log('[Renderer] Fetching initial health status...');
  try {
    const healthStatus = await window.electronAPI.getHealthStatus();
    console.log('[Renderer] Initial health status response:', healthStatus);

    if (healthStatus && !healthStatus.error) {
      if (healthStatus.stale) {
        state.healthStatus = null;
        state.healthStatusStale = true;
        state.lastHealthSequence = 0;
        console.warn(
          `[Renderer] Initial health status is stale (reason=${healthStatus.staleReason || 'unknown'}); waiting for live update`,
        );

        if (window.updateMcpBadge) {
          window.updateMcpBadge([]);
        }
        if (window.updateMcpServersList) {
          window.updateMcpServersList();
        }
        updateServiceDrawerHealthSync(null);
      } else {
        state.healthStatus = healthStatus;
        state.healthStatusStale = false;
        const initialSequence = Number(
          healthStatus?.sync?.sequence ??
            healthStatus?.sync?.last_health_status_sequence,
        );
        if (Number.isFinite(initialSequence) && initialSequence > 0) {
          state.lastHealthSequence = Math.floor(initialSequence);
        }
        console.log(`[Renderer] Initial health status loaded: ${healthStatus.summary?.healthy}/${healthStatus.summary?.total} healthy`);
        if (window.updateMcpBadgeWithHealth) {
          window.updateMcpBadgeWithHealth();
        }
        if (window.updateMcpServersList) {
          window.updateMcpServersList();
        }
        if (window.refreshToolsCountForHealthyServers) {
          window.refreshToolsCountForHealthyServers({
            reason: 'initial-health-load',
          });
        }
        updateServiceDrawerHealthSync(healthStatus);
      }
    } else {
      console.warn('[Renderer] Health status not available yet:', healthStatus?.error);
      updateServiceDrawerHealthSync(null);
    }
  } catch (err) {
    console.error('[Renderer] Failed to get initial health status:', err);
    updateServiceDrawerHealthSync(null);
  }
});

async function initializeApp() {
  const state = window.appState;
  window.showLoading('Initializing...');

  try {
    // Load build info using extracted component
    if (window.renderBuildBadge) {
      await window.renderBuildBadge();
    }

    // Load environment variables
    const envResult = await window.electronAPI.loadEnv();
    if (envResult.success) {
      state.env = envResult.data;
      if (window.updateEnvSummary) window.updateEnvSummary();
    }

    await refreshServiceDrawerCurrentUser();

    // Load MCP servers
    const serversResult = await window.electronAPI.loadMcpServers();
    if (serversResult.success) {
      state.servers = serversResult.data;
      await loadMcpToggles();
      await checkHostModeSupport();
      if (window.updateMcpServersList) window.updateMcpServersList();

      // Fetch tool counts for healthy servers on initial load
      // Use setTimeout to ensure mcp-servers.js has loaded and registered the function
      setTimeout(() => {
        if (window.refreshToolsCountForHealthyServers) {
          console.log('[Init] Fetching initial tool counts for healthy servers...');
          window.refreshToolsCountForHealthyServers({
            forceRefresh: true,
            reason: 'app-init',
          });
        }
      }, 100);
    } else {
      if (window.updateMcpBadge) window.updateMcpBadge([]);
    }

    // Get initial Docker status
    const statusResult = await window.electronAPI.dockerStatus();
    if (window.updateDockerStatus) window.updateDockerStatus(statusResult);
  } catch (error) {
    console.error('Initialization error:', error);
    if (window.showNotification) {
      window.showNotification('Failed to initialize application', 'error');
    }
  }

  window.hideLoading();
}

async function runServiceDrawerActionInControlPlane(action, options = {}) {
  if (typeof action !== 'function') {
    return;
  }

  const activateControlPlane = options.activateControlPlane !== false;
  if (activateControlPlane && window.appState?.activeTab !== 'control') {
    window.ensureControlPlaneTabActive?.();
  }

  return action();
}

async function openHostMcpBridgeConfigFromServiceDrawer() {
  window.ensureControlPlaneTabActive?.();
  await waitForNextAnimationFrame();
  if (window.openHostMcpBridgeConfigModal) {
    void window.openHostMcpBridgeConfigModal();
  }
}

function setupEventListeners() {
  const state = window.appState;

  // Double-click handler for window maximize/restore
  const header = document.querySelector('.header');
  if (header) {
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, .mcp-badge, .status-indicator, .tab-btn, .update-button')) {
        return;
      }
      if (window.electronAPI?.toggleMaximize) {
        window.electronAPI.toggleMaximize();
      }
    });
  }

  // Update button
  const updateButton = document.getElementById('update-button');
  if (updateButton && window.handleUpdateClick) {
    updateButton.addEventListener('click', window.handleUpdateClick);
  }

  const controlPlaneToggle = document.getElementById('control-plane-toggle');
  if (controlPlaneToggle) {
    controlPlaneToggle.addEventListener('click', () => {
      window.ensureControlPlaneTabActive?.();
    });
  }

  const mcpBadge = document.getElementById('mcp-badge');
  if (mcpBadge) {
    mcpBadge.addEventListener('click', () => {
      window.openControlPlaneIntegrations?.();
    });
  }

  // Service drawer
  initServiceDrawer();

  // Quick actions
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      void runServiceDrawerActionInControlPlane(startServices);
    });
  }

  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.addEventListener('click', stopServices);

  const restartBtn = document.getElementById('restart-btn');
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      void runServiceDrawerActionInControlPlane(restartServices);
    });
  }

  const debugBtn = document.getElementById('debug-btn');
  if (debugBtn && window.collectDebugInfo) {
    debugBtn.addEventListener('click', () => {
      void runServiceDrawerActionInControlPlane(window.collectDebugInfo, {
        activateControlPlane: false,
      });
    });
  }

  const debugModeToggle = document.getElementById('debug-mode-toggle');
  if (debugModeToggle) {
    debugModeToggle.addEventListener('change', (event) => {
      const nextEnabled = Boolean(event?.target?.checked);
      void setDebugModeEnabled(nextEnabled);
    });
  }

  const autoApproveToggle = document.getElementById('auto-approve-toggle');
  if (autoApproveToggle) {
    autoApproveToggle.addEventListener('change', async (event) => {
      const requested = Boolean(event?.target?.checked);
      try {
        const result =
          await window.electronAPI?.setMarketplaceAutoApprove?.(requested);
        // Snap to main's effective value: non-dev builds clamp to false.
        autoApproveToggle.checked = result?.success
          ? result.enabled === true
          : !requested;
      } catch (error) {
        console.warn('[Renderer] Failed to save marketplace auto-approve state:', error);
        autoApproveToggle.checked = !requested;
      }
    });
  }


  // NOTE: restart-servers-btn listener is handled in control-plane.js initControlPlaneV2
  // Removed duplicate listener here to fix 3-prompt bug

  const setupWizardBtn = document.getElementById('electron-app-btn');
  if (setupWizardBtn && window.launchGuidedSetup) {
    setupWizardBtn.addEventListener('click', () => {
      void runServiceDrawerActionInControlPlane(window.launchGuidedSetup);
    });
  }

  // Modal controls
  const closeConfigBtn = document.getElementById('close-config-btn');
  if (closeConfigBtn && window.hideConfiguration) {
    closeConfigBtn.addEventListener('click', window.hideConfiguration);
  }

  const cancelConfigBtn = document.getElementById('cancel-config-btn');
  if (cancelConfigBtn && window.hideConfiguration) {
    cancelConfigBtn.addEventListener('click', window.hideConfiguration);
  }

  const saveConfigBtn = document.getElementById('save-config-btn');
  if (saveConfigBtn && window.saveConfiguration) {
    saveConfigBtn.addEventListener('click', window.saveConfiguration);
  }

  // Close modals on background click
  const configModal = document.getElementById('config-modal');
  if (configModal && window.hideConfiguration) {
    configModal.addEventListener('click', (e) => {
      if (e.target.id === 'config-modal') window.hideConfiguration();
    });
  }

  // Service logs buttons
  document.querySelectorAll('.service-logs-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const service = e.currentTarget.dataset.service;
      if (window.openServiceLogsPanel) {
        window.openServiceLogsPanel(service);
      }
    });
  });

  const hostMcpBridgeConfigBtn = document.getElementById('host-mcp-bridge-config-btn');
  if (hostMcpBridgeConfigBtn) {
    hostMcpBridgeConfigBtn.addEventListener('click', openHostMcpBridgeConfigFromServiceDrawer);
  }

  // Listen for IPC messages to open conversation tabs
  if (window.electronAPI && window.electronAPI.onOpenConversationTab) {
    window.electronAPI.onOpenConversationTab((url, conversationId, options = {}) => {
      console.log('Received request to open conversation tab:', url, conversationId, options);
      if (window.openConversationTabOrReuseActive) {
        void window.openConversationTabOrReuseActive(url, conversationId, options);
      } else if (window.openConversationTab) {
        window.openConversationTab(url, conversationId, options);
      }
    });
  }

  if (window.electronAPI?.onAttachDetachedConversation) {
    window.electronAPI.onAttachDetachedConversation((payload = {}) => {
      void (async () => {
        let result = {
          success: false,
          error: 'Detached conversation attach handler is unavailable',
        };

        if (window.attachDetachedConversationToTab) {
          result = await window.attachDetachedConversationToTab(payload);
        }

        window.electronAPI?.completeConversationAttach?.(payload.requestId, result);
      })();
    });
  }
}

function setupDockerStatusListener() {
  if (window.electronAPI && window.electronAPI.onDockerStatusUpdate) {
    window.electronAPI.onDockerStatusUpdate((status) => {
      if (window.updateDockerStatus) window.updateDockerStatus(status);
    });
  }
}

function setupHealthStatusListener() {
  console.log('[Renderer] Setting up health status listener...');
  const state = window.appState;

  if (window.electronAPI && window.electronAPI.onHealthStatusUpdate) {
    window.electronAPI.onHealthStatusUpdate(async (healthStatus) => {
      if (!healthStatus || healthStatus.error || !healthStatus.servers) {
        console.warn('[Health] Ignoring invalid health status payload:', healthStatus);
        return;
      }

      const incomingSequence = Number(healthStatus?.sync?.sequence);
      const lastSequence = Number(state.lastHealthSequence || 0);
      if (Number.isFinite(incomingSequence) && incomingSequence > 0) {
        if (incomingSequence <= lastSequence) {
          console.log(
            `[Health] Ignoring stale health update sequence=${incomingSequence} last=${lastSequence}`,
          );
          return;
        }
        state.lastHealthSequence = Math.floor(incomingSequence);
      }

      console.log('[Health] Received health status update:', healthStatus);
      console.log(
        `[Health] Summary: ${healthStatus.summary?.healthy}/${healthStatus.summary?.total} healthy (sequence=${healthStatus?.sync?.sequence ?? 'n/a'})`,
      );

      // Check if the server list has changed
      const healthServerNames = Object.keys(healthStatus.servers || {}).sort();
      const currentServerNames = [...new Set(state.servers.map((s) => s.id))].sort();

      const serversChanged = healthServerNames.length !== currentServerNames.length ||
        !healthServerNames.every((name, i) => name === currentServerNames[i]);

      if (serversChanged) {
        console.log('[Health] Server list changed, reloading from disk...');

        const serversResult = await window.electronAPI.loadMcpServers();
        if (serversResult.success) {
          state.servers = serversResult.data;
          await loadMcpToggles();
          await checkHostModeSupport();
        }
      }

      // Check if health status actually changed to avoid unnecessary re-renders
      const oldHealthJSON = state.healthStatus ? JSON.stringify(state.healthStatus.servers) : '';
      const newHealthJSON = JSON.stringify(healthStatus.servers);
      const healthActuallyChanged = oldHealthJSON !== newHealthJSON;

      state.healthStatus = healthStatus;
      state.healthStatusStale = false;
      if (window.syncPendingMcpOperationsFromHealthStatus) {
        window.syncPendingMcpOperationsFromHealthStatus(healthStatus);
      }
      updateServiceDrawerHealthSync(healthStatus);

      // Always update the badge (lightweight)
      if (window.updateMcpBadgeWithHealth) {
        window.updateMcpBadgeWithHealth();
      }

      // Only re-render the full server list if health status actually changed
      // This prevents flickering during hover when health polling occurs
      if (healthActuallyChanged || serversChanged) {
        if (window.updateMcpServersList) window.updateMcpServersList();
        console.log('[Health] UI updated with new health status');
      }

      // ALWAYS refresh tools on every health update, not just when health changes
      // This ensures tool counts stay in sync even if only tool config changed
      if (window.refreshToolsCountForHealthyServers) {
        window.refreshToolsCountForHealthyServers({
          forceRender: healthActuallyChanged || serversChanged,
          reason: healthActuallyChanged || serversChanged
            ? 'health-changed'
            : 'health-heartbeat',
        });
      }
    });
    console.log('[Renderer] Health status listener registered successfully');
  } else {
    console.error('[Renderer] electronAPI.onHealthStatusUpdate not available!');
  }
}

function setupMcpRestartListener() {
  console.log('[Renderer] Setting up MCP restart listener...');

  if (window.electronAPI && window.electronAPI.onMcpRestartStarted && window.electronAPI.onMcpRestartComplete) {
    window.electronAPI.onMcpRestartStarted(() => {
      console.log('[MCP Restart] Agent-initiated restart detected...');
      window.showLoading('Restarting MCP servers (agent initiated)...');
    });

    window.electronAPI.onMcpRestartComplete(async (data) => {
      console.log('[MCP Restart] Agent-initiated restart completed:', data);
      window.hideLoading();

      if (data.success) {
        window.showNotification('MCP servers restarted successfully!', 'success');

        const serversResult = await window.electronAPI.loadMcpServers();
        if (serversResult.success) {
          window.appState.servers = serversResult.data;
          await loadMcpToggles();
          await checkHostModeSupport();
          if (window.updateMcpServersList) window.updateMcpServersList();
        }
      } else {
        window.showNotification(`MCP restart failed: ${data.error}`, 'error');
      }
    });

    console.log('[Renderer] MCP restart listener registered successfully');
  } else {
    console.log('[Renderer] MCP restart listeners not available');
  }
}

// A marketplace publish/unpublish succeeded somewhere (usually a chat-side
// tool): if a control-plane publish-state view is CURRENTLY visible, refresh
// it so Published badges never go stale on screen. Hidden views need nothing —
// every navigation path already re-fetches links.
function setupMarketplaceLinksChangedListener() {
  if (!window.electronAPI?.onMarketplaceLinksChanged) {
    return;
  }
  window.electronAPI.onMarketplaceLinksChanged(() => {
    const state = window.appState;
    if (!state || state.activeTab !== 'control') {
      return;
    }
    // Don't yank a menu out from under the pointer: an open card dropdown
    // defers the refresh to the existing navigation hooks.
    if (document.querySelector('.mcp-card-dropdown.visible')) {
      return;
    }
    const preserveScroll = (listSelector, refresh) => {
      const list = document.querySelector(listSelector);
      const scrollTop = list ? list.scrollTop : 0;
      refresh();
      if (!scrollTop) {
        return;
      }
      // The refresh re-renders asynchronously; retry the restore briefly
      // (bounded one-shots after a rare, user-gated event — not a timer loop).
      let attempts = 0;
      const restore = () => {
        const restored = document.querySelector(listSelector);
        if (restored && restored.scrollHeight > restored.clientHeight) {
          restored.scrollTop = scrollTop;
          return;
        }
        if (attempts++ < 5) {
          setTimeout(restore, 120);
        }
      };
      setTimeout(restore, 120);
    };
    if (state.controlPlaneView === 'agent-skills') {
      preserveScroll('#skills-list', () => window.showAgentSkillsView?.({ refresh: true }));
    } else if (state.controlPlaneView === 'agents-tab') {
      preserveScroll('#agents-tab-list', () => window.AgentsTabModule?.show?.());
    }
  });
}

function setupMcpDisableModesListener() {
  if (!window.electronAPI?.onMcpDisableModesChanged) {
    return;
  }

  window.electronAPI.onMcpDisableModesChanged((payload) => {
    const state = window.appState;
    if (payload?.modes && typeof payload.modes === 'object') {
      state.disableModes = payload.modes;
    }
    if (window.updateMcpServersList) {
      window.updateMcpServersList();
    }
  });
}

function setupMcpServerToggleListener() {
  if (!window.electronAPI?.onMcpServerToggled) {
    return;
  }

  window.electronAPI.onMcpServerToggled(async ({ server_id, enabled }) => {
    if (!server_id) {
      return;
    }

    const state = window.appState;
    state.toggles = state.toggles && typeof state.toggles === 'object'
      ? { ...state.toggles, [server_id]: Boolean(enabled) }
      : { [server_id]: Boolean(enabled) };
    // PORTICO-410: an enable always lifts a hard disable main-side; mirror it.
    if (enabled && state.disableModes && typeof state.disableModes === 'object') {
      delete state.disableModes[server_id];
    }
    if (window.applyLocalMcpToggleState) {
      window.applyLocalMcpToggleState(server_id, Boolean(enabled));
    }

    await checkHostModeSupport();
    if (window.updateMcpServersList) {
      window.updateMcpServersList();
    }
    if (window.updateMcpBadgeWithHealth) {
      window.updateMcpBadgeWithHealth();
    }
  });
}

function setupOAuthFlowListener() {
  if (window.setupBackendModalListeners) {
    window.setupBackendModalListeners({ label: 'Control Panel' });
    return;
  }

  console.log('[Renderer] Backend modal listener runtime not available');
}

function setupStoppingServicesListener() {
  console.log('[Renderer] Setting up stopping services listener...');

  if (window.electronAPI && window.electronAPI.onStoppingServices) {
    window.electronAPI.onStoppingServices(() => {
      console.log('[Renderer] Stopping services notification received');
      // Show loading overlay with stopping message
      window.showLoading('Stopping services before exit...');
    });
    console.log('[Renderer] Stopping services listener registered successfully');
  } else {
    console.log('[Renderer] Stopping services listener not available');
  }
}

// Docker operations - using correct API methods from preload.js
async function startServices() {
  if (window.startServicesWithLogs) {
    await window.startServicesWithLogs();
  } else {
    window.showLoading('Starting services...');

    try {
      const result = await window.electronAPI.dockerStart();
      if (result.success) {
        window.showNotification('Services started successfully', 'success');
      } else {
        window.showNotification(`Failed to start services: ${result.error}`, 'error');
        console.error('Start failed details:', result.details);
      }
    } catch (error) {
      window.showNotification(`Error: ${error.message}`, 'error');
    }

    window.hideLoading();
  }
}

async function stopServices() {
  if (window.stopServicesWithLogs) {
    await window.stopServicesWithLogs();
  } else {
    window.showLoading('Stopping services...');

    try {
      const result = await window.electronAPI.dockerStop();
      if (result.success) {
        window.showNotification('Services stopped successfully', 'success');
      } else {
        window.showNotification(`Failed to stop services: ${result.error}`, 'error');
        console.error('Stop failed details:', result.details);
      }
    } catch (error) {
      window.showNotification(`Error: ${error.message}`, 'error');
    }

    window.hideLoading();
  }
}

async function restartServices() {
  if (window.restartServicesWithLogs) {
    await window.restartServicesWithLogs();
  } else {
    window.showLoading('Restarting services...');

    try {
      const result = await window.electronAPI.dockerRestart();
      if (result.success) {
        window.showNotification('Services restarted successfully', 'success');
      } else {
        window.showNotification(`Failed to restart services: ${result.error}`, 'error');
        console.error('Restart failed details:', result.details);
      }
    } catch (error) {
      window.showNotification(`Error: ${error.message}`, 'error');
    }

    window.hideLoading();
  }
}

// Load MCP toggle state
// PORTICO-410: load the hard-disable sidecar map alongside the toggles. Fail-open
// to the previous in-memory value (worst case: badges show SOFT).
async function loadMcpDisableModes() {
  const state = window.appState;
  try {
    const result = await window.electronAPI?.loadMcpDisableModes?.();
    if (result?.success && result.data && typeof result.data === 'object') {
      state.disableModes = result.data;
    } else if (!state.disableModes || typeof state.disableModes !== 'object') {
      state.disableModes = {};
    }
  } catch (error) {
    console.warn('Failed to load MCP disable modes:', error);
    if (!state.disableModes || typeof state.disableModes !== 'object') {
      state.disableModes = {};
    }
  }
}

async function loadMcpToggles() {
  const state = window.appState;
  const previousToggles = state.toggles && typeof state.toggles === 'object'
    ? { ...state.toggles }
    : {};
  await loadMcpDisableModes();
  try {
    const result = await window.electronAPI.loadMcpToggles();
    if (result.success && result.data) {
      state.toggles = result.data;
    } else if (result?.data && Object.keys(result.data).length > 0) {
      console.warn('loadMcpToggles returned warning path; using returned data:', result?.error);
      state.toggles = result.data;
    } else if (Object.keys(previousToggles).length > 0) {
      console.warn('loadMcpToggles failed; retaining previous in-memory toggles:', result?.error);
      state.toggles = previousToggles;
    } else {
      console.warn("loadMcpToggles returned fallback path:", result?.error);
      state.toggles = {};
      state.servers.forEach((server) => {
        state.toggles[server.id] = server.isCore === true;
      });
    }
  } catch (error) {
    console.error('Failed to load MCP toggles:', error);
    if (Object.keys(previousToggles).length > 0) {
      state.toggles = previousToggles;
      return;
    }
    state.toggles = {};
    state.servers.forEach((server) => {
      state.toggles[server.id] = server.isCore === true;
    });
  }
}

// Check HOST_MODE support
async function checkHostModeSupport() {
  const state = window.appState;
  try {
    const result = await window.electronAPI.checkHostMode();
    if (result.success) {
      state.hostModeSupported = result.supported;
      console.log('HOST_MODE supported:', state.hostModeSupported);
    } else {
      state.hostModeSupported = false;
    }
  } catch (error) {
    console.log('HOST_MODE check failed, assuming not supported:', error);
    state.hostModeSupported = false;
  }
}

// Make startServices available globally
window.startServices = startServices;
window.stopServices = stopServices;
window.restartServices = restartServices;
window.checkHostModeSupport = checkHostModeSupport;
window.runServiceDrawerActionInControlPlane = runServiceDrawerActionInControlPlane;
window.setServiceDrawerOpen = setServiceDrawerOpen;
window.toggleServiceDrawer = toggleServiceDrawer;
window.updateServiceDrawerHealthSync = updateServiceDrawerHealthSync;
