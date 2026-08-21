// OAuth screen module for guided setup
// Handles OAuth authorization flow for servers that require it

const {
  serverRequiresConfigurationBeforeOAuth,
} = require('../../../services/guided-setup/server-requirements');

// Module state
let oauthScreenState = {
  servers: [],           // Array of {server, metadata, status}
  currentIndex: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  resolveFlow: null,
  setupState: null,
  callbacks: {},
  queueStarted: false,
  flowLocked: false,
  pendingAutoStartIndex: null
};
let oauthReadinessPollToken = 0;

const OAUTH_SERVER_PRIORITY = ['glean', 'google workspace', 'atlassian'];
// Consent, SSO, and MFA are user-driven. Keep the callback listener alive until
// the provider completes or the user explicitly chooses Retry or Skip.
const GUIDED_SETUP_OAUTH_FLOW_TIMEOUT_MS = null;

function getOauthDisplayName(server) {
  return (server?.display_name || server?.name || '').trim();
}

function sortOauthServers(servers) {
  return [...servers].sort((a, b) => {
    const aName = getOauthDisplayName(a);
    const bName = getOauthDisplayName(b);
    const aPriority = OAUTH_SERVER_PRIORITY.indexOf(aName.toLowerCase());
    const bPriority = OAUTH_SERVER_PRIORITY.indexOf(bName.toLowerCase());
    const aRank = aPriority === -1 ? OAUTH_SERVER_PRIORITY.length : aPriority;
    const bRank = bPriority === -1 ? OAUTH_SERVER_PRIORITY.length : bPriority;

    if (aRank !== bRank) {
      return aRank - bRank;
    }

    return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
  });
}

function createOauthScreenItem(server) {
  return {
    server,
    metadata: {
      id: server.id,
      name: server.name,
      display_name: server.display_name || server.name,
      description: server.description,
      icon: server.icon,
      logoKind: server.logoKind || server.logo_kind || null
    },
    status: 'pending',
    preConfigured: false,
    postAuthSyncState: 'idle',
    postAuthToolCount: 0,
    postAuthSyncError: null,
  };
}

async function analyzeOAuthServers(oauthServers = []) {
  const sortedServers = sortOauthServers(oauthServers || []);
  const items = sortedServers.map(createOauthScreenItem);
  const completedServerIds = [];

  for (const item of items) {
    try {
      const tokenCheck = await window.electronAPI?.checkOAuthTokensExist?.(item.server.id);
      if (tokenCheck?.exists) {
        item.status = 'done';
        item.preConfigured = true;
        completedServerIds.push(item.server.id);
      }
    } catch (error) {
      console.warn(`[screen-oauth] Failed to check tokens for ${item.server.id}:`, error);
    }
  }

  const pendingServers = items
    .filter((item) => item.status === 'pending')
    .map((item) => item.server);

  return {
    items,
    servers: sortedServers,
    pendingServers,
    completedServerIds,
    pendingCount: pendingServers.length,
    completedCount: completedServerIds.length,
  };
}

function syncCompletedOauthServers(setupState, completedServerIds = []) {
  if (!setupState?.completedOAuthServers?.clear || !setupState?.completedOAuthServers?.add) {
    return;
  }

  setupState.completedOAuthServers.clear();
  completedServerIds.forEach((serverId) => {
    setupState.completedOAuthServers.add(serverId);
    setupState?.skippedOAuthServers?.delete?.(serverId);
  });
}

function isOauthStageActive() {
  const stage = document.getElementById('stage-oauth');
  return Boolean(stage && stage.classList.contains('active'));
}

function renderOAuthReadinessState({ title, message, progressPercent = 0, error = null }) {
  const content = document.getElementById('oauth-stage-content');
  if (!content) return;

  if (error) {
    content.innerHTML = `
      <div class="setup-readiness-card">
        <div class="setup-readiness-title">${title || 'Authorization setup is blocked.'}</div>
        <div class="setup-readiness-error">${error}</div>
        <div class="setup-readiness-message">Return to the prereqs step, let setup finish, then try again.</div>
        <div>
          <button class="btn btn-secondary" type="button" id="oauth-readiness-back-btn">Go to Prereqs</button>
        </div>
      </div>
    `;
    const backBtn = document.getElementById('oauth-readiness-back-btn');
    if (backBtn) {
      backBtn.onclick = () => {
        if (typeof window.navigateToStep === 'function') {
          window.navigateToStep('prerequisites');
        }
      };
    }
    return;
  }

  content.innerHTML = `
    <div class="setup-readiness-card">
      <div class="setup-readiness-title">${title || 'Preparing authorization environment...'}</div>
      <div class="setup-readiness-message">${message || 'We are finishing the minimal Docker assets needed for the OAuth stack.'}</div>
      <div class="setup-readiness-progress">
        <div class="setup-readiness-progress-fill" style="width: ${Math.max(0, Math.min(100, progressPercent))}%"></div>
      </div>
      <div class="setup-readiness-meta">${Math.max(0, Math.min(100, progressPercent))}% ready</div>
    </div>
  `;
}

async function waitForAuthorizeReadiness() {
  if (!window.electronAPI?.prerequisitesCheckAuthorizeReadiness) {
    return true;
  }

  const pollToken = ++oauthReadinessPollToken;
  renderOAuthReadinessState({
    title: 'Preparing authorization environment...',
    message: 'We are making sure the single-server OAuth stack is ready.'
  });

  while (pollToken === oauthReadinessPollToken && isOauthStageActive()) {
    const readiness = await window.electronAPI.prerequisitesCheckAuthorizeReadiness();
    if (!readiness?.success) {
      renderOAuthReadinessState({
        title: 'Authorization setup is blocked.',
        error: readiness?.error || 'Oops, something went wrong. Please navigate to the prereqs step.'
      });
      return false;
    }

    if (readiness.ready) {
      return true;
    }

    if (readiness.error) {
      renderOAuthReadinessState({
        title: 'Authorization setup is blocked.',
        error: readiness.error
      });
      return false;
    }

    renderOAuthReadinessState({
      title: 'Preparing authorization environment...',
      message: 'Almost there. We are finishing the minimal Docker assets needed to launch the OAuth stack.',
      progressPercent: readiness.progressPercent || 0
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return false;
}

function getOauthScreenServerId(target) {
  return target?.server?.id || target?.id || null;
}

function findOauthScreenItem(serverId) {
  return oauthScreenState.servers.find((item) => getOauthScreenServerId(item) === serverId) || null;
}

function updateOauthScreenRecoveryState(serverId, updates = {}) {
  const item = findOauthScreenItem(serverId);
  if (!item) return;
  Object.assign(item, updates);
  updateCurrentServerUI();
  updatePreviewBar();
}

function getCurrentOauthItem() {
  return oauthScreenState.servers[oauthScreenState.currentIndex] || null;
}

function isOauthItemProcessing(item) {
  return Boolean(item && ['starting', 'waiting'].includes(item.status));
}

function getCompletionDetail(item) {
  if (!item) return 'Connected.';
  if (item.postAuthSyncState === 'ready' && item.postAuthToolCount > 0) {
    return `${item.postAuthToolCount} tools are ready to use.`;
  }
  if (item.postAuthSyncState === 'deferred') {
    return 'Connected. Final checks will finish after setup completes.';
  }
  if (item.preConfigured) {
    return 'Already connected and ready to use.';
  }
  return 'Connected.';
}

function getRemainingPendingIndices(startIndex = oauthScreenState.currentIndex) {
  const pendingIndices = [];
  for (let i = startIndex + 1; i < oauthScreenState.servers.length; i += 1) {
    const item = oauthScreenState.servers[i];
    if (item && item.status === 'pending') {
      pendingIndices.push(i);
    }
  }
  return pendingIndices;
}

function syncCurrentOauthIndexToSetupState() {
  const nextIndex = Number(oauthScreenState.currentIndex);
  if (!Number.isInteger(nextIndex) || nextIndex < 0) {
    return;
  }
  if (oauthScreenState?.setupState) {
    oauthScreenState.setupState.currentOAuthIndex = nextIndex;
  }
}

function getLastTrackedOauthServerId(values) {
  const iterable = values instanceof Set
    ? Array.from(values)
    : Array.isArray(values)
      ? values
      : [];
  let lastId = null;

  iterable.forEach((value) => {
    const id = typeof value === 'string' ? value : getOauthScreenServerId(value);
    if (typeof id === 'string' && id.trim()) {
      lastId = id;
    }
  });

  return lastId;
}

function resolveCompletedOauthCurrentIndex(setupState) {
  const doneItems = oauthScreenState.servers
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.status === 'done');

  if (doneItems.length === 0) {
    return 0;
  }

  const rememberedIndex = Number(setupState?.currentOAuthIndex);
  if (
    Number.isInteger(rememberedIndex) &&
    rememberedIndex >= 0 &&
    rememberedIndex < oauthScreenState.servers.length &&
    oauthScreenState.servers[rememberedIndex]?.status === 'done'
  ) {
    return rememberedIndex;
  }

  const preferredServerIds = [
    getLastTrackedOauthServerId(setupState?.connectedOAuthServers),
    getLastTrackedOauthServerId(setupState?.completedOAuthServers),
  ];

  for (const serverId of preferredServerIds) {
    if (!serverId) continue;
    const preferredIndex = oauthScreenState.servers.findIndex(
      (item) => item?.status === 'done' && getOauthScreenServerId(item) === serverId,
    );
    if (preferredIndex !== -1) {
      return preferredIndex;
    }
  }

  return doneItems[doneItems.length - 1]?.index ?? doneItems[0].index;
}

function renderCompletedOauthRevisitScreen(setupState, callbacks = {}, analysis = {}) {
  oauthScreenState = {
    servers: analysis.items || [],
    currentIndex: 0,
    completedCount: analysis.completedCount || 0,
    skippedCount: 0,
    failedCount: 0,
    resolveFlow: null,
    setupState,
    callbacks,
    queueStarted: false,
    flowLocked: false,
    pendingAutoStartIndex: null,
  };

  renderOAuthStage(callbacks);
  oauthScreenState.currentIndex = resolveCompletedOauthCurrentIndex(setupState);
  syncCurrentOauthIndexToSetupState();
  updateCurrentServerUI();
  updatePreviewBar();
}

function scheduleAutoStartForCurrent() {
  const currentIndex = oauthScreenState.currentIndex;
  const item = getCurrentOauthItem();
  if (!item || item.status !== 'current' || oauthScreenState.flowLocked) {
    return;
  }
  if (oauthScreenState.pendingAutoStartIndex === currentIndex) {
    return;
  }

  oauthScreenState.pendingAutoStartIndex = currentIndex;
  setTimeout(() => {
    if (oauthScreenState.pendingAutoStartIndex !== currentIndex) {
      return;
    }
    oauthScreenState.pendingAutoStartIndex = null;

    const currentItem = getCurrentOauthItem();
    if (!currentItem || oauthScreenState.currentIndex !== currentIndex || oauthScreenState.flowLocked) {
      return;
    }
    if (currentItem.status !== 'current') {
      return;
    }

    handleAuthorize(oauthScreenState.setupState, oauthScreenState.callbacks);
  }, 0);
}

function showCompletedServerState(item = getCurrentOauthItem()) {
  if (!item) return;

  const container = document.getElementById('oauth-stage-testing-content');
  const testingPane = document.getElementById('oauth-stage-testing');
  const buttonsContainer = document.getElementById('oauth-stage-buttons');
  const progressSection = document.querySelector('.oauth-stage-progress');
  if (!container) return;

  const remainingPending = getRemainingPendingIndices(oauthScreenState.currentIndex);
  const allServersDone = oauthScreenState.servers.length > 0 &&
    oauthScreenState.servers.every((serverItem) => serverItem?.status === 'done');
  const showContinue = allServersDone;
  const showNext = !showContinue && remainingPending.length > 0;
  // Skip works down to the last remaining server (outage resilience); Skip All
  // is only offered while it would cover more than that one.
  const showSkip = !showContinue && remainingPending.length > 0;
  const showSkipRemaining = !showContinue && remainingPending.length > 1;
  const actionsDisabled = oauthScreenState.flowLocked;
  const successTitle = item.preConfigured ? 'Authorized' : 'Connected';

  if (buttonsContainer) buttonsContainer.style.display = 'none';
  if (progressSection) progressSection.style.display = 'none';
  if (testingPane) {
    testingPane.style.display = 'block';
    testingPane.classList.add('oauth-stage-testing-success');
  }

  container.innerHTML = `
    <div class="oauth-test-success oauth-test-success-compact">
      <div class="oauth-test-success-summary">
        <div class="oauth-test-success-icon">✓</div>
        <div class="oauth-test-success-copy">
          <div class="oauth-test-success-title">${escapeHtml(successTitle)}</div>
          <div class="oauth-test-success-detail">${escapeHtml(getCompletionDetail(item))}</div>
        </div>
      </div>
      <div class="oauth-test-success-actions">
        ${showSkip ? `<button class="btn btn-skip oauth-test-skip-btn" id="oauth-test-skip-btn" data-tooltip="You can always connect more integrations later." ${actionsDisabled ? 'disabled' : ''}>Skip</button>` : ''}
        ${showSkipRemaining ? `<button class="btn btn-skip oauth-test-skip-btn" id="oauth-test-skip-all-btn" data-tooltip="You can always connect more integrations later." ${actionsDisabled ? 'disabled' : ''}>Skip All</button>` : ''}
        ${(showNext || showContinue) ? `<button class="btn btn-primary oauth-test-next-btn" id="oauth-test-next-btn" ${actionsDisabled ? 'disabled' : ''}>${showContinue ? 'Continue →' : 'Next →'}</button>` : ''}
      </div>
    </div>
  `;

  const nextBtn = document.getElementById('oauth-test-next-btn');
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (showContinue) {
        proceedAfterOAuth(oauthScreenState.setupState, oauthScreenState.callbacks);
        return;
      }
      advanceToNextPendingServer();
    };
  }

  const skipBtn = document.getElementById('oauth-test-skip-btn');
  if (skipBtn) {
    skipBtn.onclick = () => skipNextPendingServer();
  }

  const skipAllBtn = document.getElementById('oauth-test-skip-all-btn');
  if (skipAllBtn) {
    skipAllBtn.onclick = () => skipAllRemainingServers(oauthScreenState.setupState, oauthScreenState.callbacks);
  }
}

function syncCurrentOauthPresentation() {
  const item = getCurrentOauthItem();
  if (!item) return;

  if (item.status === 'done') {
    showCompletedServerState(item);
    return;
  }

  const testingPane = document.getElementById('oauth-stage-testing');
  if (item.status === 'failed' && testingPane && testingPane.style.display !== 'none') {
    return;
  }
  if (isOauthItemProcessing(item) || oauthScreenState.flowLocked) {
    return;
  }

  hideTestingProgress();
}

function advanceToNextPendingServer() {
  if (oauthScreenState.flowLocked) {
    return;
  }
  const nextPending = findNextPendingServer(oauthScreenState.currentIndex, { wrap: false });
  if (nextPending === -1) {
    handleOAuthComplete(oauthScreenState.setupState, oauthScreenState.callbacks);
    return;
  }

  navigateToServer(nextPending, { autoStart: true });
}

function shouldAutoAdvanceAfterSuccess() {
  if (!isOauthStageActive()) {
    return false;
  }
  const currentItem = getCurrentOauthItem();
  if (!currentItem || currentItem.status !== 'done') {
    return false;
  }
  return findNextPendingServer(oauthScreenState.currentIndex, { wrap: false }) !== -1;
}

function skipNextPendingServer() {
  if (oauthScreenState.flowLocked) {
    return;
  }

  const nextPending = findNextPendingServer(oauthScreenState.currentIndex, { wrap: false });
  if (nextPending === -1) {
    handleOAuthComplete(oauthScreenState.setupState, oauthScreenState.callbacks);
    return;
  }

  const item = oauthScreenState.servers[nextPending];
  if (!item || item.status !== 'pending') {
    return;
  }

  item.status = 'skipped';
  oauthScreenState.skippedCount += 1;
  if (oauthScreenState.setupState?.skippedOAuthServers) {
    oauthScreenState.setupState.skippedOAuthServers.add(item.server.id);
  }

  oauthScreenState.callbacks?.addLog?.(`Skipped OAuth for ${item.metadata.display_name}`, 'info');
  updatePreviewBar();

  const nextAfterSkipped = findNextPendingServer(nextPending, { wrap: false });
  if (nextAfterSkipped === -1) {
    handleOAuthComplete(oauthScreenState.setupState, oauthScreenState.callbacks);
    return;
  }

  navigateToServer(nextAfterSkipped, { autoStart: true });
}

/**
 * Get status icon for preview card
 */
function getStatusIcon(status) {
  switch (status) {
    case 'current': return '●';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'skipped': return '⊘';
    case 'starting': return '⏳';
    default: return '○';  // pending
  }
}

/**
 * Initialize OAuth screen with servers
 * @param {Object} setupState - The setup state object
 * @param {Object} callbacks - Callback functions
 */
async function initOAuthScreen(setupState, callbacks = {}, options = {}) {
  console.log('[screen-oauth] Initializing OAuth screen');

  // Reset state
  oauthScreenState = {
    servers: [],
    currentIndex: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    resolveFlow: null,
    setupState,
    callbacks,
    queueStarted: false,
    flowLocked: false,
    pendingAutoStartIndex: null
  };

  const analysis = options.analysis || await analyzeOAuthServers(setupState.oauthServers || []);
  const oauthServers = analysis.servers;

  if (oauthServers.length === 0) {
    console.log('[screen-oauth] No OAuth servers to process');
    // Show message that there are no OAuth servers and proceed
    renderNoOAuthServersScreen(setupState, callbacks);
    return;
  }

  console.log(`[screen-oauth] Processing ${oauthServers.length} OAuth server(s)`);
  oauthScreenState.servers = analysis.items;
  oauthScreenState.completedCount = analysis.completedCount;
  syncCompletedOauthServers(setupState, analysis.completedServerIds);

  // Check if ALL servers are already configured
  const pendingServers = oauthScreenState.servers.filter(s => s.status === 'pending');

  if (pendingServers.length === 0) {
    console.log('[screen-oauth] All OAuth servers already have tokens - skipping OAuth stage');

    // Mark OAuth step as complete
    setupState.oauthStepRequired = false;
    setupState.completedSteps.oauth = true;
    if (callbacks.updateProgressTracker) {
      callbacks.updateProgressTracker();
    }

    await proceedAfterOAuth(setupState, callbacks);
    return { skipped: true };
  }

  console.log(`[screen-oauth] ${pendingServers.length} server(s) need OAuth, ${oauthScreenState.completedCount} already configured`);
  setupState.oauthStepRequired = true;

  // Render the OAuth stage UI
  renderOAuthStage(callbacks);

  // Find first server that needs OAuth (not pre-configured)
  const firstPendingIndex = oauthScreenState.servers.findIndex(s => s.status === 'pending');
  if (firstPendingIndex !== -1) {
    oauthScreenState.currentIndex = firstPendingIndex;
    oauthScreenState.servers[firstPendingIndex].status = 'current';
    syncCurrentOauthIndexToSetupState();
  }

  updateCurrentServerUI();
  updatePreviewBar();
  return { skipped: false };
}

/**
 * Render the OAuth stage preview bar
 * Shows server icons with status badges (checkmark/X) under the logo
 */
function renderPreviewBar() {
  const previewContainer = document.getElementById('oauth-stage-preview');
  if (!previewContainer) return;

  previewContainer.innerHTML = oauthScreenState.servers.map((item, index) => {
    const { metadata, status, preConfigured } = item;
    const iconSrc = metadata.icon || '';
    const name = metadata.display_name || metadata.name;
    const logoKind = getOAuthLogoKind(metadata);

    // Status badge HTML (checkmark or X under the logo)
    // Pre-configured servers get a special "preconfigured" class
    let statusBadge = '';
    if (status === 'done') {
      const badgeClass = preConfigured ? 'done preconfigured' : 'done';
      const tooltip = getStatusMessage(item);
      statusBadge = `<div class="oauth-preview-status-badge ${badgeClass}" title="${tooltip}">✓</div>`;
    } else if (status === 'failed') {
      statusBadge = '<div class="oauth-preview-status-badge failed">✗</div>';
    }

    const cardClass = preConfigured ? `${status} preconfigured` : status;

    return `
      <div class="oauth-stage-preview-card ${cardClass}" data-index="${index}">
        <div class="oauth-preview-icon-container">
          ${iconSrc ? `<img class="oauth-stage-preview-icon" data-logo-kind="${logoKind}" src="${iconSrc}" alt="${name}" onerror="this.style.display='none'" />` : ''}
          ${statusBadge}
        </div>
        <span class="oauth-stage-preview-name" title="${name}">${name}</span>
      </div>
    `;
  }).join('');

  // Add click handlers for navigation
  const cards = previewContainer.querySelectorAll('.oauth-stage-preview-card');
  cards.forEach((card, index) => {
    card.addEventListener('click', () => navigateToServer(index, { fromPreview: true }));
  });
}

/**
 * Update the preview bar status indicators
 * Adds/removes status badges (checkmark/X) under server logos
 */
function updatePreviewBar() {
  const cards = document.querySelectorAll('.oauth-stage-preview-card');
  cards.forEach((card, index) => {
    if (index < oauthScreenState.servers.length) {
      const item = oauthScreenState.servers[index];
      const cardClass = item.preConfigured ? `${item.status} preconfigured` : item.status;
      card.className = `oauth-stage-preview-card ${cardClass}`;

      // Update status badge under icon
      const iconContainer = card.querySelector('.oauth-preview-icon-container');
      if (iconContainer) {
        // Remove existing badge if any
        const existingBadge = iconContainer.querySelector('.oauth-preview-status-badge');
        if (existingBadge) {
          existingBadge.remove();
        }

        // Add new badge if done or failed
        if (item.status === 'done') {
          const badgeClass = item.preConfigured ? 'done preconfigured' : 'done';
          const tooltip = getStatusMessage(item);
          iconContainer.insertAdjacentHTML('beforeend', `<div class="oauth-preview-status-badge ${badgeClass}" title="${tooltip}">✓</div>`);
        } else if (item.status === 'failed') {
          iconContainer.insertAdjacentHTML('beforeend', '<div class="oauth-preview-status-badge failed">✗</div>');
        }
      }
    }
  });
}

/**
 * Update the current server display
 */
function updateCurrentServerUI() {
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item) return;

  const { metadata, server, status } = item;

  const icon = document.getElementById('oauth-stage-server-icon');
  const name = document.getElementById('oauth-stage-server-name');
  const description = document.getElementById('oauth-stage-server-description');
  const progress = document.getElementById('oauth-stage-progress-text');
  const statusText = document.getElementById('oauth-stage-status-text');

  if (icon && metadata.icon) {
    icon.src = metadata.icon;
    icon.dataset.logoKind = getOAuthLogoKind(metadata);
    icon.style.display = 'block';
  } else if (icon) {
    icon.removeAttribute('data-logo-kind');
    icon.style.display = 'none';
  }

  if (name) {
    name.textContent = metadata.display_name || metadata.name;
  }
  if (description) {
    description.textContent = metadata.description || 'This server requires OAuth authorization';
  }
  if (progress) {
    // Progress-based, not position-based: servers are priority-sorted, so a
    // lone remaining server can sit at index 0 with everything after it done
    // -- rendering "Server 1 of 5" while four are already connected.
    const total = oauthScreenState.servers.length;
    const processedCount = oauthScreenState.servers.filter((serverItem) =>
      ['done', 'failed', 'skipped'].includes(serverItem?.status),
    ).length;
    const isCurrentProcessed = ['done', 'failed', 'skipped'].includes(status);
    const position = Math.min(
      isCurrentProcessed ? processedCount : processedCount + 1,
      total,
    );
    progress.textContent = `Server ${position} of ${total}`;
  }
  if (statusText) {
    statusText.textContent = status === 'done' ? '' : getStatusMessage(item);
    statusText.style.display = statusText.textContent ? 'inline' : 'none';
  }

  updateNavigationButtons();
  syncCurrentOauthPresentation();
}

/**
 * Get status message for display
 */
function getStatusMessage(itemOrStatus, preConfigured = false) {
  const item =
    typeof itemOrStatus === 'object' && itemOrStatus !== null
      ? itemOrStatus
      : { status: itemOrStatus, preConfigured };
  const { status } = item;
  switch (status) {
    case 'current': return '';
    case 'starting': return 'Starting server...';
    case 'waiting': return 'Waiting for authorization...';
    case 'done':
      if (item.preConfigured) return 'Authorized';
      if (item.postAuthSyncState === 'ready' && item.postAuthToolCount > 0) {
        return `Authorization complete · ${item.postAuthToolCount} tools ready`;
      }
      if (item.postAuthSyncState === 'deferred') {
        return 'Authorized · full verification will finish after setup';
      }
      return 'Authorization complete';
    case 'failed': return 'Authorization failed';
    case 'skipped': return 'Skipped';
    default: return 'Pending';
  }
}

function getOAuthLogoKind(metadata = {}) {
  if (metadata.logoKind) {
    return metadata.logoKind;
  }

  const serverId = metadata.id || metadata.name || '';
  const porticoServerIds = new Set([
    'data-plat-mcp',
    'ownership-mcp',
    'teamworks-mcp',
  ]);

  return porticoServerIds.has(serverId) ? 'portico' : 'default';
}

/**
 * Update navigation button states
 */
function updateNavigationButtons() {
  const nextBtn = document.getElementById('oauth-stage-next-btn');
  const skipAllBtn = document.getElementById('oauth-stage-skip-all-btn');
  const authorizeBtn = document.getElementById('oauth-stage-authorize-btn');

  // Disable authorize for already processed servers
  const currentItem = oauthScreenState.servers[oauthScreenState.currentIndex];
  const isProcessed = currentItem && ['done', 'failed', 'skipped'].includes(currentItem.status);
  const isProcessing = isOauthItemProcessing(currentItem) || oauthScreenState.flowLocked;
  const hasLaterPending = findNextPendingServer(oauthScreenState.currentIndex, { wrap: false }) !== -1;

  if (authorizeBtn) {
    authorizeBtn.style.display = (isProcessed || oauthScreenState.queueStarted) ? 'none' : 'inline-flex';
    authorizeBtn.disabled = isProcessed || isProcessing;
    if (isProcessed) {
      if (currentItem.status === 'done') {
        authorizeBtn.textContent = 'Authorized ✓';
      } else if (currentItem.status === 'skipped') {
        authorizeBtn.textContent = 'Skipped';
      } else {
        authorizeBtn.textContent = 'Failed';
      }
    } else if (isProcessing) {
      authorizeBtn.textContent = 'Authorizing...';
    } else {
      authorizeBtn.textContent = 'Connect';
    }
  }

  // Skip must be available whenever the current card is actionable -- even
  // when it is the only or last pending server. Gating it on a LATER pending
  // server hid it exactly when a user most needed it: one flaky integration
  // left (e.g. a provider outage) meant no way past the Connect button.
  const canActOnCurrent = Boolean(currentItem) && !isProcessed && !isProcessing;

  if (nextBtn) {
    nextBtn.textContent = 'Skip';
    nextBtn.style.display = canActOnCurrent ? 'inline-flex' : 'none';
    nextBtn.disabled = isProcessing;
  }

  if (skipAllBtn) {
    skipAllBtn.textContent = 'Skip All';
    // Redundant when only the current server remains -- Skip covers it.
    skipAllBtn.style.display = (canActOnCurrent && hasLaterPending) ? 'inline-flex' : 'none';
    skipAllBtn.disabled = isProcessing;
  }
}

/**
 * Navigate to a specific server
 */
function navigateToServer(index, options = {}) {
  if (index < 0 || index >= oauthScreenState.servers.length) return;

  const currentItem = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (oauthScreenState.flowLocked || isOauthItemProcessing(currentItem)) {
    console.log('[screen-oauth] Cannot navigate while processing');
    return;
  }

  if (oauthScreenState.currentIndex === index) {
    syncCurrentOauthIndexToSetupState();
    syncCurrentOauthPresentation();
    return;
  }

  // Reset current to pending if it was just 'current'
  if (currentItem && currentItem.status === 'current') {
    currentItem.status = 'pending';
  }

  oauthScreenState.currentIndex = index;
  syncCurrentOauthIndexToSetupState();

  // Set new current status if not already processed
  const newItem = oauthScreenState.servers[index];
  if (newItem && !['done', 'failed', 'skipped'].includes(newItem.status)) {
    newItem.status = 'current';
  }

  updateCurrentServerUI();
  updatePreviewBar();

  const shouldAutoStart =
    Boolean(options.autoStart) ||
    (Boolean(options.fromPreview) && oauthScreenState.queueStarted && newItem?.status === 'current');

  if (shouldAutoStart) {
    scheduleAutoStartForCurrent();
  }
}

/**
 * Find next pending server
 */
function findNextPendingServer(startIndex = oauthScreenState.currentIndex, options = {}) {
  const { wrap = true } = options;
  for (let i = startIndex + 1; i < oauthScreenState.servers.length; i++) {
    if (oauthScreenState.servers[i].status === 'pending') {
      return i;
    }
  }

  if (wrap) {
    for (let i = 0; i < startIndex; i++) {
      if (oauthScreenState.servers[i].status === 'pending') {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Check if all servers are processed
 */
function areAllServersProcessed() {
  return oauthScreenState.servers.every(s => ['done', 'failed', 'skipped'].includes(s.status));
}

async function routeToRequiredConfigurationBeforeOAuth(item, setupState, callbacks = {}) {
  const serverId = item?.server?.id;
  if (
    !serverId ||
    !serverRequiresConfigurationBeforeOAuth(item.server) ||
    setupState?.configuredServers?.has?.(serverId) === true
  ) {
    return false;
  }

  const configIndex = Array.isArray(setupState?.serverConfigs)
    ? setupState.serverConfigs.findIndex((server) => server?.id === serverId)
    : -1;
  if (configIndex === -1 || typeof callbacks.loadServerConfiguration !== 'function') {
    throw new Error(
      `${item.metadata?.display_name || serverId} must be configured before authorization can start`,
    );
  }

  setupState.pendingOAuthConfigurationServerId = serverId;
  setupState.currentServerIndex = configIndex;
  callbacks.addLog?.(
    `Configure ${item.metadata?.display_name || serverId} before authorization`,
    'info',
  );
  await callbacks.loadServerConfiguration(configIndex);
  return true;
}

async function prepareForFreshOauthStart(serverId) {
  if (!window.electronAPI?.prepareOAuthStart) {
    console.warn(`[screen-oauth] prepareOAuthStart unavailable for ${serverId}; continuing without clearing bootstrap state`);
    return;
  }

  const prepareResult = await window.electronAPI.prepareOAuthStart(serverId);
  if (!prepareResult?.success) {
    throw new Error(
      prepareResult?.error || 'Failed to prepare fresh OAuth state',
    );
  }
  const tokenFilesCleared = Array.isArray(prepareResult.tokenFiles)
    ? prepareResult.tokenFiles.length
    : 0;
  const clientFilesCleared = Array.isArray(prepareResult.clientFiles)
    ? prepareResult.clientFiles.length
    : 0;

  console.log(
    `[screen-oauth] Prepared fresh OAuth flow for ${serverId}: preservedSecureRecord=true cleared=${Boolean(prepareResult.cleared)}, tokenFiles=${tokenFilesCleared}, clientFiles=${clientFilesCleared}`,
  );
}

/**
 * Handle authorize button click - Uses single-server testing infrastructure
 * This starts an isolated MCP server on a dedicated host port, performs OAuth, and verifies tokens
 */
async function handleAuthorize(setupState, callbacks = {}) {
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item || oauthScreenState.flowLocked) return;

  const serverId = item.server.id;
  try {
    if (await routeToRequiredConfigurationBeforeOAuth(item, setupState, callbacks)) {
      oauthScreenState.queueStarted = true;
      oauthScreenState.pendingAutoStartIndex = null;
      return;
    }
  } catch (error) {
    console.error(`[screen-oauth] Configuration prerequisite failed for ${serverId}:`, error);
    markCurrentAsFailed(error.message, callbacks);
    return;
  }

  console.log(`[screen-oauth] Starting OAuth for ${serverId}`);
  oauthScreenState.queueStarted = true;
  oauthScreenState.flowLocked = true;
  oauthScreenState.pendingAutoStartIndex = null;

  // Update status
  item.status = 'starting';
  item.postAuthSyncState = 'idle';
  item.postAuthToolCount = 0;
  item.postAuthSyncError = null;
  updateCurrentServerUI();
  updatePreviewBar();

  // Show testing progress UI
  showTestingProgress(item.metadata.display_name || serverId);

  if (callbacks.addLog) {
    callbacks.addLog(`Starting OAuth authorization for ${item.metadata.display_name}...`, 'info');
  }

  let singleServerStopped = false;
  let singleServerSessionId = null;
  // On success paths the single-server stack must be torn down BEFORE the
  // wizard advances: on the last server the advance chain enters finalize,
  // whose .env write takes the same global mutation lease the stop holds for
  // the duration of a docker compose down. Leaving the stop to the finally
  // let finalize start ~850ms ahead of a 2-3s lease hold and fail busy every
  // time. Mirrors the skip path, which already stops first.
  const stopSingleServerBeforeAdvance = async () => {
    if (singleServerStopped) return;
    try {
      console.log(
        `[screen-oauth] Stopping single MCP server for ${serverId} before advancing...`,
      );
      updateTestStep('verify', 'running', 'Cleaning up...');
      await window.electronAPI.stopSingleMcpServer(serverId, {
        sessionId: singleServerSessionId,
      });
    } catch (e) {
      console.warn('[screen-oauth] Failed to stop test server before advancing:', e);
    }
    updateTestStep('verify', 'success', 'Connected');
    singleServerStopped = true;
  };
  try {
    // Step 1: Start isolated test server and wait for OAuth ready
    updateTestStep('standalone', 'running', 'Preparing OAuth state...');
    await prepareForFreshOauthStart(serverId);
    updateTestStep('standalone', 'running', 'Getting things ready...');
    console.log(`[screen-oauth] Starting single MCP server for ${serverId}...`);

    const startResult = await window.electronAPI.startSingleMcpServer(
      serverId,
      { oauthMode: 'bootstrap' },
    );
    console.log(`[screen-oauth] Start server result:`, startResult);

    if (!startResult.success) {
      const startError = new Error(startResult.error || `Failed to start test server`);
      startError.code = startResult.errorCode || startResult.code || null;
      startError.details = startResult.details || null;
      startError.selectedFrontend = startResult.selectedFrontend || null;
      startError.probeDiagnostics = startResult.probeDiagnostics || null;
      startError.recoveryAttempted = Boolean(startResult.recoveryAttempted);
      throw startError;
    }
    singleServerSessionId = startResult.sessionId;
    updateTestStep('standalone', 'running', 'Preparing your sign-in...');

    if (callbacks.addLog) {
      callbacks.addLog(`Test server started for ${item.metadata.display_name}`, 'success');
    }

    // Wait for OAuth to be ready (polls OAuth status, not tool count)
    console.log(`[screen-oauth] Waiting for OAuth status...`);

    const oauthReadyResult = await waitForOAuthReady(
      serverId,
      90000,
      singleServerSessionId,
    );
    if (!oauthReadyResult.ready) {
      // Get container logs for debugging
      let containerLogs = '';
      try {
        const logsResult = await window.electronAPI.getWizardMcpServerLogs(
          serverId,
          100,
          { sessionId: singleServerSessionId },
        );
        containerLogs = logsResult.logs || '';
      } catch (e) {
        console.warn('[screen-oauth] Failed to get container logs:', e);
      }
      updateTestStep('standalone', 'failed', 'We could not get things ready');
      throw new Error(containerLogs || 'OAuth initialization timed out');
    }
    updateTestStep('standalone', 'success', 'Ready');

    if (callbacks.addLog) {
      callbacks.addLog(`OAuth ready`, 'success');
    }

    // Step 3: Get OAuth authorization URL (already have it from step 2)
    updateTestStep('oauth', 'running', 'Creating your sign-in link...');
    console.log(`[screen-oauth] Getting OAuth status from single-server stack...`);

    // Use the auth URL from step 2, or fetch fresh status
    let authUrl = oauthReadyResult.authUrl;

    // Get full OAuth status to check completion
    const oauthStatus = await window.electronAPI.getOAuthStatusSingle({
      sessionId: singleServerSessionId,
    });
    console.log(
      `[screen-oauth] Single-server OAuth status for ${serverId}: ` +
        `active=${oauthStatus?.active?.length || 0} ` +
        `waiting=${oauthStatus?.waiting_callback?.length || 0} ` +
        `completed=${oauthStatus?.completed?.length || 0} ` +
        `failed=${oauthStatus?.failed?.length || 0}`,
    );

    // Check if already authorized
    if (oauthStatus && oauthStatus.completed) {
      const completedServer = oauthStatus.completed.find(s => s.server_name === serverId);
      if (completedServer && completedServer.state === 'completed') {
        console.log(`[screen-oauth] Server ${serverId} is already authorized`);
        updateTestStep('oauth', 'success', 'Already authorized');
        if (callbacks.addLog) {
          callbacks.addLog(`${item.metadata.display_name} is already authorized!`, 'success');
        }
        // Skip to verification step
        await handleOAuthVerification(
          serverId,
          setupState,
          callbacks,
          item,
          singleServerSessionId,
        );
        // Tear down before advancing: on the last server the advance enters
        // finalize, which must not race this server's stop for the lease.
        await stopSingleServerBeforeAdvance();
        markCurrentAsDoneNoRestart(setupState, callbacks);
        return;
      }
    }

    // If we still don't have auth URL, try extracting from status or refreshing
    if (!authUrl) {
      authUrl = extractAuthUrlFromStatus(oauthStatus, serverId);
    }

    // If still no URL, try refreshing
    if (!authUrl) {
      console.log(`[screen-oauth] No auth URL, trying refresh...`);
      try {
        const refreshResult = await window.electronAPI.refreshOAuthUrlSingle(
          serverId,
          { sessionId: singleServerSessionId },
        );
        console.log(
          `[screen-oauth] Refresh result for ${serverId}: success=${refreshResult?.success === true}`,
        );
        if (refreshResult && refreshResult.success && refreshResult.authorization_url) {
          authUrl = refreshResult.authorization_url;
        }
      } catch (e) {
        console.warn('[screen-oauth] Refresh failed:', e);
      }
    }

    if (!authUrl) {
      updateTestStep('oauth', 'failed', 'We could not create the sign-in link');
      throw new Error('No authorization URL available - the server may not require OAuth or there was an error');
    }

    updateTestStep('oauth', 'success', 'Sign-in is ready');

    // Step 4: Open browser for authorization
    updateTestStep('browser', 'running', 'Opening your browser...');
    console.log(
      `[screen-oauth] Opening browser for ${serverId} (session=${singleServerSessionId})`,
    );

    await window.electronAPI.openExternal(authUrl, {
      kind: 'oauth',
      event: 'authorization_opened',
      serverId,
      sessionId: singleServerSessionId,
    });
    updateTestStep('browser', 'success', 'Browser open — please sign in');

    if (callbacks.addLog) {
      callbacks.addLog(`Please complete authorization in your browser`, 'info');
    }

    // Step 5: Poll for OAuth completion
    updateTestStep('poll', 'running', 'Waiting for you to sign in...');
    console.log(`[screen-oauth] Polling for OAuth completion...`);

    // Update status to waiting
    item.status = 'waiting';
    updatePreviewBar();

    let pollResult = null;
    try {
      while (true) {
        let manualPollAction = 'none';
        setPollWaitingControls({
          visible: true,
          pendingAction: manualPollAction,
          onRestart: () => {
            if (manualPollAction === 'none') {
              manualPollAction = 'restart';
              setPollWaitingControls({ visible: true, pendingAction: manualPollAction });
              updateTestStep('poll', 'running', 'Restarting sign-in...');
              if (callbacks.addLog) {
                callbacks.addLog('Restart requested while waiting for callback...', 'info');
              }
            }
          },
          onSkip: () => {
            if (manualPollAction === 'none') {
              manualPollAction = 'skip';
              setPollWaitingControls({ visible: true, pendingAction: manualPollAction });
              updateTestStep('poll', 'running', 'Skipping for now...');
              if (callbacks.addLog) {
                callbacks.addLog(`Skipping ${item.metadata.display_name} for now...`, 'info');
              }
            }
          }
        });

        const currentPollResult = await pollOAuthCompletionWithManualRestart(serverId, {
          sessionId: singleServerSessionId,
          timeoutMs: GUIDED_SETUP_OAUTH_FLOW_TIMEOUT_MS,
          chunkTimeoutMs: 2000,
          getManualAction: () => manualPollAction,
          onProgress: (elapsedSeconds, progress) => {
            if (manualPollAction === 'none') {
              const detail = progress?.checking
                ? 'Verifying your sign-in...'
                : 'Waiting for you to sign in...';
              updateTestStep('poll', 'running', `${detail} (${elapsedSeconds}s)`);
            }
          }
        });

        if (currentPollResult.restartRequested) {
          manualPollAction = 'none';
          updateTestStep('poll', 'running', 'Restarting sign-in...');
          if (callbacks.addLog) {
            callbacks.addLog('Restarting OAuth authorization flow...', 'info');
          }
          singleServerSessionId = await restartOAuthAuthorizationSession(
            serverId,
            singleServerSessionId,
            callbacks,
          );
          updateTestStep('browser', 'success', 'Browser open again — please sign in');
          updateTestStep('poll', 'running', 'Waiting for you to sign in...');
          item.status = 'waiting';
          updatePreviewBar();
          continue;
        }

        if (currentPollResult.skipRequested) {
          updateTestStep('poll', 'running', 'Skipping for now...');
          try {
            await window.electronAPI.stopSingleMcpServer(serverId, {
              sessionId: singleServerSessionId,
            });
            singleServerStopped = true;
            singleServerSessionId = null;
          } catch (e) {
            console.warn('[screen-oauth] Failed to stop standalone server during skip:', e);
          }
          oauthScreenState.flowLocked = false;
          skipCurrentServer(setupState, callbacks, {
            autoStartNext: oauthScreenState.queueStarted,
          });
          return;
        }

        pollResult = currentPollResult;
        break;
      }
    } finally {
      setPollWaitingControls({ visible: false });
    }

    console.log(
      `[screen-oauth] Poll result for ${serverId}: completed=${pollResult?.completed === true} failed=${pollResult?.failed === true} timeout=${pollResult?.timeout === true}`,
    );

    if (pollResult.failed) {
      updateTestStep('poll', 'failed', pollResult.server?.error_message || 'Sign-in did not finish');
      throw new Error(pollResult.server?.error_message || 'Authorization failed');
    }

    if (pollResult.timeout) {
      updateTestStep('poll', 'failed', 'Sign-in took too long');
      throw new Error('Authorization timeout - please try again');
    }

    if (!pollResult.completed) {
      updateTestStep('poll', 'failed', 'Sign-in was not completed');
      throw new Error('Authorization was not completed');
    }

    updateTestStep('poll', 'success', 'Signed in');

    if (callbacks.addLog) {
      callbacks.addLog(`Authorization successful!`, 'success');
    }

    // Verify terminal OAuth success also produced durable token and client files.
    const tokenCheck = await window.electronAPI.checkOAuthTokensExist(serverId);
    console.log(`[screen-oauth] Token verification for ${serverId}:`, tokenCheck);

    if (!tokenCheck.exists) {
      // Tokens not saved - OAuth didn't really complete
      // This happens with DCR OAuth when SDK times out before callback exchange
      console.log(`[screen-oauth] Tokens not found for ${serverId}, triggering re-auth...`);
      updateTestStep('poll', 'running', 'Trying one more time...');

      if (callbacks.addLog) {
        callbacks.addLog(`Re-authenticating ${item.metadata.display_name} (tokens not persisted)...`, 'info');
      }

      // Stop and restart to trigger fresh OAuth flow
      // User already authorized so this should auto-complete quickly
      try {
        await window.electronAPI.stopSingleMcpServer(serverId, {
          sessionId: singleServerSessionId,
        });
        singleServerSessionId = null;
        await new Promise(resolve => setTimeout(resolve, 2000));
        await prepareForFreshOauthStart(serverId);

        const restartResult = await window.electronAPI.startSingleMcpServer(
          serverId,
          { oauthMode: 'bootstrap' },
        );
        if (!restartResult.success) {
          throw new Error('Failed to restart for re-auth');
        }
        singleServerSessionId = restartResult.sessionId;

        // Wait for OAuth to be ready again
        const reAuthReady = await waitForOAuthReady(
          serverId,
          90000,
          singleServerSessionId,
        );
        if (!reAuthReady.ready) {
          throw new Error('Re-auth failed to initialize');
        }

        // Open browser for re-auth (should auto-approve since user already authorized)
        if (reAuthReady.authUrl) {
          console.log(
            `[screen-oauth] Opening browser for re-auth for ${serverId} (session=${singleServerSessionId})`,
          );
          await window.electronAPI.openExternal(reAuthReady.authUrl, {
            kind: 'oauth',
            event: 'reauthorization_opened',
            serverId,
            sessionId: singleServerSessionId,
          });
        }

        // Poll for completion again
        const reAuthPoll = await window.electronAPI.pollOAuthCompletionSingle(
          serverId,
          120000,
          { sessionId: singleServerSessionId },
        );
        if (!reAuthPoll.completed) {
          throw new Error('Re-authentication failed or timed out');
        }

        // Verify tokens exist this time
        const tokensExistNow = await window.electronAPI.checkOAuthTokensExist(serverId);
        if (!tokensExistNow.exists) {
          throw new Error(`Re-authentication completed but tokens still not saved (${tokensExistNow.reason})`);
        }

        console.log(`[screen-oauth] Re-auth successful, tokens verified for ${serverId}`);
        updateTestStep('poll', 'success', 'Signed in');

        if (callbacks.addLog) {
          callbacks.addLog(`Re-authentication successful!`, 'success');
        }
      } catch (reAuthError) {
        console.error(`[screen-oauth] Re-auth failed for ${serverId}:`, reAuthError);
        updateTestStep('poll', 'failed', 'That second sign-in attempt failed');
        throw new Error(`Re-authentication failed: ${reAuthError.message}`);
      }
    }

    // Handle token verification
    await handleOAuthVerification(
      serverId,
      setupState,
      callbacks,
      item,
      singleServerSessionId,
    );
    // Tear down before advancing: on the last server the advance enters
    // finalize, which must not race this server's stop for the lease.
    await stopSingleServerBeforeAdvance();
    markCurrentAsDoneNoRestart(setupState, callbacks);

  } catch (error) {
    console.error(`[screen-oauth] OAuth error for ${serverId}:`, error);

    // Show error in testing pane
    await showTestingError(error.message, serverId, {
      code: error.code,
      details: error.details,
      selectedFrontend: error.selectedFrontend,
      probeDiagnostics: error.probeDiagnostics,
      recoveryAttempted: error.recoveryAttempted,
      sessionId: singleServerSessionId,
    });

    if (callbacks.addLog) {
      callbacks.addLog(`OAuth failed for ${item.metadata.display_name}: ${error.message}`, 'error');
    }

    markCurrentAsFailed(error.message, callbacks);
  } finally {
    // Always cleanup - stop the single server
    try {
      if (!singleServerStopped) {
        console.log(`[screen-oauth] Stopping single MCP server for ${serverId}...`);
        await window.electronAPI.stopSingleMcpServer(serverId, {
          sessionId: singleServerSessionId,
        });
      }
    } catch (e) {
      console.warn('[screen-oauth] Failed to stop test server:', e);
    }
    oauthScreenState.flowLocked = false;
    if (shouldAutoAdvanceAfterSuccess()) {
      advanceToNextPendingServer();
    } else if (getCurrentOauthItem()?.status === 'done') {
      updateCurrentServerUI();
    }
  }
}

/**
 * Wait until OAuth token files are persisted to disk.
 * Uses IPC token check which validates both *_tokens.json and *_client.json.
 */
async function waitForOAuthTokensPersisted(serverId, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const pollIntervalMs = options.pollIntervalMs || 250;
  const onProgress = options.onProgress;
  const checkOAuthTokensExist = typeof options.checkOAuthTokensExist === 'function'
    ? options.checkOAuthTokensExist
    : (id) => window.electronAPI.checkOAuthTokensExist(id);
  const startTime = Date.now();
  let lastResult = { exists: false, reason: 'unknown' };

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await checkOAuthTokensExist(serverId);
      lastResult = result || lastResult;
      if (result?.exists) {
        return {
          persisted: true,
          elapsedMs: Date.now() - startTime,
          result
        };
      }
    } catch (error) {
      lastResult = { exists: false, reason: 'error', error: error.message };
    }

    if (onProgress) {
      onProgress(Math.round((Date.now() - startTime) / 1000), lastResult);
    }
    const remainingMs = timeoutMs - (Date.now() - startTime);
    if (remainingMs <= 0) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }

  return {
    persisted: false,
    elapsedMs: Date.now() - startTime,
    result: lastResult
  };
}

/**
 * Handle OAuth verification after successful authorization
 * Uses standalone stack only. The full app stack is not available yet during
 * guided setup, so fallback verification must defer until setup completes.
 */
async function handleOAuthVerification(
  serverId,
  setupState,
  callbacks,
  item,
  sessionId,
) {
  // Step 1: Wait for token files to be persisted to disk
  updateTestStep('verify', 'running', 'Saving your sign-in...');

  if (callbacks.addLog) {
    callbacks.addLog(`Waiting for tokens to persist...`, 'info');
  }

  const tokenPersistence = await waitForOAuthTokensPersisted(serverId, {
    timeoutMs: 15000,
    pollIntervalMs: 250,
    onProgress: (elapsedSeconds) => {
      updateTestStep('verify', 'running', `Saving your sign-in... (${elapsedSeconds}s)`);
    }
  });

  if (!tokenPersistence.persisted) {
    const reason = tokenPersistence.result?.reason || 'unknown';
    updateTestStep('verify', 'failed', 'We could not save your sign-in');
    throw new Error(`OAuth completed but tokens were not persisted (${reason})`);
  }

  console.log(
    `[screen-oauth] Tokens persisted for ${serverId} after ${Math.round(tokenPersistence.elapsedMs / 1000)}s`,
  );

  // Step 2: Give the standalone server a very short grace period to expose
  // tools. If it doesn't, treat the server as authorized and defer full tool
  // verification until the guided setup completes and the main app launches.
  updateTestStep('verify', 'running', 'Finishing up...');
  const verifyResult = await waitForServerHealthSingle(
    serverId,
    2000,
    sessionId,
  );

  if (verifyResult.healthy) {
    const toolCount = verifyResult.tools?.length || 0;
    updateOauthScreenRecoveryState(serverId, {
      postAuthSyncState: 'ready',
      postAuthToolCount: toolCount,
      postAuthSyncError: null,
    });

    updateTestStep('verify', 'success', 'Connected');
    if (callbacks.addLog) {
      callbacks.addLog(`Discovered ${toolCount} tools - OAuth successful!`, 'success');
    }

  } else {
    console.warn(
      `[screen-oauth] Standalone tool verification did not finish quickly for ${serverId}; deferring until setup completes`,
    );
    updateOauthScreenRecoveryState(serverId, {
      postAuthSyncState: 'deferred',
      postAuthToolCount: 0,
      postAuthSyncError: null,
    });
    updateTestStep('verify', 'success', 'Connected — finishing after setup');
    if (callbacks.addLog) {
      callbacks.addLog(
        `Tokens saved for ${item.metadata.display_name} — full tool verification will finish after setup completes`,
        'success',
      );
    }
  }

  // Advancing (markCurrentAsDoneNoRestart) is the CALLER's job, after it has
  // torn down the single-server stack: on the last server the advance chain
  // enters finalize, which contends for the same global mutation lease the
  // teardown holds. This function only verifies.
}

/**
 * Show testing progress UI
 * Keep preview cards and server info visible, hide only navigation controls
 */
function showTestingProgress(serverName) {
  const buttonsContainer = document.getElementById('oauth-stage-buttons');
  const progressSection = document.querySelector('.oauth-stage-progress');
  const testingPane = document.getElementById('oauth-stage-testing');

  // Hide only the navigation controls and authorize button
  if (buttonsContainer) buttonsContainer.style.display = 'none';
  if (progressSection) progressSection.style.display = 'none';

  // Keep preview cards and server info visible (don't hide them)
  // The testingTitle header is removed since server info stays visible

  if (testingPane) {
    testingPane.style.display = 'block';
    testingPane.classList.remove('oauth-stage-testing-success');
    renderTestingSteps();
  }
}

/**
 * Hide testing progress UI
 * Restore the hidden navigation controls
 */
function hideTestingProgress() {
  const buttonsContainer = document.getElementById('oauth-stage-buttons');
  const progressSection = document.querySelector('.oauth-stage-progress');
  const testingPane = document.getElementById('oauth-stage-testing');

  if (testingPane) {
    testingPane.style.display = 'none';
    testingPane.classList.remove('oauth-stage-testing-success');
  }
  if (buttonsContainer) buttonsContainer.style.display = 'block';
  if (progressSection) progressSection.style.display = 'flex';
}

/**
 * Render testing steps UI
 */
function renderTestingSteps() {
  const container = document.getElementById('oauth-stage-testing-content');
  if (!container) return;

  container.innerHTML = `
    <div class="oauth-test-steps">
      <div class="oauth-test-step" data-step="standalone">
        <div class="oauth-test-icon pending">○</div>
        <div class="oauth-test-content">
          <div class="oauth-test-title">Preparing</div>
          <div class="oauth-test-detail">Getting things ready...</div>
        </div>
      </div>
      <div class="oauth-test-step" data-step="oauth">
        <div class="oauth-test-icon pending">○</div>
        <div class="oauth-test-content">
          <div class="oauth-test-title">Getting sign-in ready</div>
          <div class="oauth-test-detail">Almost ready...</div>
        </div>
      </div>
      <div class="oauth-test-step" data-step="browser">
        <div class="oauth-test-icon pending">○</div>
        <div class="oauth-test-content">
          <div class="oauth-test-title">Open your browser</div>
          <div class="oauth-test-detail">Waiting to open...</div>
        </div>
      </div>
      <div class="oauth-test-step" data-step="poll">
        <div class="oauth-test-icon pending">○</div>
        <div class="oauth-test-content">
          <div class="oauth-test-title-row">
            <div class="oauth-test-title">Waiting for sign-in</div>
          </div>
          <div class="oauth-test-detail">Waiting...</div>
          <div class="oauth-test-action-row">
            <button
              class="oauth-restart-auth-btn"
              id="oauth-restart-auth-btn"
              type="button"
              style="display: none;"
            >
              Stuck? Retry
            </button>
            <button
              class="oauth-restart-auth-btn oauth-skip-auth-btn"
              id="oauth-skip-auth-btn"
              type="button"
              style="display: none;"
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
      <div class="oauth-test-step" data-step="verify">
        <div class="oauth-test-icon pending">○</div>
        <div class="oauth-test-content">
          <div class="oauth-test-title">Finishing up</div>
          <div class="oauth-test-detail">Saving your connection...</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Update a test step's status
 */
function updateTestStep(stepId, status, detail, tools) {
  const step = document.querySelector(`.oauth-test-step[data-step="${stepId}"]`);
  if (!step) return;

  const iconEl = step.querySelector('.oauth-test-icon');
  const detailEl = step.querySelector('.oauth-test-detail');

  // Update step active state
  document.querySelectorAll('.oauth-test-step').forEach(s => s.classList.remove('active'));
  if (status === 'running') {
    step.classList.add('active');
  }

  if (iconEl) {
    iconEl.className = `oauth-test-icon ${status}`;
    switch (status) {
      case 'running':
        iconEl.textContent = '◐';
        break;
      case 'success':
        iconEl.textContent = '✓';
        break;
      case 'failed':
        iconEl.textContent = '✗';
        break;
      default:
        iconEl.textContent = '○';
    }
  }

  if (detailEl) {
    detailEl.textContent = detail;

    // Add tools list if provided
    if (tools && tools.length > 0) {
      const toolsList = document.createElement('div');
      toolsList.className = 'oauth-test-tools-list';
      toolsList.innerHTML = tools.slice(0, 10).map(t => `
        <div class="oauth-test-tool-item">
          <span>✓</span> ${escapeHtml(typeof t === 'string' ? t : t.name || t)}
        </div>
      `).join('');
      if (tools.length > 10) {
        toolsList.innerHTML += `<div class="oauth-test-tool-item">+${tools.length - 10} more</div>`;
      }
      detailEl.appendChild(toolsList);
    }
  }
}

/**
 * Show/hide poll restart controls while waiting for callback.
 */
function setPollWaitingControls(options = {}) {
  const restartBtn = document.getElementById('oauth-restart-auth-btn');
  const skipBtn = document.getElementById('oauth-skip-auth-btn');
  if (!restartBtn && !skipBtn) return;

  const visible = Boolean(options.visible);
  if (!visible) {
    [restartBtn, skipBtn].forEach((button) => {
      if (!button) return;
      button.style.display = 'none';
      button.disabled = false;
      button.onclick = null;
    });
    if (restartBtn) {
      restartBtn.textContent = 'Stuck? Retry';
    }
    if (skipBtn) {
      skipBtn.textContent = 'Skip for now';
    }
    return;
  }

  const pendingAction = typeof options.pendingAction === 'string'
    ? options.pendingAction
    : (options.inProgress ? 'restart' : 'none');
  const actionsDisabled = pendingAction !== 'none';

  if (restartBtn) {
    restartBtn.style.display = 'inline-flex';
    restartBtn.disabled = actionsDisabled;
    restartBtn.textContent = pendingAction === 'restart' ? 'Retrying...' : 'Stuck? Retry';
    restartBtn.onclick = null;
    if (!actionsDisabled && typeof options.onRestart === 'function') {
      restartBtn.onclick = () => options.onRestart();
    }
  }

  if (skipBtn) {
    if (options.hideSkip === true) {
      skipBtn.style.display = 'none';
      skipBtn.disabled = false;
      skipBtn.textContent = 'Skip for now';
      skipBtn.onclick = null;
      return;
    }

    skipBtn.style.display = 'inline-flex';
    skipBtn.disabled = actionsDisabled;
    skipBtn.textContent = pendingAction === 'skip' ? 'Skipping...' : 'Skip for now';
    skipBtn.onclick = null;
    if (!actionsDisabled && typeof options.onSkip === 'function') {
      skipBtn.onclick = () => options.onSkip();
    }
  }
}

function setPollRestartControls(options = {}) {
  setPollWaitingControls({
    ...options,
    hideSkip: true,
  });
}

/**
 * Poll OAuth completion in short chunks so users can restart immediately when callback gets stuck.
 */
async function pollOAuthCompletionWithManualRestart(serverId, options = {}) {
  const requestedTimeoutMs = Object.prototype.hasOwnProperty.call(options, 'timeoutMs')
    ? options.timeoutMs
    : GUIDED_SETUP_OAUTH_FLOW_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : null;
  const chunkTimeoutMs = options.chunkTimeoutMs || 2000;
  const getManualAction = typeof options.getManualAction === 'function'
    ? options.getManualAction
    : () => (typeof options.shouldRestart === 'function' && options.shouldRestart() ? 'restart' : 'none');
  const shouldRestart = typeof options.shouldRestart === 'function'
    ? options.shouldRestart
    : () => false;
  const onProgress = options.onProgress;
  const startTime = Date.now();
  let lastResult = { success: false, timeout: true };

  while (timeoutMs === null || Date.now() - startTime < timeoutMs) {
    const requestedAction = getManualAction();
    if (requestedAction === 'restart' || shouldRestart()) {
      return { restartRequested: true };
    }
    if (requestedAction === 'skip') {
      return { skipRequested: true };
    }

    const elapsedMs = Date.now() - startTime;
    const remainingMs = timeoutMs === null
      ? chunkTimeoutMs
      : Math.max(0, timeoutMs - elapsedMs);
    const pollWindowMs = Math.max(2000, Math.min(chunkTimeoutMs, remainingMs));
    const result = await window.electronAPI.pollOAuthCompletionSingle(
      serverId,
      pollWindowMs,
      { sessionId: options.sessionId },
    );
    lastResult = result || lastResult;

    if (result?.completed || result?.failed) {
      return result;
    }

    const postPollAction = getManualAction();
    if (postPollAction === 'restart' || shouldRestart()) {
      return { restartRequested: true };
    }
    if (postPollAction === 'skip') {
      return { skipRequested: true };
    }

    if (!result?.timeout) {
      return result || { success: false, timeout: true };
    }

    if (onProgress) {
      onProgress(Math.round((Date.now() - startTime) / 1000), lastResult);
    }
  }

  return { ...lastResult, success: false, timeout: true };
}

/**
 * Restart single-server OAuth session and reopen browser with a fresh auth URL.
 */
async function restartOAuthAuthorizationSession(
  serverId,
  currentSessionId,
  callbacks = {},
) {
  try {
    await window.electronAPI.stopSingleMcpServer(serverId, {
      sessionId: currentSessionId,
    });
  } catch (e) {
    console.warn('[screen-oauth] Failed to stop server during manual restart:', e);
  }

  await prepareForFreshOauthStart(serverId);

  const restartResult = await window.electronAPI.startSingleMcpServer(
    serverId,
    { oauthMode: 'bootstrap' },
  );
  if (!restartResult.success) {
    throw new Error(restartResult.error || 'Failed to restart standalone server');
  }

  const sessionId = restartResult.sessionId;
  try {
    const oauthReady = await waitForOAuthReady(serverId, 90000, sessionId);
    if (!oauthReady.ready || !oauthReady.authUrl) {
      throw new Error('OAuth URL not ready after restart');
    }

    if (callbacks.addLog) {
      callbacks.addLog('Authorization flow restarted. Check your browser.', 'info');
    }

    console.log(
      `[screen-oauth] Reopening browser after manual restart for ${serverId} (session=${sessionId})`,
    );
    await window.electronAPI.openExternal(oauthReady.authUrl, {
      kind: 'oauth',
      event: 'authorization_restarted',
      serverId,
      sessionId,
    });
    return sessionId;
  } catch (error) {
    try {
      await window.electronAPI.stopSingleMcpServer(serverId, { sessionId });
    } catch (stopError) {
      console.warn('[screen-oauth] Failed to stop unsuccessful restarted session:', stopError);
    }
    throw error;
  }
}

/**
 * Wait for server health on the single-server stack (dynamic host port).
 * Guided setup only uses this as a short grace check after OAuth completes.
 */
async function waitForServerHealthSingle(serverId, timeout, sessionId) {
  const startTime = Date.now();
  const pollInterval = 250;

  while (Date.now() - startTime < timeout) {
    try {
      const result = await window.electronAPI.checkSingleMcpServer(serverId, {
        sessionId,
      });
      if (result.success && result.healthy) {
        return { healthy: true, tools: result.tools };
      }
    } catch (e) {
      // Continue polling
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    updateTestStep('verify', 'running', `Finishing up... (${elapsed}s)`);

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { healthy: false };
}

/**
 * Wait for OAuth to be ready (authorization URL available)
 * This polls the OAuth status endpoint instead of waiting for tools
 */
async function waitForOAuthReady(serverId, timeout = 90000, sessionId) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeout) {
    try {
      // Check if OAuth status endpoint is responding
      const oauthStatus = await window.electronAPI.getOAuthStatusSingle({
        sessionId,
      });

      // Server is ready when we have an auth URL for this server
      const serverStatus = oauthStatus.active?.find(s => s.server_name === serverId);
      if (serverStatus && serverStatus.authorization_url) {
        return { ready: true, authUrl: serverStatus.authorization_url };
      }

      // Check waiting_callback - may already have URL
      const waitingCallback = oauthStatus.waiting_callback?.find(s => s.server_name === serverId);
      if (waitingCallback && waitingCallback.authorization_url) {
        return { ready: true, authUrl: waitingCallback.authorization_url };
      }

      // Check current
      if (oauthStatus.current?.server_name === serverId && oauthStatus.current.authorization_url) {
        return { ready: true, authUrl: oauthStatus.current.authorization_url };
      }

      // Also check pending - server might still be initializing
      const pending = oauthStatus.pending?.find(s => s.server_name === serverId);
      if (pending) {
        // Server registered but not yet active, keep polling
      }
    } catch (e) {
      // Continue polling
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    updateTestStep('standalone', 'running', `Preparing your sign-in... (${elapsed}s)`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { ready: false };
}

/**
 * Extract authorization URL from OAuth status
 */
function extractAuthUrlFromStatus(oauthStatus, serverId) {
  if (!oauthStatus) return null;

  // Check 'current' field first
  if (oauthStatus.current?.authorization_url) {
    if (oauthStatus.current.server_name === serverId ||
        oauthStatus.current.server_name?.toLowerCase() === serverId?.toLowerCase()) {
      return oauthStatus.current.authorization_url;
    }
  }

  // Check 'waiting_callback' array
  if (oauthStatus.waiting_callback) {
    const server = oauthStatus.waiting_callback.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'active' array
  if (oauthStatus.active) {
    const server = oauthStatus.active.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'pending' array
  if (oauthStatus.pending) {
    const server = oauthStatus.pending.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'checking' array
  if (oauthStatus.checking) {
    const server = oauthStatus.checking.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'failed' array (URL may still be valid)
  if (oauthStatus.failed) {
    const server = oauthStatus.failed.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  return null;
}

/**
 * Show testing error with container logs
 */
async function showTestingError(errorMessage, serverId, options = {}) {
  const container = document.getElementById('oauth-stage-testing-content');
  if (!container) return;
  const composeUnavailable = options.code === 'docker_compose_unavailable';

  // Try to get container logs for debugging
  let containerLogs = '';
  try {
    const logsResult = await window.electronAPI.getWizardMcpServerLogs(
      serverId,
      100,
      { sessionId: options.sessionId },
    );
    containerLogs = logsResult.logs || '';
  } catch (e) {
    console.warn('[screen-oauth] Failed to get container logs:', e);
    containerLogs = 'Failed to retrieve logs';
  }

  // Build logs section with copy button
  const diagnosticLogs = [
    options.details,
    containerLogs,
  ].filter(Boolean).join('\n');
  const logsSection = `
    <div class="oauth-test-logs-container">
      <div class="oauth-test-logs-header">
        <span>Container Logs</span>
        <button class="oauth-test-copy-btn" id="copy-logs-btn" title="Copy to clipboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      </div>
      <pre class="oauth-test-logs-content" id="container-logs-content">${escapeHtml(diagnosticLogs)}</pre>
    </div>
  `;
  const composeGuidance = composeUnavailable
    ? `
      <div class="oauth-test-compose-guidance">
        <div class="oauth-test-compose-guidance-title">Docker Compose v2 could not be found</div>
        <div class="oauth-test-compose-guidance-message">
          Docker is running, but Portico cannot use either <code>docker compose</code>
          or a compatible <code>docker-compose</code>. Fully quit and reopen OrbStack,
          then click Retry. If the problem continues, reinstall OrbStack or remove
          conflicting Docker CLI tools.
        </div>
        <div class="oauth-test-compose-guidance-detail">
          Selected frontend: ${escapeHtml(options.selectedFrontend || 'unavailable')}
          ${options.recoveryAttempted ? ' · OrbStack restart already attempted' : ''}
        </div>
      </div>
    `
    : '';
  const errorTitle = composeUnavailable
    ? 'Docker Compose is unavailable.'
    : 'Oops. Something went wrong.';

  // Clear existing content and show the steps, summary, and logs in a stacked layout
  const stepsHtml = container.querySelector('.oauth-test-steps')?.outerHTML || '';

  container.innerHTML = `
    <div class="oauth-test-container">
      <div class="oauth-test-steps-panel">
        ${stepsHtml}
      </div>
      <div class="oauth-test-error-panel">
        <div class="oauth-test-error-header">
          <span class="oauth-test-error-icon">✗</span>
          <span class="oauth-test-error-title">${errorTitle}</span>
        </div>
        ${composeGuidance}
        <div class="oauth-test-error-actions">
          <button class="btn btn-secondary" id="oauth-test-retry-btn">Retry</button>
          <button class="btn btn-skip" id="oauth-test-skip-current-btn"
                  data-tooltip="You can always connect more integrations later.">Skip</button>
          <button class="btn btn-secondary" id="oauth-test-back-btn">Back</button>
        </div>
      </div>
      ${logsSection}
    </div>
  `;

  // Auto-scroll logs to bottom
  const logsContent = document.getElementById('container-logs-content');
  if (logsContent) {
    logsContent.scrollTop = logsContent.scrollHeight;
  }

  // Wire up copy button
  const copyBtn = document.getElementById('copy-logs-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await window.electronAPI.copyToClipboard(diagnosticLogs);
        const textSpan = copyBtn.querySelector('span');
        if (textSpan) {
          textSpan.textContent = 'Copied!';
          setTimeout(() => {
            textSpan.textContent = 'Copy';
          }, 2000);
        }
      } catch (e) {
        console.warn('[screen-oauth] Failed to copy to clipboard:', e);
      }
    });
  }

  // Add event listeners for retry and back buttons
  const retryBtn = document.getElementById('oauth-test-retry-btn');
  const skipBtn = document.getElementById('oauth-test-skip-current-btn');
  const backBtn = document.getElementById('oauth-test-back-btn');

  if (retryBtn) {
    retryBtn.onclick = () => {
      hideTestingProgress();
      // Reset current server status
      const item = oauthScreenState.servers[oauthScreenState.currentIndex];
      if (item) {
        item.status = 'current';
        updateCurrentServerUI();
        updatePreviewBar();
        if (oauthScreenState.queueStarted) {
          scheduleAutoStartForCurrent();
        }
      }
    };
  }

  if (skipBtn) {
    skipBtn.onclick = () => {
      hideTestingProgress();
      skipCurrentServer(oauthScreenState.setupState, oauthScreenState.callbacks, {
        autoStartNext: oauthScreenState.queueStarted,
      });
    };
  }

  if (backBtn) {
    backBtn.onclick = () => {
      hideTestingProgress();
      // Reset current server status
      const item = oauthScreenState.servers[oauthScreenState.currentIndex];
      if (item && item.status !== 'done' && item.status !== 'skipped') {
        item.status = 'current';
        updateCurrentServerUI();
        updatePreviewBar();
        if (oauthScreenState.queueStarted) {
          scheduleAutoStartForCurrent();
        }
      }
    };
  }
}

/**
 * Mark current server as done WITHOUT restarting regular stack
 * Used in guided setup where main infrastructure isn't running
 */
async function markCurrentAsDoneNoRestart(setupState, callbacks = {}) {
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item) return;

  item.status = 'done';
  oauthScreenState.completedCount++;
  syncCurrentOauthIndexToSetupState();

  const serverId = item.server.id;

  // Track in setupState
  if (setupState.completedOAuthServers) {
    setupState.completedOAuthServers.add(serverId);
  }
  if (setupState.connectedOAuthServers) {
    setupState.connectedOAuthServers.add(serverId);
  }
  if (setupState.skippedOAuthServers) {
    setupState.skippedOAuthServers.delete(serverId);
  }

  if (callbacks.addLog) {
    callbacks.addLog(`OAuth authorization successful for ${item.metadata.display_name}`, 'success');
  }

  if (areAllServersProcessed()) {
    handleOAuthComplete(setupState, callbacks);
    return;
  }

  updatePreviewBar();
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Funny Sims-style messages for post-OAuth setup
 */
const funnyOAuthMessages = [
  'Reticulating splines...',
  'Calibrating flux capacitors...',
  'Asking Atlas for directions...',
  'Warming up the hamster wheels...',
  'Convincing electrons to cooperate...',
  'Bribing the API gremlins...',
  'Untangling quantum spaghetti...',
  'Teaching bits to byte...',
  'Polishing the pixels...',
  'Synchronizing chaos butterflies...',
  'Negotiating with the cloud...',
  'Herding digital cats...',
  'Brewing authentication tokens...',
  'Consulting the magic 8-ball...',
  'Aligning chakras with endpoints...',
  'Feeding the code monkeys...',
  'Defragmenting the void...',
  'Compiling good vibes...',
  'Initializing awesome mode...',
  'Charging the laser sharks...'
];

/**
 * Get a random funny message
 */
function getRandomOAuthMessage() {
  return funnyOAuthMessages[Math.floor(Math.random() * funnyOAuthMessages.length)];
}

/**
 * Mark current server as done and restart the MCP server
 */
async function markCurrentAsDone(setupState, callbacks = {}) {
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item) return;

  item.status = 'done';
  oauthScreenState.completedCount++;
  syncCurrentOauthIndexToSetupState();

  const serverId = item.server.id;

  // Track in setupState
  if (setupState.completedOAuthServers) {
    setupState.completedOAuthServers.add(serverId);
  }
  if (setupState.connectedOAuthServers) {
    setupState.connectedOAuthServers.add(serverId);
  }
  if (setupState.skippedOAuthServers) {
    setupState.skippedOAuthServers.delete(serverId);
  }

  if (callbacks.addLog) {
    callbacks.addLog(`OAuth authorization successful for ${item.metadata.display_name}`, 'success');
  }

  updateCurrentServerUI();
  updatePreviewBar();

  // Show funny messages while restarting MCP server
  if (callbacks.addLog) {
    callbacks.addLog(getRandomOAuthMessage(), 'info');
  }

  // Start rotating funny messages
  let messageInterval = setInterval(() => {
    if (callbacks.addLog) {
      callbacks.addLog(getRandomOAuthMessage(), 'info');
    }
  }, 2500);

  try {
    console.log(`[screen-oauth] Restarting MCP server ${serverId} to complete setup...`);

    // Wait a moment for OAuth tokens to be fully processed
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Restart the MCP server to pick up the new auth tokens
    if (window.electronAPI && window.electronAPI.apiRestartMcpServers) {
      if (callbacks.addLog) {
        callbacks.addLog(`Finalizing ${item.metadata.display_name} setup...`, 'info');
      }
      const restartResult = await window.electronAPI.apiRestartMcpServers([serverId]);
      console.log(`[screen-oauth] MCP restart result for ${serverId}:`, restartResult);

      // Wait for the server to come back up
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (callbacks.addLog) {
        callbacks.addLog(`${item.metadata.display_name} is ready!`, 'success');
      }
    }
  } catch (error) {
    console.log(`[screen-oauth] Error restarting MCP server ${serverId}:`, error.message);
    // Don't fail the OAuth flow if restart fails
  } finally {
    clearInterval(messageInterval);
  }

  // Now advance to next server or show completion
  if (areAllServersProcessed()) {
    handleOAuthComplete(setupState, callbacks);
  } else {
    const nextPending = findNextPendingServer();
    if (nextPending !== -1) {
      navigateToServer(nextPending);
    } else {
      handleOAuthComplete(setupState, callbacks);
    }
  }
}

/**
 * Mark current server as failed
 */
function markCurrentAsFailed(errorMessage, callbacks = {}) {
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item) return;

  item.status = 'failed';
  oauthScreenState.failedCount++;

  if (callbacks.addLog) {
    callbacks.addLog(`OAuth failed for ${item.metadata.display_name}: ${errorMessage}`, 'error');
  }

  updateCurrentServerUI();
  updatePreviewBar();
  updateNavigationButtons();
}

/**
 * Skip current server
 */
function skipCurrentServer(setupState, callbacks = {}, options = {}) {
  if (oauthScreenState.flowLocked) return;
  const item = oauthScreenState.servers[oauthScreenState.currentIndex];
  if (!item || ['done', 'skipped'].includes(item.status)) return;

  if (item.status === 'failed' && oauthScreenState.failedCount > 0) {
    oauthScreenState.failedCount -= 1;
  }

  item.status = 'skipped';
  oauthScreenState.skippedCount++;

  // Track in setupState
  if (setupState.skippedOAuthServers) {
    setupState.skippedOAuthServers.add(item.server.id);
  }

  if (callbacks.addLog) {
    callbacks.addLog(`Skipped OAuth for ${item.metadata.display_name}`, 'info');
  }

  updateCurrentServerUI();
  updatePreviewBar();

  if (areAllServersProcessed()) {
    handleOAuthComplete(setupState, callbacks);
  } else {
    const nextPending = findNextPendingServer(oauthScreenState.currentIndex, { wrap: false });
    if (nextPending !== -1) {
      navigateToServer(nextPending, { autoStart: options.autoStartNext === true });
    } else {
      handleOAuthComplete(setupState, callbacks);
    }
  }
}

/**
 * Skip all remaining servers
 */
function skipAllRemainingServers(setupState, callbacks = {}) {
  if (oauthScreenState.flowLocked) return;
  oauthScreenState.servers.forEach(item => {
    if (item.status === 'pending' || item.status === 'current') {
      item.status = 'skipped';
      oauthScreenState.skippedCount++;

      if (setupState.skippedOAuthServers) {
        setupState.skippedOAuthServers.add(item.server.id);
      }
    }
  });

  if (callbacks.addLog) {
    callbacks.addLog(`Skipped all remaining OAuth authorizations`, 'info');
  }

  updatePreviewBar();
  handleOAuthComplete(setupState, callbacks);
}

/**
 * Handle completion when all servers are processed
 * Automatically proceeds to the next stage without showing a summary screen
 */
function handleOAuthComplete(setupState, callbacks = {}) {
  console.log(`[screen-oauth] All servers processed: ${oauthScreenState.completedCount} done, ${oauthScreenState.skippedCount} skipped, ${oauthScreenState.failedCount} failed`);

  // Mark OAuth step as complete
  setupState.completedSteps.oauth = true;
  if (callbacks.updateProgressTracker) {
    callbacks.updateProgressTracker();
  }

  // Automatically proceed to next stage
  proceedAfterOAuth(setupState, callbacks);
}

/**
 * Proceed after OAuth stage completes
 */
async function proceedAfterOAuth(setupState, callbacks = {}) {
  console.log('[screen-oauth] Proceeding after OAuth');

  // Check if there are servers needing configuration
  if (setupState.serverConfigs && setupState.serverConfigs.length > 0) {
    const nextConfigIndex = callbacks.findNextPendingConfigurationIndex
      ? callbacks.findNextPendingConfigurationIndex(0)
      : 0;

    if (nextConfigIndex !== -1 && callbacks.loadServerConfiguration) {
      setupState.currentServerIndex = nextConfigIndex;
      await callbacks.loadServerConfiguration(nextConfigIndex);
    } else if (nextConfigIndex !== -1) {
      setupState.currentServerIndex = nextConfigIndex;
    } else {
      if (callbacks.showStage) {
        await callbacks.showStage('finalize');
      }
      if (callbacks.finalizeSetup) {
        callbacks.finalizeSetup();
      }
    }
  } else {
    // No configuration needed - go to finalize
    if (callbacks.showStage) {
      await callbacks.showStage('finalize');
    }
    if (callbacks.finalizeSetup) {
      callbacks.finalizeSetup();
    }
  }
}

/**
 * Render the OAuth stage UI structure
 */
function renderOAuthStage(callbacks = {}) {
  const configContent = document.getElementById('oauth-stage-content');
  if (!configContent) return;

  configContent.innerHTML = `
    <!-- Server Preview Bar -->
    <div class="oauth-stage-preview-container">
      <div class="oauth-stage-preview" id="oauth-stage-preview">
        <!-- Preview cards will be rendered here -->
      </div>
    </div>

    <!-- Current Server Display -->
    <div class="oauth-stage-current-server" id="oauth-stage-current-server">
      <div class="oauth-stage-server-info">
        <img class="oauth-stage-server-icon" id="oauth-stage-server-icon" src="" alt="" style="display: none;">
        <div class="oauth-stage-server-details">
          <h2 id="oauth-stage-server-name">Server Name</h2>
          <p id="oauth-stage-server-description">Server description</p>
        </div>
      </div>
      <div class="oauth-stage-progress">
        <div class="oauth-stage-progress-left">
          <span id="oauth-stage-progress-text">Server 1 of N</span>
          <div class="oauth-stage-nav-buttons">
            <button class="btn btn-skip oauth-skip-btn" id="oauth-stage-next-btn"
                    data-tooltip="You can always connect more integrations later.">Skip</button>
            <button class="btn btn-skip oauth-skip-btn" id="oauth-stage-skip-all-btn"
                    data-tooltip="You can always connect more integrations later.">Skip All</button>
          </div>
        </div>
        <span id="oauth-stage-status-text" style="display: none;"></span>
      </div>
    </div>

    <!-- Buttons -->
    <div class="oauth-stage-buttons" id="oauth-stage-buttons">
      <div class="oauth-stage-action-buttons">
        <button class="btn btn-primary" id="oauth-stage-authorize-btn">Connect</button>
      </div>
    </div>

    <!-- Testing Progress Pane (hidden by default) -->
    <div class="oauth-stage-testing" id="oauth-stage-testing" style="display: none;">
      <div id="oauth-stage-testing-content">
        <!-- Testing steps will be rendered here dynamically -->
      </div>
    </div>

  `;

  // Render the preview bar
  renderPreviewBar();
}

/**
 * Render screen when all OAuth servers are already authorized
 * Shows server icons with checkmarks and a message to continue
 */
function renderAllAuthorizedScreen(setupState, callbacks = {}) {
  const configContent = document.getElementById('oauth-stage-content');
  if (!configContent) return;

  // Build server cards HTML - all should be done/preconfigured
  const serverCardsHtml = oauthScreenState.servers.map((item) => {
    const { metadata, status, preConfigured } = item;
    const iconSrc = metadata.icon || '';
    const name = metadata.display_name || metadata.name;
    const logoKind = getOAuthLogoKind(metadata);

    // Status badge - gray checkmark for pre-configured
    const badgeClass = preConfigured ? 'done preconfigured' : 'done';
    const tooltip = preConfigured ? 'Already authorized' : 'Authorized';
    const statusBadge = `<div class="oauth-preview-status-badge ${badgeClass}" title="${tooltip}">✓</div>`;

    const cardClass = preConfigured ? `${status} preconfigured` : status;

    return `
      <div class="oauth-stage-preview-card ${cardClass}">
        <div class="oauth-preview-icon-container">
          ${iconSrc ? `<img class="oauth-stage-preview-icon" data-logo-kind="${logoKind}" src="${iconSrc}" alt="${name}" onerror="this.style.display='none'" />` : ''}
          ${statusBadge}
        </div>
        <span class="oauth-stage-preview-name" title="${name}">${name}</span>
      </div>
    `;
  }).join('');

  configContent.innerHTML = `
    <!-- Server Preview Bar -->
    <div class="oauth-stage-preview-container">
      <div class="oauth-stage-preview" id="oauth-stage-preview">
        ${serverCardsHtml}
      </div>
    </div>

    <!-- Message -->
    <div class="oauth-stage-completion">
      <p style="color: var(--status-success); font-size: 18px; font-weight: 600; margin-bottom: 8px;">
        <span style="margin-right: 8px;">✓</span>All OAuth servers authorized.
      </p>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        Let's continue configuring additional servers.
      </p>
      <button class="btn btn-primary" id="oauth-continue-btn">Continue →</button>
    </div>
  `;

  // Wire up the Continue button
  const continueBtn = document.getElementById('oauth-continue-btn');
  if (continueBtn) {
    continueBtn.onclick = () => {
      proceedAfterOAuth(setupState, callbacks);
    };
  }
}

/**
 * Render screen when there are no OAuth servers to configure
 */
function renderNoOAuthServersScreen(setupState, callbacks = {}) {
  const configContent = document.getElementById('oauth-stage-content');
  if (!configContent) return;

  // Mark OAuth step as complete since there's nothing to do
  setupState.completedSteps.oauth = true;
  if (callbacks.updateProgressTracker) {
    callbacks.updateProgressTracker();
  }

  configContent.innerHTML = `
    <div class="oauth-stage-completion">
      <h2>No OAuth Servers Selected</h2>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        None of the selected servers require OAuth authorization. Continue to configure your servers.
      </p>
      <button class="btn btn-primary" id="oauth-continue-btn">Continue →</button>
    </div>
  `;

  // Wire up the Continue button
  const continueBtn = document.getElementById('oauth-continue-btn');
  if (continueBtn) {
    continueBtn.onclick = () => {
      proceedAfterOAuth(setupState, callbacks);
    };
  }
}

/**
 * Setup button event handlers
 */
function setupButtonHandlers(setupState, callbacks = {}) {
  const authorizeBtn = document.getElementById('oauth-stage-authorize-btn');
  const skipAllBtn = document.getElementById('oauth-stage-skip-all-btn');
  const nextBtn = document.getElementById('oauth-stage-next-btn');

  if (authorizeBtn) {
    authorizeBtn.onclick = () => handleAuthorize(setupState, callbacks);
  }
  if (skipAllBtn) {
    skipAllBtn.onclick = () => skipAllRemainingServers(setupState, callbacks);
  }
  if (nextBtn) {
    nextBtn.onclick = () => skipCurrentServer(setupState, callbacks);
  }
}

/**
 * Main entry point - load OAuth screen
 */
async function loadOAuthScreen(setupState, callbacks = {}, options = {}) {
  console.log('[screen-oauth] Loading OAuth screen');

  if (setupState?.completedSteps) {
    setupState.completedSteps.prerequisites = true;
    setupState.completedSteps.prerequisitesWarning = false;
  }

  const analysis = await analyzeOAuthServers(setupState.oauthServers || []);
  syncCompletedOauthServers(setupState, analysis.completedServerIds);
  setupState.oauthStepRequired = analysis.pendingCount > 0;
  setupState.completedSteps.oauth = analysis.pendingCount === 0;
  callbacks.updateProgressTracker?.();

  if (analysis.pendingCount === 0) {
    console.log('[screen-oauth] All OAuth-capable selections are already authorized; skipping OAuth readiness gate');
    if (options.suppressAutoAdvance === true) {
      renderCompletedOauthRevisitScreen(setupState, callbacks, analysis);
      return;
    }
    await proceedAfterOAuth(setupState, callbacks);
    return;
  }

  const ready = await waitForAuthorizeReadiness();
  if (!ready) {
    return;
  }

  const initResult = await initOAuthScreen(setupState, callbacks, { analysis });
  if (initResult?.skipped) {
    return;
  }

  setupButtonHandlers(setupState, callbacks);
  if (options.autoStartPending === true) {
    scheduleAutoStartForCurrent();
  }
}

// Export functions
module.exports = {
  analyzeOAuthServers,
  loadOAuthScreen,
  initOAuthScreen,
  handleAuthorize,
  skipCurrentServer,
  skipAllRemainingServers,
  proceedAfterOAuth,
  navigateToServer,
  setupButtonHandlers,
  _test: {
    getOauthDisplayName,
    sortOauthServers,
    createOauthScreenItem,
    syncCompletedOauthServers,
    getCompletionDetail,
    getRemainingPendingIndices,
    shouldAutoAdvanceAfterSuccess,
    getStatusIcon,
    getOAuthLogoKind,
    isOauthItemProcessing,
    findNextPendingServer,
    renderOAuthReadinessState,
    waitForAuthorizeReadiness,
    renderAllAuthorizedScreen,
    renderNoOAuthServersScreen,
    renderCompletedOauthRevisitScreen,
    renderOAuthStage,
    renderPreviewBar,
    updatePreviewBar,
    updateCurrentServerUI,
    updateNavigationButtons,
    showCompletedServerState,
    resolveCompletedOauthCurrentIndex,
    setPollWaitingControls,
    setPollRestartControls,
    showTestingProgress,
    hideTestingProgress,
    renderTestingSteps,
    updateTestStep,
    getStatusMessage,
    extractAuthUrlFromStatus,
    waitForOAuthTokensPersisted,
    pollOAuthCompletionWithManualRestart,
    guidedSetupOAuthFlowTimeoutMs: GUIDED_SETUP_OAUTH_FLOW_TIMEOUT_MS,
    restartOAuthAuthorizationSession,
    waitForServerHealthSingle,
    waitForOAuthReady,
    showTestingError,
    markCurrentAsDoneNoRestart,
    markCurrentAsDone,
    markCurrentAsFailed,
    areAllServersProcessed,
    routeToRequiredConfigurationBeforeOAuth,
    handleOAuthComplete,
    escapeHtml,
    getRandomOAuthMessage,
    setOauthScreenState(nextState) {
      oauthScreenState = {
        ...oauthScreenState,
        ...nextState,
      };
    },
    getOauthScreenState() {
      return oauthScreenState;
    }
  }
};
