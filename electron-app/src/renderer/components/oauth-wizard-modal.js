/**
 * OAuth Wizard Modal for MCP Servers Control Plane
 *
 * Full-featured OAuth wizard with step-by-step progress, using the single server stack (dynamic host port).
 * This provides the same UX and business logic as the guided setup OAuth screen.
 *
 * Key differences from oauth-modal-shared.js:
 * - Uses single server stack APIs (startSingleMcpServer, pollOAuthCompletionSingle, etc.)
 * - Full step-by-step testing UI
 * - Token verification and DCR re-auth handling
 * - After authorization, starts prod recovery in the background
 */

const _CONTRACTOR_EMAIL_SUFFIX = '@contractor.example.invalid';
const _PERMISSIONS_JIRA_URL = 'https://portico.atlassian.net/secure/CreateIssueDetails!init.jspa?pid=11182&issuetype=11076';

function _isCurrentUserContractor() {
  try {
    const user = window.appState?.currentUser?.sessionSummary?.user || {};
    const candidates = [user.email, user.id, user.preferredUsername].filter(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    return candidates.some((c) =>
      c.toLowerCase().trim().endsWith(_CONTRACTOR_EMAIL_SUFFIX),
    );
  } catch {
    return false;
  }
}

// Guard against concurrent flows
let oauthWizardFlowInProgress = false;

// Module state
let oauthWizardState = {
  servers: [],           // Array of {server, metadata, status, preConfigured}
  currentIndex: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  completedServerIds: [],
  resolveFlow: null,
  escapeHandler: null,
  queueStarted: false,
  flowLocked: false,
  pendingAutoStartIndex: null,
  flowSource: 'manual',
  requestedServerId: null,
  dismissibleRequestServerId: null,
  backendManagedServerIds: new Set(),
  contractorDeniedServerIds: new Set(),
  wasDismissed: false,
  // Ownership token for the currently-running wizard poll loop. When a new
  // OAuth flow starts (e.g. backend `oauth-flow-requested` arrives while a
  // prior flow is still polling), the new flow aborts this controller so
  // the old loop exits silently instead of leaking its elapsed-second
  // counter into the new flow's DOM. Closing the modal also aborts.
  activePollAbortController: null,
};

const SINGLE_SERVER_WIZARD_DESCRIPTION =
  "Let's connect your integration. You'll be asked to sign in.";
const MULTI_SERVER_WIZARD_DESCRIPTION =
  "Let's connect your integrations. You'll be asked to sign in for each one.";
const PORTICO_LOGO_SERVER_IDS = new Set([
  "data-plat-mcp",
  "ownership-mcp",
  "teamworks-mcp",
]);
const WIZARD_OAUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

// Note: the wizard intentionally does NOT auto-fail on a "stale" callback.
// A user who is carefully reading the IdP's consent screen, on slow Wi-Fi,
// or fetching a 2FA code can legitimately take longer than any 30s/60s
// threshold. The escape hatches are all user-driven:
//   - The visible "Stuck? Retry" button restarts the OAuth handshake.
//   - The wizard close (X) cancels the flow cleanly (see closeWizardModal).
//   - The 10-min WIZARD_OAUTH_FLOW_TIMEOUT_MS outer budget catches truly
//     abandoned modals.
//   - The contractor + data-plat-mcp 4xx auth-URL probe in
//     handleWizardAuthorize fires immediately when the IdP returns 4xx
//     on the auth URL itself (the only "definitely going to fail" signal
//     we can trust without a real callback).
// We deliberately do not introduce a clock-based failure here; doing so
// false-positives on legitimate slow authorizations more often than it
// catches genuinely silent failures.

// Finalization state (prod restarts/health sync after successful OAuth)
let oauthWizardFinalizationPromise = null;
let oauthWizardFinalizationComplete = false;
let oauthWizardCloseInProgress = false;
let oauthWizardProdRecoveryTasks = new Map();

// HTML template loaded flag
let wizardTemplateLoaded = false;

/**
 * Load the HTML template into the container
 */
async function loadWizardTemplate() {
  if (wizardTemplateLoaded) return;

  const container = document.getElementById('oauth-wizard-container');
  if (!container) {
    console.error('[OAuth Wizard] Container #oauth-wizard-container not found');
    return;
  }

  try {
    const response = await fetch('renderer/components/oauth-wizard-modal.html');
    const html = await response.text();
    container.innerHTML = html;
    wizardTemplateLoaded = true;
    console.log('[OAuth Wizard] Template loaded successfully');
  } catch (error) {
    console.error('[OAuth Wizard] Failed to load template:', error);
  }
}

/**
 * Reset wizard DOM state so each modal open starts fresh.
 * This avoids stale UI from a previous run (testing pane, completion stats, button text, etc.).
 */
function resetWizardModalUIState() {
  const modal = document.getElementById('oauth-wizard-modal');
  const mainContent = document.getElementById('oauth-wizard-main-content');
  const completion = document.getElementById('oauth-wizard-completion');
  const preview = document.getElementById('oauth-wizard-preview');
  const currentServer = document.getElementById('oauth-wizard-current-server');
  const progress = document.querySelector('.oauth-wizard-progress');
  const buttons = document.getElementById('oauth-wizard-buttons');
  const authorizeBtn = document.getElementById('oauth-wizard-authorize-btn');
  const prevBtn = document.getElementById('oauth-wizard-prev-btn');
  const nextBtn = document.getElementById('oauth-wizard-next-btn');
  const skipAllBtn = document.getElementById('oauth-wizard-skip-all-btn');
  const testingPane = document.getElementById('oauth-wizard-testing');
  const testingContent = document.getElementById('oauth-wizard-testing-content');
  const statusText = document.getElementById('oauth-wizard-status-text');
  const progressText = document.getElementById('oauth-wizard-progress-text');
  const statDone = document.getElementById('oauth-wizard-stat-done');
  const statSkipped = document.getElementById('oauth-wizard-stat-skipped');
  const statFailed = document.getElementById('oauth-wizard-stat-failed');
  const stats = document.getElementById('oauth-wizard-stats');
  const finalizing = document.getElementById('oauth-wizard-finalizing');
  const doneBtn = document.getElementById('oauth-wizard-done-btn');

  updateWizardDescriptionText(0);

  if (modal) modal.classList.remove('single-server');
  if (mainContent) mainContent.style.display = 'block';
  if (completion) completion.style.display = 'none';

  if (preview) preview.innerHTML = '';
  if (currentServer) currentServer.style.display = 'block';
  if (progress) progress.style.display = 'flex';
  if (buttons) buttons.style.display = 'flex';

  if (authorizeBtn) {
    authorizeBtn.disabled = false;
    authorizeBtn.style.display = 'inline-flex';
    authorizeBtn.textContent = 'Connect';
  }
  if (prevBtn) prevBtn.style.display = 'none';
  if (nextBtn) {
    nextBtn.textContent = 'Skip';
    nextBtn.style.display = 'none';
    nextBtn.disabled = false;
  }
  if (skipAllBtn) {
    skipAllBtn.textContent = 'Skip All';
    skipAllBtn.style.display = 'none';
    skipAllBtn.disabled = false;
  }

  if (testingPane) testingPane.style.display = 'none';
  if (testingContent) testingContent.innerHTML = '';

  if (statusText) {
    statusText.textContent = '';
    statusText.style.display = 'none';
  }
  if (progressText) progressText.textContent = 'Server 1 of N';

  if (statDone) {
    statDone.textContent = '✓ 0 authorized';
    statDone.style.display = 'flex';
  }
  if (statSkipped) {
    statSkipped.textContent = '⊘ 0 skipped';
    statSkipped.style.display = 'flex';
  }
  if (statFailed) {
    statFailed.textContent = '✗ 0 failed';
    statFailed.style.display = 'none';
  }

  if (stats) stats.style.display = 'flex';
  if (finalizing) finalizing.style.display = 'none';
  if (doneBtn) {
    doneBtn.style.display = 'inline-flex';
    doneBtn.disabled = false;
  }
}

function getWizardDescriptionText(serverCount) {
  return serverCount === 1
    ? SINGLE_SERVER_WIZARD_DESCRIPTION
    : MULTI_SERVER_WIZARD_DESCRIPTION;
}

function updateWizardDescriptionText(serverCount) {
  const description = document.getElementById('oauth-wizard-description');
  if (description) {
    description.textContent = getWizardDescriptionText(serverCount);
  }
}

function getWizardLogoKind(metadata = {}) {
  if (metadata.logoKind) {
    return metadata.logoKind;
  }

  const serverId = String(metadata.id || metadata.name || '').toLowerCase();
  return PORTICO_LOGO_SERVER_IDS.has(serverId) ? 'portico' : 'default';
}

/**
 * Get canonical server ID for a wizard item or raw server object.
 */
function getWizardServerId(target) {
  return target?.server?.id || target?.server?.server_name || target?.id || target?.server_name || null;
}

function isWizardConfigurationPending(target) {
  const server = target?.server || target;
  return Boolean(
    server?.configurationPending === true ||
      server?.configuration_pending === true,
  );
}

function isWizardSetLike(value) {
  return Boolean(value) && typeof value.has === 'function' && typeof value.add === 'function';
}

/**
 * Find a wizard item by server ID.
 */
function findWizardServerItem(serverId) {
  return oauthWizardState.servers.find((item) => getWizardServerId(item) === serverId) || null;
}

/**
 * Update transient post-auth recovery state for a wizard item.
 */
function updateWizardServerRecoveryState(serverId, updates = {}) {
  const item = findWizardServerItem(serverId);
  if (!item) return;
  Object.assign(item, updates);
  updateWizardCurrentServerUI();
  updateWizardPreviewBar();
}

function getCurrentWizardItem() {
  return oauthWizardState.servers[oauthWizardState.currentIndex] || null;
}

function setOAuthWizardInteractionSuppressed(suppressed) {
  window.setOwuiInteractionSuppressed?.("oauth-wizard", suppressed);
  window.setNativeOverlayInteractionSuppressed?.("oauth-wizard", suppressed);
}

function resetOAuthWizardInteractionState() {
  window.hideLoading?.();
  if (!document.body?.style) {
    return;
  }

  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function showOAuthWizardModal() {
  const modal = document.getElementById("oauth-wizard-modal");
  const mainContent = document.getElementById("oauth-wizard-main-content");
  const completion = document.getElementById("oauth-wizard-completion");

  if (!modal) {
    return;
  }

  setOAuthWizardInteractionSuppressed(true);

  resetOAuthWizardInteractionState();

  if (mainContent) mainContent.style.display = "block";
  if (completion) completion.style.display = "none";

  modal.classList.add("visible");
  if (oauthWizardState.servers.length === 1) {
    modal.classList.add("single-server");
  } else {
    modal.classList.remove("single-server");
  }
}

function revealExistingOAuthWizard(options = {}) {
  showOAuthWizardModal();

  const requestedServerId = String(
    options.requestedServerId || oauthWizardState.requestedServerId || "",
  ).trim();

  if (!requestedServerId) {
    updateWizardCurrentServerUI();
    updateWizardPreviewBar();
    return;
  }

  const requestedIndex = oauthWizardState.servers.findIndex(
    (item) => getWizardServerId(item) === requestedServerId,
  );
  if (requestedIndex === -1) {
    updateWizardCurrentServerUI();
    updateWizardPreviewBar();
    return;
  }

  if (oauthWizardState.flowLocked || isWizardItemProcessing(getCurrentWizardItem())) {
    updateWizardCurrentServerUI();
    updateWizardPreviewBar();
    return;
  }

  navigateWizardToServer(requestedIndex);
}

function isWizardItemProcessing(item) {
  return Boolean(item && ['starting', 'waiting'].includes(item.status));
}

function isWizardBackendManagedServer(serverId) {
  return Boolean(
    serverId &&
    isWizardSetLike(oauthWizardState.backendManagedServerIds) &&
      oauthWizardState.backendManagedServerIds.has(serverId),
  );
}

function getBackendRequestOutcomes() {
  if (
    !oauthWizardState.backendRequestOutcomes ||
    typeof oauthWizardState.backendRequestOutcomes.get !== 'function' ||
    typeof oauthWizardState.backendRequestOutcomes.set !== 'function'
  ) {
    oauthWizardState.backendRequestOutcomes = new Map();
  }
  return oauthWizardState.backendRequestOutcomes;
}

function notifyBackendOAuthCompletionOnce(serverId) {
  if (!serverId || !isWizardBackendManagedServer(serverId)) {
    return false;
  }
  const outcomes = getBackendRequestOutcomes();
  if (outcomes.get(serverId) === 'dismissed') {
    return false;
  }
  if (!isWizardSetLike(oauthWizardState.backendCompletionNotifiedServerIds)) {
    oauthWizardState.backendCompletionNotifiedServerIds = new Set();
  }
  if (oauthWizardState.backendCompletionNotifiedServerIds.has(serverId)) {
    return false;
  }
  oauthWizardState.backendCompletionNotifiedServerIds.add(serverId);
  outcomes.set(serverId, 'completed');
  window.electronAPI?.notifyOAuthServerDone?.(serverId);
  settleWizardRequestedServer(serverId);
  return true;
}

function notifyBackendOAuthCompletionAfterRendererRecovery(serverId) {
  const recoveryTask = oauthWizardProdRecoveryTasks.get(serverId);
  if (!recoveryTask?.promise) {
    return notifyBackendOAuthCompletionOnce(serverId);
  }
  void recoveryTask.promise.finally(() => {
    notifyBackendOAuthCompletionOnce(serverId);
  });
  return true;
}

function attachBackendRequestToExistingWizard(options = {}) {
  if (options.flowSource !== 'backend-requested') {
    return false;
  }
  const requestedServerId = String(
    options.requestedServerId || options.preferredServerId || '',
  ).trim();
  if (!requestedServerId || !findWizardServerItem(requestedServerId)) {
    return false;
  }
  if (!isWizardSetLike(oauthWizardState.backendManagedServerIds)) {
    oauthWizardState.backendManagedServerIds = new Set();
  }
  oauthWizardState.backendManagedServerIds.add(requestedServerId);
  const outcomes = getBackendRequestOutcomes();
  if (!outcomes.has(requestedServerId)) {
    outcomes.set(requestedServerId, 'pending');
  }
  oauthWizardState.requestedServerId = requestedServerId;
  oauthWizardState.dismissibleRequestServerId = requestedServerId;

  const requestedItem = findWizardServerItem(requestedServerId);
  if (requestedItem?.status === 'done') {
    notifyBackendOAuthCompletionOnce(requestedServerId);
  }
  return true;
}

function shouldReuseBackendPreparedOAuthState(serverId) {
  return (
    oauthWizardState.flowSource === 'backend-requested' &&
    isWizardBackendManagedServer(serverId)
  );
}

function settleWizardRequestedServer(serverId) {
  if (!serverId) return;
  if (oauthWizardState.dismissibleRequestServerId === serverId) {
    oauthWizardState.dismissibleRequestServerId = null;
  }
  if (oauthWizardState.requestedServerId === serverId) {
    oauthWizardState.requestedServerId = null;
  }
}

function dismissWizardRequestedServerIfNeeded(serverId = null) {
  const outcomes = getBackendRequestOutcomes();
  const serverIds = serverId
    ? [serverId]
    : [...outcomes.entries()]
        .filter(([, outcome]) => outcome === 'pending')
        .map(([id]) => id);
  if (serverIds.length === 0 && oauthWizardState.dismissibleRequestServerId) {
    serverIds.push(oauthWizardState.dismissibleRequestServerId);
  }

  let dismissed = false;
  for (const id of serverIds) {
    const requestedItem = findWizardServerItem(id);
    if (requestedItem?.status === 'done') {
      notifyBackendOAuthCompletionAfterRendererRecovery(id);
      continue;
    }
    if (outcomes.get(id) === 'completed' || outcomes.get(id) === 'dismissed') {
      continue;
    }
    outcomes.set(id, 'dismissed');
    window.electronAPI?.notifyOAuthDismissed?.(id);
    settleWizardRequestedServer(id);
    dismissed = true;
  }
  return dismissed;
}

function scheduleWizardAutoStartForCurrent() {
  const currentIndex = oauthWizardState.currentIndex;
  if (oauthWizardState.pendingAutoStartIndex === currentIndex) {
    return;
  }

  oauthWizardState.pendingAutoStartIndex = currentIndex;
  setTimeout(() => {
    if (oauthWizardState.pendingAutoStartIndex !== currentIndex) {
      return;
    }
    oauthWizardState.pendingAutoStartIndex = null;

    const currentItem = getCurrentWizardItem();
    if (!currentItem || oauthWizardState.currentIndex !== currentIndex || oauthWizardState.flowLocked) {
      return;
    }
    if (currentItem.status !== 'current') {
      return;
    }

    handleWizardAuthorize();
  }, 0);
}

/**
 * Get status icon for preview card
 */
function getWizardStatusIcon(status) {
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
 * Get status message for display
 */
function getWizardStatusMessage(itemOrStatus, preConfigured = false) {
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
      if (item.postAuthSyncState === 'backend_managed') {
        return 'Authorized · final checks continuing in the background';
      }
      if (item.postAuthSyncState === 'syncing') {
        return 'Authorized · syncing tools...';
      }
      if (item.postAuthSyncState === 'sync_delayed') {
        return 'Authorized · tool sync continuing in background';
      }
      if (item.postAuthSyncState === 'failed') {
        return 'Authorized · tool sync hit an error';
      }
      return 'Authorization complete';
    case 'failed': return 'Authorization failed';
    case 'skipped': return 'Skipped';
    default: return 'Pending';
  }
}

/**
 * Render the server preview bar
 */
function renderWizardPreviewBar() {
  const previewContainer = document.getElementById('oauth-wizard-preview');
  if (!previewContainer) return;

  console.log(`[OAuth Wizard] Rendering preview bar with ${oauthWizardState.servers.length} server(s)`);

  previewContainer.innerHTML = oauthWizardState.servers.map((item, index) => {
    const { metadata, status, preConfigured } = item;
    const iconSrc = metadata.icon || '';
    const name = metadata.display_name || metadata.name;
    const logoKind = getWizardLogoKind(metadata);

    // Status badge HTML
    let statusBadge = '';
    if (status === 'done') {
      const badgeClass = preConfigured ? 'done preconfigured' : 'done';
      const tooltip = getWizardStatusMessage(item);
      statusBadge = `<div class="oauth-wizard-status-badge ${badgeClass}" title="${tooltip}">✓</div>`;
    } else if (status === 'failed') {
      statusBadge = '<div class="oauth-wizard-status-badge failed">✗</div>';
    } else if (status === 'skipped') {
      statusBadge = '<div class="oauth-wizard-status-badge skipped">⊘</div>';
    }

    const cardClass = preConfigured ? `${status} preconfigured` : status;

    return `
      <div class="oauth-wizard-preview-card ${cardClass}" data-index="${index}">
        <div class="oauth-wizard-icon-container">
          ${iconSrc ? `<img class="oauth-wizard-preview-icon" data-logo-kind="${logoKind}" src="${iconSrc}" alt="${name}" onerror="this.style.display='none'" />` : ''}
          ${statusBadge}
        </div>
        <span class="oauth-wizard-preview-name" title="${name}">${name}</span>
      </div>
    `;
  }).join('');

  // Add click handlers for navigation
  const cards = previewContainer.querySelectorAll('.oauth-wizard-preview-card');
  cards.forEach((card, index) => {
    card.addEventListener('click', () => navigateWizardToServer(index, { fromPreview: true }));
  });
}

/**
 * Update preview bar status indicators
 */
function updateWizardPreviewBar() {
  const cards = document.querySelectorAll('.oauth-wizard-preview-card');
  cards.forEach((card, index) => {
    if (index < oauthWizardState.servers.length) {
      const item = oauthWizardState.servers[index];
      const cardClass = item.preConfigured ? `${item.status} preconfigured` : item.status;
      card.className = `oauth-wizard-preview-card ${cardClass}`;

      // Update status badge
      const iconContainer = card.querySelector('.oauth-wizard-icon-container');
      if (iconContainer) {
        const existingBadge = iconContainer.querySelector('.oauth-wizard-status-badge');
        if (existingBadge) existingBadge.remove();

        if (item.status === 'done') {
          const badgeClass = item.preConfigured ? 'done preconfigured' : 'done';
          const tooltip = getWizardStatusMessage(item);
          iconContainer.insertAdjacentHTML('beforeend', `<div class="oauth-wizard-status-badge ${badgeClass}" title="${tooltip}">✓</div>`);
        } else if (item.status === 'failed') {
          iconContainer.insertAdjacentHTML('beforeend', '<div class="oauth-wizard-status-badge failed">✗</div>');
        } else if (item.status === 'skipped') {
          iconContainer.insertAdjacentHTML('beforeend', '<div class="oauth-wizard-status-badge skipped">⊘</div>');
        }
      }
    }
  });
}

/**
 * Update the current server display
 */
function updateWizardCurrentServerUI() {
  const item = getCurrentWizardItem();
  if (!item) return;

  const { metadata, status } = item;

  const icon = document.getElementById('oauth-wizard-server-icon');
  const name = document.getElementById('oauth-wizard-server-name');
  const description = document.getElementById('oauth-wizard-server-description');
  const progress = document.getElementById('oauth-wizard-progress-text');
  const statusText = document.getElementById('oauth-wizard-status-text');

  if (icon && metadata.icon) {
    icon.src = metadata.icon;
    icon.alt = metadata.display_name || metadata.name || metadata.id || 'Server';
    icon.dataset.logoKind = getWizardLogoKind(metadata);
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
    progress.textContent = `Server ${oauthWizardState.currentIndex + 1} of ${oauthWizardState.servers.length}`;
  }
  if (statusText) {
    statusText.textContent = getWizardStatusMessage(item);
    statusText.style.display = statusText.textContent ? 'inline' : 'none';
  }

  updateWizardNavigationButtons();
}

/**
 * Update navigation button states
 */
function updateWizardNavigationButtons() {
  const prevBtn = document.getElementById('oauth-wizard-prev-btn');
  const nextBtn = document.getElementById('oauth-wizard-next-btn');
  const skipAllBtn = document.getElementById('oauth-wizard-skip-all-btn');
  const authorizeBtn = document.getElementById('oauth-wizard-authorize-btn');

  if (prevBtn) {
    prevBtn.style.display = 'none';
  }

  const currentItem = getCurrentWizardItem();
  const isProcessed = currentItem && ['done', 'failed', 'skipped'].includes(currentItem.status);
  const isProcessing = isWizardItemProcessing(currentItem) || oauthWizardState.flowLocked;
  const hasLaterPending = findNextPendingWizardServer(oauthWizardState.currentIndex, { wrap: false }) !== -1;

  if (authorizeBtn) {
    authorizeBtn.style.display = (isProcessed || oauthWizardState.queueStarted) ? 'none' : 'inline-flex';
    authorizeBtn.disabled = isProcessed || isProcessing;
    if (isProcessed) {
      if (currentItem.status === 'done') {
        authorizeBtn.textContent = currentItem.preConfigured ? 'Authorized ✓' : 'Connected ✓';
      } else if (currentItem.status === 'skipped') {
        authorizeBtn.textContent = 'Skipped';
      } else {
        authorizeBtn.textContent = 'Failed';
      }
    } else if (isProcessing) {
      authorizeBtn.textContent = 'Connecting...';
    } else {
      authorizeBtn.textContent = 'Connect';
    }
  }

  if (nextBtn) {
    nextBtn.textContent = 'Skip';
    nextBtn.style.display = (!isProcessed && !isProcessing && hasLaterPending) ? 'inline-flex' : 'none';
    nextBtn.disabled = isProcessing;
  }
  if (skipAllBtn) {
    skipAllBtn.textContent = 'Skip All';
    skipAllBtn.style.display = (!isProcessed && !isProcessing && hasLaterPending) ? 'inline-flex' : 'none';
    skipAllBtn.disabled = isProcessing;
  }
}

/**
 * Navigate to a specific server
 */
function navigateWizardToServer(index, options = {}) {
  if (index < 0 || index >= oauthWizardState.servers.length) return;

  const currentItem = getCurrentWizardItem();
  if (oauthWizardState.flowLocked || isWizardItemProcessing(currentItem)) {
    console.log('[OAuth Wizard] Cannot navigate while processing');
    return;
  }

  if (oauthWizardState.currentIndex === index) {
    updateWizardCurrentServerUI();
    updateWizardPreviewBar();
    return;
  }

  hideWizardTestingProgress();

  // Reset current to pending if it was just 'current'
  if (currentItem && currentItem.status === 'current') {
    currentItem.status = 'pending';
  }

  oauthWizardState.currentIndex = index;

  // Set new current status if not already processed
  const newItem = oauthWizardState.servers[index];
  if (newItem && !['done', 'failed', 'skipped'].includes(newItem.status)) {
    newItem.status = 'current';
  }

  updateWizardCurrentServerUI();
  updateWizardPreviewBar();

  const shouldAutoStart =
    Boolean(options.autoStart) ||
    (Boolean(options.fromPreview) && oauthWizardState.queueStarted && newItem?.status === 'current');

  if (shouldAutoStart) {
    scheduleWizardAutoStartForCurrent();
  }
}

/**
 * Find next pending server
 */
function findNextPendingWizardServer(startIndex = oauthWizardState.currentIndex, options = {}) {
  const { wrap = true } = options;
  for (let i = startIndex + 1; i < oauthWizardState.servers.length; i++) {
    if (oauthWizardState.servers[i].status === 'pending') {
      return i;
    }
  }

  if (wrap) {
    for (let i = 0; i < startIndex; i++) {
      if (oauthWizardState.servers[i].status === 'pending') {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Check if all servers are processed
 */
function areAllWizardServersProcessed() {
  return oauthWizardState.servers.every(s => ['done', 'failed', 'skipped'].includes(s.status));
}

function shouldAutoAdvanceAfterWizardSuccess() {
  const modal = document.getElementById('oauth-wizard-modal');
  if (!modal || !modal.classList.contains('visible')) {
    return false;
  }

  const currentItem = getCurrentWizardItem();
  if (!currentItem || currentItem.status !== 'done') {
    return false;
  }

  return findNextPendingWizardServer(oauthWizardState.currentIndex, { wrap: false }) !== -1;
}

function advanceToNextPendingWizardServer() {
  if (oauthWizardState.flowLocked) {
    return;
  }

  const nextPending = findNextPendingWizardServer(oauthWizardState.currentIndex, { wrap: false });
  if (nextPending === -1) {
    handleWizardComplete();
    return;
  }

  hideWizardTestingProgress();
  navigateWizardToServer(nextPending, { autoStart: true });
}

/**
 * Compute final outcome counts from current per-server statuses.
 * This avoids stale counters when a server fails/skips temporarily but is later retried successfully.
 */
function getWizardOutcomeCounts() {
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const server of oauthWizardState.servers) {
    if (server.status === 'done') completed++;
    else if (server.status === 'skipped') skipped++;
    else if (server.status === 'failed') failed++;
  }

  return { completed, skipped, failed };
}

/**
 * Get prod server IDs that should be restarted after OAuth succeeded.
 */
function getWizardServersToRestart() {
  return oauthWizardState.servers
    .filter(
      (server) =>
        server.status === 'done' &&
        !server.preConfigured &&
        !isWizardConfigurationPending(server) &&
        !isWizardBackendManagedServer(getWizardServerId(server)),
    )
    .map((server) => getWizardServerId(server))
    .filter(Boolean);
}

/**
 * Start post-auth recovery for a server on the main Control Plane stack.
 */
function startWizardProdRecovery(serverId, options = {}) {
  const existingTask = oauthWizardProdRecoveryTasks.get(serverId);
  if (existingTask?.promise) {
    return existingTask.promise;
  }

  const wizardItem = findWizardServerItem(serverId);
  if (isWizardConfigurationPending(wizardItem)) {
    const result = {
      success: true,
      serverId,
      state: 'configuration_pending',
      healthy: false,
      toolCount: 0,
      enabledCount: 0,
      error: null,
    };
    const task = {
      serverId,
      state: result.state,
      startedAt: Date.now(),
      result,
      promise: Promise.resolve(result),
    };
    oauthWizardProdRecoveryTasks.set(serverId, task);
    updateWizardServerRecoveryState(serverId, {
      postAuthSyncState: result.state,
      postAuthToolCount: 0,
      postAuthSyncError: null,
    });
    updateVisibleWizardSuccess(serverId, result);
    return task.promise;
  }

  const task = {
    serverId,
    state: 'syncing',
    startedAt: Date.now(),
    result: null,
    promise: null,
  };
  oauthWizardProdRecoveryTasks.set(serverId, task);
  updateWizardServerRecoveryState(serverId, {
    postAuthSyncState: 'syncing',
    postAuthToolCount: 0,
    postAuthSyncError: null,
  });
  window.markMcpServerPostSuccessStarting?.(serverId, {
    label:
      findWizardServerItem(serverId)?.metadata?.display_name || serverId,
    stage: 'checking',
    detail: 'Checking...',
    operationKind: 'post_oauth_recovery',
    postAuthRecovery: true,
  });
  console.log(`[OAuth Wizard] Starting background prod recovery for ${serverId}`);

  task.promise = (async () => {
    try {
      const postOauthReady =
        await window.electronAPI.waitForPostOauthServerRecovery(serverId, {
          maxWaitMs: options.maxWaitMs || 60000,
          pollIntervalMs: options.pollIntervalMs || 1000,
          initialWaitMs: options.initialWaitMs || 2000,
        });

      if (postOauthReady?.success === false) {
        throw new Error(postOauthReady.error || 'Post-auth recovery failed');
      }

      let refreshResult = null;
      if (window.refreshServerAfterOperation) {
        refreshResult = await window.refreshServerAfterOperation(serverId, {
          waitForHealthy: Boolean(postOauthReady?.healthy),
          maxWait: postOauthReady?.healthy ? 5000 : 0,
        });
      }

      const toolCount = Number(refreshResult?.totalCount || 0);
      const enabledCount = Number(refreshResult?.enabledCount || 0);
      const healthy = Boolean(postOauthReady?.healthy || refreshResult?.healthy || toolCount > 0);
      const state = healthy ? 'ready' : 'sync_delayed';
      const result = {
        success: true,
        serverId,
        state,
        healthy,
        toolCount,
        enabledCount,
        waitedSeconds: postOauthReady?.waitedSeconds,
        restartedAfterAuth: Boolean(postOauthReady?.restartedAfterAuth),
        readinessPhase: postOauthReady?.readinessPhase,
        error: postOauthReady?.error || refreshResult?.error || null,
      };

      task.state = state;
      task.result = result;
      updateWizardServerRecoveryState(serverId, {
        postAuthSyncState: state,
        postAuthToolCount: toolCount,
        postAuthSyncError: result.error,
      });
      updateVisibleWizardSuccess(serverId, result);
      console.log(
        `[OAuth Wizard] Background prod recovery finished for ${serverId}: state=${state}, tools=${toolCount}, waited=${result.waitedSeconds || 'n/a'}s`,
      );
      return result;
    } catch (error) {
      const result = {
        success: false,
        serverId,
        state: 'failed',
        healthy: false,
        toolCount: 0,
        enabledCount: 0,
        error: error?.message || String(error),
      };
      task.state = 'failed';
      task.result = result;
      updateWizardServerRecoveryState(serverId, {
        postAuthSyncState: 'failed',
        postAuthToolCount: 0,
        postAuthSyncError: result.error,
      });
      updateVisibleWizardSuccess(serverId, result);
      console.warn(`[OAuth Wizard] Background prod recovery failed for ${serverId}: ${result.error}`);
      return result;
    }
  })();

  return task.promise;
}

/**
 * Wait briefly for post-auth recovery so fast servers can still show a tool count.
 */
async function waitForWizardProdRecoveryGrace(serverId, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 2000;
  const recoveryPromise = startWizardProdRecovery(serverId, options);
  const timeoutResult = { timedOut: true };

  const result = await Promise.race([
    recoveryPromise,
    new Promise((resolve) => setTimeout(() => resolve(timeoutResult), graceMs)),
  ]);

  return result === timeoutResult ? null : result;
}

/**
 * Finalize successful OAuth runs by ensuring background prod recovery has started.
 * Optionally waits for those background jobs to settle.
 */
async function finalizeWizardProdServers(options = {}) {
  if (oauthWizardFinalizationComplete) {
    return { success: true, skipped: true, serversToRestart: [] };
  }

  if (oauthWizardFinalizationPromise) {
    return oauthWizardFinalizationPromise;
  }

  const serversToRestart = getWizardServersToRestart();
  if (serversToRestart.length === 0) {
    oauthWizardFinalizationComplete = true;
    return { success: true, skipped: true, serversToRestart: [] };
  }

  const awaitCompletion = options.awaitCompletion === true;
  const { statsEl, doneBtnEl, finalizingEl } = options;
  if (awaitCompletion) {
    if (statsEl) statsEl.style.display = 'none';
    if (doneBtnEl) doneBtnEl.style.display = 'none';
    if (finalizingEl) finalizingEl.style.display = 'flex';
  }

  oauthWizardFinalizationPromise = (async () => {
    try {
      console.log(`[OAuth Wizard] Finalizing OAuth for prod servers: ${serversToRestart.join(', ')}`);
      const recoveryPromises = serversToRestart.map((serverId) =>
        startWizardProdRecovery(serverId, options),
      );

      if (!awaitCompletion) {
        oauthWizardFinalizationComplete = true;
        return { success: true, started: true, serversToRestart };
      }

      const results = await Promise.allSettled(recoveryPromises);
      const failures = results
        .filter((entry) => entry.status === 'fulfilled' && entry.value?.state === 'failed')
        .map((entry) => entry.value);
      const rejected = results
        .filter((entry) => entry.status === 'rejected')
        .map((entry) => entry.reason);

      oauthWizardFinalizationComplete = true;
      return {
        success: failures.length === 0 && rejected.length === 0,
        serversToRestart,
        results,
        error:
          failures[0]?.error ||
          rejected[0]?.message ||
          null,
      };
    } catch (error) {
      console.error('[OAuth Wizard] Failed to finalize prod recovery:', error);
      return {
        success: false,
        serversToRestart,
        error: error?.message || String(error),
      };
    } finally {
      oauthWizardFinalizationPromise = null;
    }
  })();

  return oauthWizardFinalizationPromise;
}

/**
 * Show testing progress UI
 */
function showWizardTestingProgress(serverName) {
  const buttonsContainer = document.getElementById('oauth-wizard-buttons');
  const progressSection = document.querySelector('.oauth-wizard-progress');
  const testingPane = document.getElementById('oauth-wizard-testing');

  if (buttonsContainer) buttonsContainer.style.display = 'none';
  if (progressSection) progressSection.style.display = 'none';

  if (testingPane) {
    testingPane.style.display = 'block';
    renderWizardTestingSteps();
  }
}

/**
 * Hide testing progress UI
 */
function hideWizardTestingProgress() {
  const buttonsContainer = document.getElementById('oauth-wizard-buttons');
  const progressSection = document.querySelector('.oauth-wizard-progress');
  const testingPane = document.getElementById('oauth-wizard-testing');

  if (testingPane) testingPane.style.display = 'none';
  if (buttonsContainer) buttonsContainer.style.display = 'block';
  if (progressSection) progressSection.style.display = 'flex';
}

/**
 * Render testing steps UI
 */
function renderWizardTestingSteps() {
  const container = document.getElementById('oauth-wizard-testing-content');
  if (!container) return;

  container.innerHTML = `
    <div class="oauth-wizard-test-steps">
      <div class="oauth-wizard-test-step" data-step="standalone">
        <div class="oauth-wizard-test-icon pending">○</div>
        <div class="oauth-wizard-test-content">
          <div class="oauth-wizard-test-title">Starting standalone server</div>
          <div class="oauth-wizard-test-detail">Preparing isolated environment...</div>
        </div>
      </div>
      <div class="oauth-wizard-test-step" data-step="oauth">
        <div class="oauth-wizard-test-icon pending">○</div>
        <div class="oauth-wizard-test-content">
          <div class="oauth-wizard-test-title">Getting OAuth URL</div>
          <div class="oauth-wizard-test-detail">Waiting...</div>
        </div>
      </div>
      <div class="oauth-wizard-test-step" data-step="browser">
        <div class="oauth-wizard-test-icon pending">○</div>
        <div class="oauth-wizard-test-content">
          <div class="oauth-wizard-test-title">Browser authorization</div>
          <div class="oauth-wizard-test-detail">Waiting...</div>
        </div>
      </div>
      <div class="oauth-wizard-test-step" data-step="poll">
        <div class="oauth-wizard-test-icon pending">○</div>
        <div class="oauth-wizard-test-content">
          <div class="oauth-wizard-test-title-row">
            <div class="oauth-wizard-test-title">Waiting for callback</div>
          </div>
          <div class="oauth-wizard-test-detail">Waiting...</div>
          <div class="oauth-wizard-test-action-row">
            <button
              class="oauth-wizard-restart-auth-btn"
              id="oauth-wizard-restart-auth-btn"
              type="button"
              style="display: none;"
            >
              Stuck? Retry
            </button>
          </div>
        </div>
      </div>
      <div class="oauth-wizard-test-step" data-step="verify">
        <div class="oauth-wizard-test-icon pending">○</div>
        <div class="oauth-wizard-test-content">
          <div class="oauth-wizard-test-title">Verifying tokens</div>
          <div class="oauth-wizard-test-detail">Waiting...</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Update a test step's status
 */
function updateWizardTestStep(stepId, status, detail) {
  const step = document.querySelector(`.oauth-wizard-test-step[data-step="${stepId}"]`);
  if (!step) return;

  const iconEl = step.querySelector('.oauth-wizard-test-icon');
  const detailEl = step.querySelector('.oauth-wizard-test-detail');

  // Update step active state
  document.querySelectorAll('.oauth-wizard-test-step').forEach(s => s.classList.remove('active'));
  if (status === 'running') {
    step.classList.add('active');
  }

  if (iconEl) {
    iconEl.className = `oauth-wizard-test-icon ${status}`;
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
  }
}

/**
 * Show/hide the poll restart controls while waiting for callback.
 */
function setWizardPollRestartControls(options = {}) {
  const restartBtn = document.getElementById('oauth-wizard-restart-auth-btn');
  if (!restartBtn) return;

  const visible = Boolean(options.visible);
  if (!visible) {
    restartBtn.style.display = 'none';
    restartBtn.disabled = false;
    restartBtn.textContent = 'Stuck? Retry';
    restartBtn.onclick = null;
    return;
  }

  restartBtn.style.display = 'inline-flex';
  const inProgress = Boolean(options.inProgress);
  restartBtn.disabled = inProgress;
  restartBtn.textContent = inProgress ? 'Retrying...' : 'Stuck? Retry';
  restartBtn.onclick = null;

  if (!inProgress && typeof options.onRestart === 'function') {
    restartBtn.onclick = () => options.onRestart();
  }
}

/**
 * Poll OAuth completion in short chunks so users can request an immediate restart.
 *
 * Accepts an optional `signal` (AbortSignal). When the signal is aborted —
 * typically because a newer OAuth flow has started or the user closed the
 * wizard — the loop exits at the top of the next iteration with
 * `{ aborted: true }`. The caller treats `aborted` as "another flow owns the
 * wizard now" and refrains from updating shared DOM/state.
 */
async function pollWizardOAuthCompletionWithManualRestart(serverId, options = {}) {
  const timeoutMs = options.timeoutMs || WIZARD_OAUTH_FLOW_TIMEOUT_MS;
  const chunkTimeoutMs = options.chunkTimeoutMs || 2000;
  const shouldRestart = typeof options.shouldRestart === 'function'
    ? options.shouldRestart
    : () => false;
  const onProgress = options.onProgress;
  const signal = options.signal || null;
  const startTime = Date.now();
  let lastResult = { success: false, timeout: true };

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      return { aborted: true };
    }
    if (shouldRestart()) {
      return { restartRequested: true };
    }

    const elapsedMs = Date.now() - startTime;
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const pollWindowMs = Math.max(2000, Math.min(chunkTimeoutMs, remainingMs));
    const result = await window.electronAPI.pollOAuthCompletionSingle(
      serverId,
      pollWindowMs,
      { sessionId: options.sessionId },
    );
    lastResult = result || lastResult;

    if (signal?.aborted) {
      return { aborted: true };
    }

    if (result?.completed || result?.failed) {
      return result;
    }

    if (shouldRestart()) {
      return { restartRequested: true };
    }

    if (!result?.timeout) {
      return result || { success: false, timeout: true };
    }

    // result.timeout === true means "the orchestrator still has the server
    // in waiting_callback after a clean /oauth/status read". We do NOT
    // auto-fail on this — the user might be reading the consent screen
    // or on slow Wi-Fi. The "Stuck? Retry" button is the user-driven
    // escape hatch. The outer 10-min WIZARD_OAUTH_FLOW_TIMEOUT_MS catches
    // truly abandoned modals.
    if (onProgress) {
      onProgress(Math.round((Date.now() - startTime) / 1000), lastResult);
    }
  }

  return { ...lastResult, success: false, timeout: true };
}

/**
 * Restart single-server OAuth session and reopen browser with a fresh auth URL.
 */
async function restartWizardOAuthSession(serverId, currentSessionId) {
  try {
    await window.electronAPI.stopSingleMcpServer(serverId, {
      sessionId: currentSessionId,
    });
  } catch (e) {
    console.warn('[OAuth Wizard] Failed to stop server during manual restart:', e);
  }

  await prepareWizardForFreshOAuthStart(serverId);

  const restartResult = await window.electronAPI.startSingleMcpServer(
    serverId,
    { oauthMode: 'bootstrap' },
  );
  if (!restartResult.success) {
    const restartError = new Error(restartResult.error || 'Failed to restart standalone server');
    restartError.code = restartResult.errorCode || null;
    throw restartError;
  }

  const sessionId = restartResult.sessionId;
  try {
    const oauthReady = await waitForWizardOAuthReady(
      serverId,
      45000,
      sessionId,
    );
    if (!oauthReady.ready || !oauthReady.authUrl) {
      throw new Error('OAuth URL not ready after restart');
    }

    console.log(
      `[OAuth Wizard] Reopening browser after manual restart for ${serverId} (session=${sessionId})`,
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
      console.warn('[OAuth Wizard] Failed to stop unsuccessful restarted session:', stopError);
    }
    throw error;
  }
}

async function prepareWizardForFreshOAuthStart(serverId) {
  if (!window.electronAPI?.prepareOAuthStart) {
    console.warn('[OAuth Wizard] prepareOAuthStart IPC is unavailable; continuing without clearing bootstrap state');
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
    `[OAuth Wizard] Prepared fresh OAuth flow for ${serverId}: preservedSecureRecord=true cleared=${Boolean(prepareResult.cleared)}, tokenFiles=${tokenFilesCleared}, clientFiles=${clientFilesCleared}`,
  );
}

/**
 * Wait for OAuth to be ready (authorization URL available)
 */
async function waitForWizardOAuthReady(serverId, timeout = 45000, sessionId) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeout) {
    try {
      const oauthStatus = await window.electronAPI.getOAuthStatusSingle({
        sessionId,
      });

      // Check various status arrays for auth URL
      const serverStatus = oauthStatus.active?.find(s => s.server_name === serverId);
      if (serverStatus && serverStatus.authorization_url) {
        return { ready: true, authUrl: serverStatus.authorization_url };
      }

      const waitingCallback = oauthStatus.waiting_callback?.find(s => s.server_name === serverId);
      if (waitingCallback && waitingCallback.authorization_url) {
        return { ready: true, authUrl: waitingCallback.authorization_url };
      }

      if (oauthStatus.current?.server_name === serverId && oauthStatus.current.authorization_url) {
        return { ready: true, authUrl: oauthStatus.current.authorization_url };
      }
    } catch (e) {
      // Continue polling
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    updateWizardTestStep('standalone', 'running', `Waiting for OAuth... (${elapsed}s)`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { ready: false };
}

/**
 * Extract authorization URL from OAuth status
 */
function extractWizardAuthUrl(oauthStatus, serverId) {
  if (!oauthStatus) return null;

  if (oauthStatus.current?.authorization_url) {
    if (oauthStatus.current.server_name === serverId ||
        oauthStatus.current.server_name?.toLowerCase() === serverId?.toLowerCase()) {
      return oauthStatus.current.authorization_url;
    }
  }

  if (oauthStatus.waiting_callback) {
    const server = oauthStatus.waiting_callback.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  if (oauthStatus.active) {
    const server = oauthStatus.active.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  if (oauthStatus.pending) {
    const server = oauthStatus.pending.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  return null;
}

/**
 * Escape HTML special characters
 */
function escapeWizardHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Redact OAuth authorization URLs from any text destined for the UI.
 *
 * mcp-orc's `surfacing first auth-like tool error without retry` log line
 * embeds the full IdP authorization URL (with code_challenge, state, scope,
 * client_id, etc.). When that line shows up in container logs we render in
 * the wizard's "Oops" card, the URL becomes user-visible — confusing the user
 * into thinking the recovery itself failed and exposing query-string params
 * that should not be in screenshots.
 *
 * Strip every `authorization_url=<URL>` occurrence (URL ends at the next
 * whitespace, quote, or end-of-line). Preserves the surrounding log context
 * so the user can still see WHAT happened, just not the raw URL.
 */
function redactWizardOAuthAuthUrls(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // `authorization_url=https://...` (terminated by whitespace or quote)
    .replace(/authorization_url=[^\s'"`]+/g, 'authorization_url=<redacted>')
    // `"authorization_url": "https://..."` (JSON-style)
    .replace(/("authorization_url"\s*:\s*)"[^"]*"/g, '$1"<redacted>"');
}

/**
 * Show testing error with container logs
 */
async function showWizardTestingError(errorMessage, serverId, sessionId, options = {}) {
  const container = document.getElementById('oauth-wizard-testing-content');
  if (!container) return false;

  const stepsHtml = container.querySelector('.oauth-wizard-test-steps')?.outerHTML || '';
  const isContractor = _isCurrentUserContractor();
  const is4xx = typeof errorMessage === 'string' && /HTTP [4]\d{2}/.test(errorMessage);
  const isOAuthDenied = typeof errorMessage === 'string' &&
    /access.denied|unauthorized.client|invalid_scope|permission|forbidden/i.test(errorMessage);
  const isStaleNoCallback = typeof errorMessage === 'string' &&
    errorMessage.includes('no callback received');
  const isPermissionsIssue = is4xx || isOAuthDenied || isStaleNoCallback;
  const isDataPlatMcp = serverId === 'data-plat-mcp';
  const isMcpBusy = options.errorCode === 'MCP_OPERATION_BUSY';
  console.log(`[OAuth Wizard] Error triage: isContractor=${isContractor}, isPermissionsIssue=${isPermissionsIssue} (is4xx=${is4xx}, isOAuthDenied=${isOAuthDenied}, isStaleNoCallback=${isStaleNoCallback}), isDataPlatMcp=${isDataPlatMcp}, isMcpBusy=${isMcpBusy}, serverId=${serverId}, msg="${errorMessage}"`);

  if (isContractor && isPermissionsIssue && isDataPlatMcp) {
    const item = getCurrentWizardItem();
    if (item) {
      item.status = 'skipped';
      oauthWizardState.skippedCount++;
      settleWizardRequestedServer(getWizardServerId(item));
      updateWizardPreviewBar();
    }

    oauthWizardState.contractorDeniedServerIds.add(serverId);
    if (window.electronAPI?.notifyOAuthContractorDenied) {
      window.electronAPI.notifyOAuthContractorDenied(serverId);
      console.log(`[OAuth Wizard] Sent contractor-denied signal for ${serverId} — blocking auto-retries until wizard close`);
    }

    container.innerHTML = `
      <div class="oauth-wizard-test-container" style="pointer-events:auto;cursor:default">
        <div class="oauth-wizard-steps-panel">
          ${stepsHtml}
        </div>
        <div class="oauth-wizard-error-panel">
          <div class="oauth-wizard-error-header">
            <span class="oauth-wizard-error-icon" style="color:#e5a100">⚠</span>
            <span class="oauth-wizard-error-title">Additional Permissions Required</span>
          </div>
          <div style="padding:12px 16px;font-size:13px;line-height:1.6;color:#ccc">
            <p style="margin:0 0 10px">Your account type (<strong>contractor</strong>) requires additional permissions to use this integration.</p>
            <p style="margin:0 0 10px">To request access, create a Jira ticket using the link below. The team will grant the necessary permissions for your account.</p>
            <a href="${escapeWizardHtml(_PERMISSIONS_JIRA_URL)}" target="_blank" rel="noopener noreferrer"
               style="display:inline-block;margin:4px 0 10px;padding:8px 14px;background:#1a6fb5;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;cursor:pointer"
               id="oauth-wizard-jira-link">
              Create Permissions Request
            </a>
            <p style="margin:10px 0 0;font-size:12px;color:#999">You can also reach out in <strong>#help-llm</strong> for assistance.</p>
          </div>
          <div class="oauth-wizard-error-actions">
            <button class="oauth-wizard-btn oauth-wizard-btn-primary" id="oauth-wizard-contractor-done-btn" style="cursor:pointer">
              ${oauthWizardState.servers.length === 1 || areAllWizardServersProcessed() ? 'Close' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    `;

    // Safety: dismiss any stuck loading overlay and reset cursor style that may
    // have been left behind by a prior drag operation or background task.
    resetOAuthWizardInteractionState();

    // Deferred re-application: the onOAuthFlowCompleted IPC fires async and
    // can trigger closeOAuthModal() which may re-block cursor/pointer state.
    // Re-apply resets after a short delay to win the race.
    setTimeout(() => {
      resetOAuthWizardInteractionState();
    }, 500);

    const jiraLink = document.getElementById('oauth-wizard-jira-link');
    if (jiraLink) {
      jiraLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.electronAPI && window.electronAPI.openExternal) {
          window.electronAPI.openExternal(_PERMISSIONS_JIRA_URL);
        }
      });
    }

    const doneBtn = document.getElementById('oauth-wizard-contractor-done-btn');
    if (doneBtn) {
      doneBtn.onclick = () => {
        hideWizardTestingProgress();
        if (oauthWizardState.servers.length === 1) {
          closeWizardModal();
        } else if (areAllWizardServersProcessed()) {
          handleWizardComplete();
        } else {
          const nextPending = findNextPendingWizardServer(oauthWizardState.currentIndex, { wrap: false });
          if (nextPending !== -1) {
            navigateWizardToServer(nextPending, { autoStart: true });
          } else {
            handleWizardComplete();
          }
        }
      };
    }
    return true;
  }

  // Generic error path for non-contractor or non-permission errors
  resetOAuthWizardInteractionState();

  // A busy mutation lease means no container was ever started, so there are
  // no logs to fetch — and the failure is transient, so show wait-and-retry
  // guidance instead of the generic error (screen-finalize.js precedent).
  let containerLogs = '';
  if (!isMcpBusy) {
    try {
      const logsResult = await window.electronAPI.getWizardMcpServerLogs(
        serverId,
        100,
        { sessionId },
      );
      containerLogs = logsResult.logs || '';
    } catch (e) {
      console.warn('[OAuth Wizard] Failed to get container logs:', e);
      containerLogs = 'Failed to retrieve logs';
    }
    // Strip embedded IdP authorization URLs before rendering — see
    // redactWizardOAuthAuthUrls for rationale.
    containerLogs = redactWizardOAuthAuthUrls(containerLogs);
  }

  const logsSection = isMcpBusy ? '' : `
    <div class="oauth-wizard-logs-container">
      <div class="oauth-wizard-logs-header">
        <span>Container Logs</span>
        <button class="oauth-wizard-copy-btn" id="oauth-wizard-copy-logs-btn" title="Copy to clipboard">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      </div>
      <pre class="oauth-wizard-logs-content" id="oauth-wizard-logs-content">${escapeWizardHtml(containerLogs)}</pre>
    </div>
  `;

  const errorHeader = isMcpBusy
    ? `<span class="oauth-wizard-error-icon" style="color:#e5a100">⚠</span>
          <span class="oauth-wizard-error-title">A previous change is still finishing</span>`
    : `<span class="oauth-wizard-error-icon">✗</span>
          <span class="oauth-wizard-error-title">Oops. Something went wrong.</span>`;
  const errorBody = isMcpBusy
    ? `<div style="padding:12px 16px;font-size:13px;line-height:1.6;color:#ccc">
          <p style="margin:0 0 10px">${escapeWizardHtml(errorMessage)}</p>
          <p style="margin:0">Wait a few seconds and press Retry.</p>
        </div>`
    : '';

  container.innerHTML = `
    <div class="oauth-wizard-test-container">
      <div class="oauth-wizard-steps-panel">
        ${stepsHtml}
      </div>
      <div class="oauth-wizard-error-panel">
        <div class="oauth-wizard-error-header">
          ${errorHeader}
        </div>
        ${errorBody}
        <div class="oauth-wizard-error-actions">
          <button class="oauth-wizard-btn oauth-wizard-btn-secondary" id="oauth-wizard-retry-btn">Retry</button>
          <button class="oauth-wizard-btn oauth-wizard-btn-secondary" id="oauth-wizard-back-btn">Back</button>
        </div>
      </div>
      ${logsSection}
    </div>
  `;

  const logsContent = document.getElementById('oauth-wizard-logs-content');
  if (logsContent) {
    logsContent.scrollTop = logsContent.scrollHeight;
  }

  const copyBtn = document.getElementById('oauth-wizard-copy-logs-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await window.electronAPI.copyToClipboard(containerLogs);
        const textSpan = copyBtn.querySelector('span');
        if (textSpan) {
          textSpan.textContent = 'Copied!';
          setTimeout(() => {
            textSpan.textContent = 'Copy';
          }, 2000);
        }
      } catch (e) {
        console.warn('[OAuth Wizard] Failed to copy to clipboard:', e);
      }
    });
  }

  const retryBtn = document.getElementById('oauth-wizard-retry-btn');
  const backBtn = document.getElementById('oauth-wizard-back-btn');

  if (retryBtn) {
    retryBtn.onclick = () => {
      hideWizardTestingProgress();
      const item = getCurrentWizardItem();
      if (item) {
        item.status = 'current';
        updateWizardCurrentServerUI();
        updateWizardPreviewBar();
        if (oauthWizardState.queueStarted) {
          scheduleWizardAutoStartForCurrent();
        }
      }
    };
  }

  if (backBtn) {
    backBtn.onclick = () => {
      hideWizardTestingProgress();
      const item = getCurrentWizardItem();
      if (item && item.status !== 'done' && item.status !== 'skipped') {
        item.status = 'current';
        updateWizardCurrentServerUI();
        updateWizardPreviewBar();
        if (oauthWizardState.queueStarted) {
          scheduleWizardAutoStartForCurrent();
        }
      }
    };
  }
  return false;
}

/**
 * Show testing success with Next button
 */
function showWizardTestingSuccess(serverName, options = {}) {
  const container = document.getElementById('oauth-wizard-testing-content');
  if (!container) return;

  const {
    serverId = '',
    toolCount = 0,
    syncState = 'ready',
    error = null,
  } = options;
  let detail = `${serverName} is now connected${toolCount > 0 ? ` with ${toolCount} tools available` : ''}.`;

  if (syncState === 'syncing') {
    detail = `${serverName} is authorized. Tools are syncing on the Control Plane in the background.`;
  } else if (syncState === 'configuration_pending') {
    detail = `${serverName} is authorized. Complete configuration from the Control Plane to finish setup.`;
  } else if (syncState === 'sync_delayed') {
    detail = `${serverName} is authorized. Tool sync is taking longer than usual and will continue in the background.`;
  } else if (syncState === 'failed') {
    detail = `${serverName} is authorized, but tool sync hit an error and may need a retry from Control Plane.`;
  }

  container.innerHTML = `
    <div class="oauth-wizard-success" data-server-id="${escapeWizardHtml(serverId)}">
      <div class="oauth-wizard-success-icon">✓</div>
      <div class="oauth-wizard-success-title">Authorization Successful!</div>
      <div class="oauth-wizard-success-detail">
        ${detail}
      </div>
      ${error ? `<div class="oauth-wizard-success-detail">${escapeWizardHtml(error)}</div>` : ''}
      <button class="oauth-wizard-btn oauth-wizard-btn-primary oauth-wizard-next-btn" id="oauth-wizard-success-next-btn">Continue →</button>
    </div>
  `;
}

/**
 * Upgrade the visible success card if background prod recovery finishes while the
 * user is still on the current server.
 */
function updateVisibleWizardSuccess(serverId, recoveryResult) {
  const container = document.getElementById('oauth-wizard-testing-content');
  const successCard = container?.querySelector('.oauth-wizard-success');
  if (!successCard) return;
  if (successCard.dataset.serverId !== serverId) return;

  const serverItem = findWizardServerItem(serverId);
  if (!serverItem) return;

  const detailEl = successCard.querySelector('.oauth-wizard-success-detail');
  if (!detailEl) return;

  if (recoveryResult?.state === 'ready' && recoveryResult.toolCount > 0) {
    detailEl.textContent = `${serverItem.metadata.display_name || serverId} is now connected with ${recoveryResult.toolCount} tools available.`;
  } else if (recoveryResult?.state === 'configuration_pending') {
    detailEl.textContent = `${serverItem.metadata.display_name || serverId} is authorized. Complete configuration from the Control Plane to finish setup.`;
  } else if (recoveryResult?.state === 'sync_delayed') {
    detailEl.textContent = `${serverItem.metadata.display_name || serverId} is authorized. Tool sync is taking longer than usual and will continue in the background.`;
  } else if (recoveryResult?.state === 'failed') {
    detailEl.textContent = `${serverItem.metadata.display_name || serverId} is authorized, but tool sync hit an error and may need a retry from Control Plane.`;
  }
}

/**
 * Handle authorize button click - Uses single-server stack
 */
async function handleWizardAuthorize() {
  const item = getCurrentWizardItem();
  if (!item || oauthWizardState.flowLocked) return;

  const serverId = item.server.id || item.server.server_name;
  console.log(`[OAuth Wizard] Starting OAuth for ${serverId}`);

  // Abort any prior poll loop owned by a previous server flow. This stops
  // a leftover "Waiting for callback (Ns)" ticker from leaking its elapsed
  // counter into this fresh flow's DOM updates.
  if (oauthWizardState.activePollAbortController) {
    try {
      oauthWizardState.activePollAbortController.abort();
    } catch (e) {
      console.warn('[OAuth Wizard] Failed to abort prior poll controller:', e);
    }
  }
  const pollAbortController = new AbortController();
  oauthWizardState.activePollAbortController = pollAbortController;

  oauthWizardState.queueStarted = true;
  oauthWizardState.flowLocked = true;
  oauthWizardState.pendingAutoStartIndex = null;

  // Update status
  item.status = 'starting';
  item.postAuthSyncState = 'idle';
  item.postAuthToolCount = 0;
  item.postAuthSyncError = null;
  oauthWizardProdRecoveryTasks.delete(serverId);
  updateWizardCurrentServerUI();
  updateWizardPreviewBar();

  // Show testing progress UI
  showWizardTestingProgress(item.metadata.display_name || serverId);

  let singleServerSessionId = null;
  try {
    // Step 1: Start isolated test server
    if (shouldReuseBackendPreparedOAuthState(serverId)) {
      updateWizardTestStep('standalone', 'running', 'Using prepared OAuth state...');
    } else {
      updateWizardTestStep('standalone', 'running', 'Preparing OAuth state...');
      await prepareWizardForFreshOAuthStart(serverId);
    }
    updateWizardTestStep('standalone', 'running', 'Starting test server...');
    console.log(`[OAuth Wizard] Starting single MCP server for ${serverId}...`);

    const startResult = await window.electronAPI.startSingleMcpServer(
      serverId,
      { oauthMode: 'bootstrap' },
    );
    console.log(`[OAuth Wizard] Start server result:`, startResult);

    if (!startResult.success) {
      const startError = new Error(startResult.error || 'Failed to start test server');
      startError.code = startResult.errorCode || null;
      startError.activeMutation = startResult.activeMutation || null;
      throw startError;
    }
    singleServerSessionId = startResult.sessionId;
    updateWizardTestStep('standalone', 'running', 'Waiting for OAuth to be ready...');

    // Wait for OAuth to be ready
    console.log(`[OAuth Wizard] Waiting for OAuth status...`);
    const oauthReadyResult = await waitForWizardOAuthReady(
      serverId,
      45000,
      singleServerSessionId,
    );
    if (!oauthReadyResult.ready) {
      let containerLogs = '';
      try {
        const logsResult = await window.electronAPI.getWizardMcpServerLogs(
          serverId,
          100,
          { sessionId: singleServerSessionId },
        );
        containerLogs = logsResult.logs || '';
      } catch (e) {
        console.warn('[OAuth Wizard] Failed to get container logs:', e);
      }
      updateWizardTestStep('standalone', 'failed', 'Server initialization failed');
      throw new Error(containerLogs || 'OAuth initialization timed out');
    }
    updateWizardTestStep('standalone', 'success', 'Server ready');

    // Step 2: Get OAuth authorization URL
    updateWizardTestStep('oauth', 'running', 'Getting authorization URL...');
    console.log(`[OAuth Wizard] Getting OAuth status from single-server stack...`);

    let authUrl = oauthReadyResult.authUrl;

    // Get full OAuth status
    const oauthStatus = await window.electronAPI.getOAuthStatusSingle({
      sessionId: singleServerSessionId,
    });
    console.log(
      `[OAuth Wizard] Single-server OAuth status for ${serverId}: ` +
        `active=${oauthStatus?.active?.length || 0} ` +
        `waiting=${oauthStatus?.waiting_callback?.length || 0} ` +
        `completed=${oauthStatus?.completed?.length || 0} ` +
        `failed=${oauthStatus?.failed?.length || 0}`,
    );

    // Check if already authorized
    if (oauthStatus && oauthStatus.completed) {
      const completedServer = oauthStatus.completed.find(s => s.server_name === serverId);
      if (completedServer && completedServer.state === 'completed') {
        console.log(`[OAuth Wizard] Server ${serverId} is already authorized`);
        updateWizardTestStep('oauth', 'success', 'Already authorized');
        await handleWizardOAuthVerification(serverId, item);
        return;
      }
    }

    // Get auth URL if needed
    if (!authUrl) {
      authUrl = extractWizardAuthUrl(oauthStatus, serverId);
    }

    if (!authUrl) {
      console.log(`[OAuth Wizard] No auth URL, trying refresh...`);
      try {
        const refreshResult = await window.electronAPI.refreshOAuthUrlSingle(
          serverId,
          { sessionId: singleServerSessionId },
        );
        console.log(
          `[OAuth Wizard] Refresh result for ${serverId}: success=${refreshResult?.success === true}`,
        );
        if (refreshResult && refreshResult.success && refreshResult.authorization_url) {
          authUrl = refreshResult.authorization_url;
        }
      } catch (e) {
        console.warn('[OAuth Wizard] Refresh failed:', e);
      }
    }

    if (!authUrl) {
      updateWizardTestStep('oauth', 'failed', 'No authorization URL available');
      throw new Error('No authorization URL available');
    }

    updateWizardTestStep('oauth', 'success', 'Authorization URL ready');

    // Step 3: Open browser
    updateWizardTestStep('browser', 'running', 'Opening browser for authorization...');
    console.log(
      `[OAuth Wizard] Opening browser for ${serverId} (session=${singleServerSessionId})`,
    );

    // Open browser and simultaneously probe the auth URL for immediate 4xx detection.
    // The probe runs from the main process (no CORS) and returns the HTTP status.
    const [, probeResult] = await Promise.all([
      window.electronAPI.openExternal(authUrl, {
        kind: 'oauth',
        event: 'authorization_opened',
        serverId,
        sessionId: singleServerSessionId,
      }),
      window.electronAPI.probeUrlStatus(authUrl).catch((e) => {
        console.warn('[OAuth Wizard] Auth URL probe failed:', e);
        return null;
      }),
    ]);

    if (probeResult?.success) {
      const probeStatus = probeResult.status;
      const is4xx = probeStatus >= 400 && probeStatus < 500;
      console.log(
        `[OAuth Wizard] Auth URL probe: HTTP ${probeStatus}, is4xx=${is4xx}, serverId=${serverId}`,
      );

      if (is4xx && _isCurrentUserContractor() && serverId === 'data-plat-mcp') {
        updateWizardTestStep('browser', 'failed', `Authorization denied (HTTP ${probeStatus})`);
        throw new Error(`Authorization denied — HTTP ${probeStatus} from authorization provider`);
      }
    }

    updateWizardTestStep('browser', 'success', 'Browser opened - please authorize');

    // Step 4: Poll for OAuth completion
    updateWizardTestStep('poll', 'running', 'Waiting for authorization callback...');
    console.log(`[OAuth Wizard] Polling for OAuth completion...`);

    item.status = 'waiting';
    updateWizardPreviewBar();

    let pollResult = null;
    try {
      while (true) {
        let restartRequested = false;
        setWizardPollRestartControls({
          visible: true,
          onRestart: () => {
            if (!restartRequested) {
              restartRequested = true;
              setWizardPollRestartControls({ visible: true, inProgress: true });
              updateWizardTestStep('poll', 'running', 'Restart requested. Reinitializing authorization...');
            }
          }
        });

        const currentPollResult = await pollWizardOAuthCompletionWithManualRestart(serverId, {
          sessionId: singleServerSessionId,
          timeoutMs: WIZARD_OAUTH_FLOW_TIMEOUT_MS,
          chunkTimeoutMs: 2000,
          shouldRestart: () => restartRequested,
          signal: pollAbortController.signal,
          onProgress: (elapsedSeconds, progress) => {
            if (!restartRequested && !pollAbortController.signal.aborted) {
              const detail = progress?.checking
                ? 'Verifying authorization...'
                : 'Waiting for authorization callback...';
              updateWizardTestStep('poll', 'running', `${detail} (${elapsedSeconds}s)`);
            }
          }
        });

        if (currentPollResult.aborted) {
          // Newer OAuth flow took ownership; bail without touching shared state.
          console.log(`[OAuth Wizard] Poll loop for ${serverId} aborted (newer flow or modal close)`);
          return;
        }

        if (currentPollResult.restartRequested) {
          updateWizardTestStep('poll', 'running', 'Restarting authorization flow...');
          singleServerSessionId = await restartWizardOAuthSession(
            serverId,
            singleServerSessionId,
          );
          updateWizardTestStep('browser', 'success', 'Browser reopened - please authorize');
          updateWizardTestStep('poll', 'running', 'Waiting for authorization callback...');
          item.status = 'waiting';
          updateWizardPreviewBar();
          continue;
        }

        pollResult = currentPollResult;
        break;
      }
    } finally {
      setWizardPollRestartControls({ visible: false });
    }

    console.log(
      `[OAuth Wizard] Poll result for ${serverId}: completed=${pollResult?.completed === true} failed=${pollResult?.failed === true} timeout=${pollResult?.timeout === true}`,
    );

    if (pollResult.failed) {
      updateWizardTestStep('poll', 'failed', pollResult.server?.error_message || 'Authorization failed');
      throw new Error(pollResult.server?.error_message || 'Authorization failed');
    }

    if (pollResult.timeout) {
      updateWizardTestStep('poll', 'failed', 'Authorization timeout');
      throw new Error('Authorization timeout - please try again');
    }

    if (!pollResult.completed) {
      updateWizardTestStep('poll', 'failed', 'Authorization not completed');
      throw new Error('Authorization was not completed');
    }

    updateWizardTestStep('poll', 'success', 'Authorization complete');

    // Verify token files are persisted (not just OAuth state marked completed)
    updateWizardTestStep('verify', 'running', 'Waiting for tokens to persist...');
    const tokenPersistence = await waitForWizardOAuthTokensPersisted(serverId, {
      timeoutMs: 15000,
      pollIntervalMs: 250,
      onProgress: (elapsedSeconds) => {
        updateWizardTestStep('verify', 'running', `Waiting for tokens to persist... (${elapsedSeconds}s)`);
      }
    });

    if (!tokenPersistence.persisted) {
      // DCR OAuth handling - re-authenticate
      const reason = tokenPersistence.result?.reason || 'unknown';
      console.log(`[OAuth Wizard] Tokens not found for ${serverId} (reason=${reason}), triggering re-auth...`);
      updateWizardTestStep('verify', 'running', 'Re-authenticating (session remembered)...');

      try {
        await window.electronAPI.stopSingleMcpServer(serverId, {
          sessionId: singleServerSessionId,
        });
        singleServerSessionId = null;
        await prepareWizardForFreshOAuthStart(serverId);

        const restartResult = await window.electronAPI.startSingleMcpServer(
          serverId,
          { oauthMode: 'bootstrap' },
        );
        if (!restartResult.success) {
          const restartError = new Error(
            restartResult.error || 'Failed to restart for re-auth',
          );
          restartError.code = restartResult.errorCode || null;
          throw restartError;
        }
        singleServerSessionId = restartResult.sessionId;

        const reAuthReady = await waitForWizardOAuthReady(
          serverId,
          45000,
          singleServerSessionId,
        );
        if (!reAuthReady.ready) {
          throw new Error('Re-auth failed to initialize');
        }

        if (reAuthReady.authUrl) {
          console.log(
            `[OAuth Wizard] Opening browser for re-auth for ${serverId} (session=${singleServerSessionId})`,
          );
          await window.electronAPI.openExternal(reAuthReady.authUrl, {
            kind: 'oauth',
            event: 'reauthorization_opened',
            serverId,
            sessionId: singleServerSessionId,
          });
        }

        const reAuthPoll = await window.electronAPI.pollOAuthCompletionSingle(
          serverId,
          WIZARD_OAUTH_FLOW_TIMEOUT_MS,
          { sessionId: singleServerSessionId },
        );
        if (!reAuthPoll.completed) {
          throw new Error('Re-authentication failed or timed out');
        }

        const reAuthTokenPersistence = await waitForWizardOAuthTokensPersisted(serverId, {
          timeoutMs: 15000,
          pollIntervalMs: 250,
          onProgress: (elapsedSeconds) => {
            updateWizardTestStep('verify', 'running', `Completing re-authentication... (${elapsedSeconds}s)`);
          }
        });
        if (!reAuthTokenPersistence.persisted) {
          const reAuthReason = reAuthTokenPersistence.result?.reason || 'unknown';
          throw new Error(`Re-authentication completed but tokens still not saved (${reAuthReason})`);
        }

        console.log(`[OAuth Wizard] Re-auth successful, tokens verified for ${serverId}`);
        updateWizardTestStep('verify', 'running', 'Re-authentication complete');
      } catch (reAuthError) {
        console.error(`[OAuth Wizard] Re-auth failed for ${serverId}:`, reAuthError);
        updateWizardTestStep('verify', 'failed', 'Re-authentication failed');
        throw new Error(`Re-authentication failed: ${reAuthError.message}`);
      }
    }

    // Handle token verification
    await handleWizardOAuthVerification(serverId, item);

  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error || 'OAuth failed');
    console.error(`[OAuth Wizard] OAuth error for ${serverId}:`, error);
    const handledAsContractor = await showWizardTestingError(
      errorMessage,
      serverId,
      singleServerSessionId,
      { errorCode: error?.code || null },
    );
    if (!handledAsContractor) {
      markWizardCurrentAsFailed(errorMessage);
    }
  } finally {
    // Cleanup - stop the single server (always safe, scoped to this serverId)
    try {
      console.log(`[OAuth Wizard] Stopping single MCP server for ${serverId}...`);
      await window.electronAPI.stopSingleMcpServer(serverId, {
        sessionId: singleServerSessionId,
      });
    } catch (e) {
      console.warn('[OAuth Wizard] Failed to stop test server:', e);
    }

    // The shared wizard state (flowLocked, advance pointers, controller, etc.)
    // belongs to *whichever* flow currently owns the wizard. If a newer flow
    // has taken over (oauthWizardState.activePollAbortController has been
    // replaced), we must NOT touch any of those fields — doing so would
    // release the new flow's lock and queue advances on its behalf.
    const stillOwnsWizard =
      oauthWizardState.activePollAbortController === pollAbortController;
    if (!stillOwnsWizard) {
      console.log(
        `[OAuth Wizard] Skipping shared-state cleanup for ${serverId}; a newer flow has taken over the wizard`,
      );
      return;
    }

    oauthWizardState.activePollAbortController = null;
    oauthWizardState.flowLocked = false;
    if (shouldAutoAdvanceAfterWizardSuccess()) {
      advanceToNextPendingWizardServer();
    } else if (getCurrentWizardItem()?.status === 'done') {
      if (oauthWizardState.flowSource === 'backend-requested' && areAllWizardServersProcessed()) {
        setTimeout(() => handleWizardComplete(), 500);
      } else {
        wireUpWizardNextButton();
      }
    } else {
      updateWizardNavigationButtons();
    }
  }
}

/**
 * Wait until OAuth token files are persisted to disk.
 * Uses IPC token check which validates both *_tokens.json and *_client.json.
 */
async function waitForWizardOAuthTokensPersisted(serverId, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const pollIntervalMs = options.pollIntervalMs || 250;
  const onProgress = options.onProgress;
  const startTime = Date.now();
  let lastResult = { exists: false, reason: 'unknown' };

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await window.electronAPI.checkOAuthTokensExist(serverId);
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
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return {
    persisted: false,
    elapsedMs: Date.now() - startTime,
    result: lastResult
  };
}

/**
 * Handle OAuth verification after successful authorization
 */
async function handleWizardOAuthVerification(serverId, item) {
  // Step 1: Wait for token files to persist
  updateWizardTestStep('verify', 'running', 'Waiting for tokens to persist...');
  const tokenPersistence = await waitForWizardOAuthTokensPersisted(serverId, {
    timeoutMs: 15000,
    pollIntervalMs: 250,
    onProgress: (elapsedSeconds) => {
      updateWizardTestStep('verify', 'running', `Waiting for tokens to persist... (${elapsedSeconds}s)`);
    }
  });

  if (!tokenPersistence.persisted) {
    const reason = tokenPersistence.result?.reason || 'unknown';
    updateWizardTestStep('verify', 'failed', 'Tokens were not persisted');
    throw new Error(`OAuth completed but tokens were not persisted (${reason})`);
  }

  const configurationPending = isWizardConfigurationPending(item);
  window.markMcpServerOAuthAuthenticated?.(serverId, {
    configurationPending,
  });
  const backendManaged = isWizardBackendManagedServer(serverId);
  if (backendManaged) {
    notifyBackendOAuthCompletionOnce(serverId);
  }

  if (configurationPending) {
    console.log(
      `[OAuth Wizard] Tokens persisted for ${serverId}; configuration remains pending`,
    );
    updateWizardServerRecoveryState(serverId, {
      postAuthSyncState: 'configuration_pending',
      postAuthToolCount: 0,
      postAuthSyncError: null,
    });
    updateWizardTestStep('verify', 'success', 'Authorized — configuration required');
    showWizardTestingSuccess(item.metadata.display_name || serverId, {
      serverId,
      syncState: 'configuration_pending',
    });
  } else if (backendManaged) {
    console.log(
      `[OAuth Wizard] Tokens persisted for ${serverId} after ${Math.round(tokenPersistence.elapsedMs / 1000)}s; backend request will finish main-stack recovery`,
    );
    updateWizardServerRecoveryState(serverId, {
      postAuthSyncState: 'backend_managed',
      postAuthToolCount: 0,
      postAuthSyncError: null,
    });
    updateWizardTestStep('verify', 'success', 'Connected — finishing in the background');
    showWizardTestingSuccess(item.metadata.display_name || serverId, {
      serverId,
      syncState: 'syncing',
    });
  } else {
    console.log(
      `[OAuth Wizard] Tokens persisted for ${serverId} after ${Math.round(tokenPersistence.elapsedMs / 1000)}s; starting main-stack recovery`,
    );

    // Step 2: Kick off main-stack recovery immediately and wait only briefly so
    // fast servers can still show an exact tool count without blocking slower ones.
    updateWizardTestStep('verify', 'running', 'Syncing tools on the main stack...');
    const fastRecovery = await waitForWizardProdRecoveryGrace(serverId, {
      graceMs: 2000,
      maxWaitMs: 60000,
      pollIntervalMs: 1000,
    });

    if (fastRecovery?.state === 'ready' && fastRecovery.toolCount > 0) {
      updateWizardTestStep('verify', 'success', `${fastRecovery.toolCount} tools verified`);
      showWizardTestingSuccess(item.metadata.display_name || serverId, {
        serverId,
        toolCount: fastRecovery.toolCount,
        syncState: 'ready',
      });
    } else if (fastRecovery?.state === 'failed') {
      console.warn(
        `[OAuth Wizard] ${serverId} authorized, but post-auth recovery failed immediately: ${fastRecovery.error}`,
      );
      updateWizardTestStep('verify', 'success', 'Authorized — tool sync hit an error');
      showWizardTestingSuccess(item.metadata.display_name || serverId, {
        serverId,
        syncState: 'failed',
        error: fastRecovery.error,
      });
    } else if (fastRecovery?.state === 'sync_delayed') {
      updateWizardTestStep('verify', 'success', 'Authorized — tool sync continuing in background');
      showWizardTestingSuccess(item.metadata.display_name || serverId, {
        serverId,
        syncState: 'sync_delayed',
      });
    } else {
      updateWizardTestStep('verify', 'success', 'Authorized — syncing tools in background');
      showWizardTestingSuccess(item.metadata.display_name || serverId, {
        serverId,
        syncState: 'syncing',
      });
    }
  }
  if (isWizardBackendManagedServer(serverId)) {
    notifyBackendOAuthCompletionAfterRendererRecovery(serverId);
  }
  markWizardCurrentAsDone();
}

/**
 * Mark current server as done
 */
function markWizardCurrentAsDone() {
  const item = getCurrentWizardItem();
  if (!item) return;

  item.status = 'done';
  oauthWizardState.completedCount++;
  const serverId = item.server.id || item.server.server_name;
  oauthWizardState.completedServerIds.push(serverId);
  settleWizardRequestedServer(serverId);

  updateWizardCurrentServerUI();
  updateWizardPreviewBar();

  // Wire up the Next button
  wireUpWizardNextButton();
}

/**
 * Wire up the Next button to advance or complete
 */
function wireUpWizardNextButton() {
  const nextBtn = document.getElementById('oauth-wizard-success-next-btn');
  if (nextBtn) {
    const showContinue = areAllWizardServersProcessed();
    nextBtn.textContent = showContinue ? 'Continue →' : 'Next →';
    nextBtn.onclick = () => {
      hideWizardTestingProgress();

      if (showContinue) {
        handleWizardComplete();
      } else {
        const nextPending = findNextPendingWizardServer();
        if (nextPending !== -1) {
          navigateWizardToServer(nextPending, { autoStart: true });
        } else {
          handleWizardComplete();
        }
      }
    };
  }
}

/**
 * Mark current server as failed
 */
function markWizardCurrentAsFailed(errorMessage) {
  const item = getCurrentWizardItem();
  if (!item) return;

  item.status = 'failed';
  oauthWizardState.failedCount++;
  settleWizardRequestedServer(getWizardServerId(item));

  updateWizardCurrentServerUI();
  updateWizardPreviewBar();
  updateWizardNavigationButtons();
}

/**
 * Skip current server
 */
function skipWizardCurrentServer() {
  const item = getCurrentWizardItem();
  if (!item || ['done', 'failed', 'skipped'].includes(item.status)) return;

  const serverId = getWizardServerId(item);
  item.status = 'skipped';
  oauthWizardState.skippedCount++;
  if (oauthWizardState.dismissibleRequestServerId === serverId) {
    dismissWizardRequestedServerIfNeeded(serverId);
  }

  updateWizardCurrentServerUI();
  updateWizardPreviewBar();

  // Single server - close modal
  if (oauthWizardState.servers.length === 1) {
    closeWizardModal();
    return;
  }

  if (areAllWizardServersProcessed()) {
    handleWizardComplete();
  } else {
    const nextPending = findNextPendingWizardServer(oauthWizardState.currentIndex, { wrap: false });
    if (nextPending !== -1) {
      navigateWizardToServer(nextPending, { autoStart: true });
    } else {
      handleWizardComplete();
    }
  }
}

/**
 * Skip all remaining servers
 */
function skipAllWizardRemainingServers() {
  oauthWizardState.servers.forEach(item => {
    if (item.status === 'pending' || item.status === 'current') {
      item.status = 'skipped';
      oauthWizardState.skippedCount++;
    }
  });
  dismissWizardRequestedServerIfNeeded();

  updateWizardPreviewBar();

  if (oauthWizardState.servers.length <= 2) {
    closeWizardModal();
  } else {
    handleWizardComplete();
  }
}

/**
 * Handle completion - restart prod servers and show summary
 */
async function handleWizardComplete() {
  const outcome = getWizardOutcomeCounts();
  console.log(`[OAuth Wizard] All servers processed: ${outcome.completed} done, ${outcome.skipped} skipped, ${outcome.failed} failed`);

  // Backstop: prod recovery should already have been started incrementally when
  // each server finished OAuth, but kick off any missing jobs immediately when
  // the summary appears rather than waiting for the modal to close.
  Promise.resolve()
    .then(() => finalizeWizardProdServers({ awaitCompletion: false }))
    .catch((error) => {
      console.warn('[OAuth Wizard] Failed to start background prod recovery from completion screen:', error);
    });

  // Show completion summary
  const mainContent = document.getElementById('oauth-wizard-main-content');
  const completion = document.getElementById('oauth-wizard-completion');
  const completionTitle = document.getElementById('oauth-wizard-completion-title');
  const statDone = document.getElementById('oauth-wizard-stat-done');
  const statSkipped = document.getElementById('oauth-wizard-stat-skipped');
  const statFailed = document.getElementById('oauth-wizard-stat-failed');
  const doneBtn = document.getElementById('oauth-wizard-done-btn');

  if (mainContent) mainContent.style.display = 'none';
  if (completion) completion.style.display = 'block';
  if (completionTitle) {
    completionTitle.textContent = 'Connections Complete';
  }

  if (statDone) statDone.textContent = `✓ ${outcome.completed} authorized`;
  if (statSkipped) {
    if (outcome.skipped > 0) {
      statSkipped.textContent = `⊘ ${outcome.skipped} skipped`;
      statSkipped.style.display = 'flex';
    } else {
      statSkipped.style.display = 'none';
    }
  }
  if (statFailed) {
    if (outcome.failed > 0) {
      statFailed.textContent = `✗ ${outcome.failed} failed`;
      statFailed.style.display = 'flex';
    } else {
      statFailed.style.display = 'none';
    }
  }

  // Wire up done button
  if (doneBtn) {
    doneBtn.onclick = () => {
      closeWizardModal();
    };
  }
}

/**
 * Close the wizard modal
 */
function acknowledgeContractorDeniedServers() {
  const contractorDeniedServerIds =
      isWizardSetLike(oauthWizardState.contractorDeniedServerIds)
      ? oauthWizardState.contractorDeniedServerIds
      : new Set();
  oauthWizardState.contractorDeniedServerIds = contractorDeniedServerIds;

  if (contractorDeniedServerIds.size === 0) return;
  for (const sid of contractorDeniedServerIds) {
    if (window.electronAPI?.notifyOAuthContractorAcknowledged) {
      window.electronAPI.notifyOAuthContractorAcknowledged(sid);
      console.log(`[OAuth Wizard] Cleared contractor-denied block for ${sid} — wizard closed`);
    }
  }
  contractorDeniedServerIds.clear();
}

function closeWizardModal() {
  if (oauthWizardCloseInProgress) {
    return;
  }
  oauthWizardCloseInProgress = true;

  // Stop any in-flight wizard poll loop so it doesn't keep ticking
  // invisibly behind the closed modal.
  if (oauthWizardState.activePollAbortController) {
    try {
      oauthWizardState.activePollAbortController.abort();
    } catch (e) {
      console.warn('[OAuth Wizard] Failed to abort poll on modal close:', e);
    }
    oauthWizardState.activePollAbortController = null;
  }

  acknowledgeContractorDeniedServers();
  oauthWizardState.wasDismissed =
    oauthWizardState.wasDismissed ||
    !areAllWizardServersProcessed() ||
    Boolean(oauthWizardState.dismissibleRequestServerId);
  dismissWizardRequestedServerIfNeeded();

  const modal = document.getElementById('oauth-wizard-modal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => {
      modal.classList.remove('single-server');
    }, 200);
  }
  setOAuthWizardInteractionSuppressed(false);

  // Clean up escape handler
  if (oauthWizardState.escapeHandler) {
    document.removeEventListener('keydown', oauthWizardState.escapeHandler);
    oauthWizardState.escapeHandler = null;
  }

  Promise.resolve()
    .then(() => finalizeWizardProdServers({ awaitCompletion: false }))
    .catch((error) => {
      console.warn('[OAuth Wizard] Finalization failed while closing modal:', error);
    })
    .finally(() => {
      if (oauthWizardState.resolveFlow) {
        oauthWizardState.resolveFlow();
        oauthWizardState.resolveFlow = null;
      }
      oauthWizardCloseInProgress = false;
    });
}

/**
 * Set up button event handlers
 */
function setupWizardButtonHandlers() {
  const authorizeBtn = document.getElementById('oauth-wizard-authorize-btn');
  const prevBtn = document.getElementById('oauth-wizard-prev-btn');
  const nextBtn = document.getElementById('oauth-wizard-next-btn');
  const skipAllBtn = document.getElementById('oauth-wizard-skip-all-btn');
  const closeBtn = document.getElementById('oauth-wizard-close-btn');

  if (authorizeBtn) {
    authorizeBtn.onclick = () => handleWizardAuthorize();
  }
  if (prevBtn) {
    prevBtn.onclick = () => {};
  }
  if (nextBtn) {
    nextBtn.onclick = () => skipWizardCurrentServer();
  }
  if (skipAllBtn) {
    skipAllBtn.onclick = () => skipAllWizardRemainingServers();
  }
  if (closeBtn) {
    closeBtn.onclick = () => closeWizardModal();
  }

  // Escape key handler
  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('oauth-wizard-modal');
      if (modal && modal.classList.contains('visible')) {
        closeWizardModal();
      }
    }
  };
  if (oauthWizardState.escapeHandler) {
    document.removeEventListener('keydown', oauthWizardState.escapeHandler);
  }
  oauthWizardState.escapeHandler = escapeHandler;
  document.addEventListener('keydown', escapeHandler);
}

/**
 * Initialize the wizard with servers
 */
async function initOAuthWizard(servers, options = {}) {
  console.log('[OAuth Wizard] Initializing with', servers.length, 'server(s)');

  oauthWizardFinalizationPromise = null;
  oauthWizardFinalizationComplete = false;
  oauthWizardCloseInProgress = false;
  oauthWizardProdRecoveryTasks = new Map();

  // Abort any leftover poll controller from a prior wizard session before
  // discarding state. Without this, an old loop would keep running silently
  // against a now-stale state singleton.
  if (oauthWizardState && oauthWizardState.activePollAbortController) {
    try {
      oauthWizardState.activePollAbortController.abort();
    } catch (e) {
      console.warn('[OAuth Wizard] Failed to abort poll on init reset:', e);
    }
  }

  // Reset state
  oauthWizardState = {
    servers: [],
    currentIndex: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    completedServerIds: [],
    resolveFlow: null,
    escapeHandler: null,
    queueStarted: false,
    flowLocked: false,
    pendingAutoStartIndex: null,
    flowSource: options.flowSource === 'backend-requested' ? 'backend-requested' : 'manual',
    requestedServerId: null,
    dismissibleRequestServerId: null,
    backendManagedServerIds: new Set(),
    backendCompletionNotifiedServerIds: new Set(),
    backendRequestOutcomes: new Map(),
    contractorDeniedServerIds: new Set(),
    wasDismissed: false,
    activePollAbortController: null,
  };

  // Reorder servers so the one the user explicitly clicked appears first.
  const preferredServerId = String(options.preferredServerId || '').trim().toLowerCase();
  const orderedServers = [...servers];
  if (preferredServerId) {
    const preferredIndex = orderedServers.findIndex((server) => {
      const id = String(server.id || server.server_name || '').toLowerCase();
      return id === preferredServerId;
    });
    if (preferredIndex > 0) {
      const [preferredServer] = orderedServers.splice(preferredIndex, 1);
      orderedServers.unshift(preferredServer);
      console.log(
        `[OAuth Wizard] Prioritized clicked server ${preferredServer.id || preferredServer.server_name} to index 0`,
      );
    }
  }

  const forceAuthAll = Boolean(options.forceAuthAll);
  const forcedServerIds = new Set(
    (options.forceAuthServerIds || [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const requestedServerId =
    oauthWizardState.flowSource === 'backend-requested'
      ? String(options.requestedServerId || options.preferredServerId || '').trim()
      : '';
  if (requestedServerId) {
    oauthWizardState.requestedServerId = requestedServerId;
    oauthWizardState.dismissibleRequestServerId = requestedServerId;
  }
  const backendManagedServerIds = new Set(
    (
      options.backendManagedServerIds ||
      (oauthWizardState.flowSource === 'backend-requested' && requestedServerId
        ? [requestedServerId]
        : [])
    )
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  oauthWizardState.backendManagedServerIds = backendManagedServerIds;
  for (const serverId of backendManagedServerIds) {
    oauthWizardState.backendRequestOutcomes.set(serverId, 'pending');
  }

  // Build server state objects
  oauthWizardState.servers = orderedServers.map(server => {
    const serverId = String(server.id || server.server_name || '').toLowerCase();
    const shouldForceAuth =
      forceAuthAll ||
      forcedServerIds.has(serverId) ||
      Boolean(server.forceAuth || server.force_auth);

    return {
      server: {
        ...server,
        forceAuth: shouldForceAuth,
      },
      metadata: {
        id: server.id || server.server_name,
        name: server.name || server.server_name,
        display_name: server.display_name || server.name || server.server_name,
        description: server.description,
        icon: server.icon,
        logoKind: server.logoKind || server.logo_kind || null,
      },
      status: 'pending',
      preConfigured: false,
      postAuthSyncState: 'idle',
      postAuthToolCount: 0,
      postAuthSyncError: null,
    };
  });

  // Check which servers already have tokens
  console.log('[OAuth Wizard] Checking for existing OAuth tokens...');
  for (const item of oauthWizardState.servers) {
    try {
      const serverId = item.server.id || item.server.server_name;
      const forceAuth = Boolean(item.server.forceAuth || item.server.force_auth);
      if (forceAuth) {
        console.log(
          `[OAuth Wizard] ${serverId} flagged for re-auth; skipping preconfigured token check (status=${item.server.health_status || 'unknown'}, oauth_state=${item.server.oauth_state || 'none'}, error=${item.server.health_error || 'none'})`,
        );
        continue;
      }
      const tokenCheck = await window.electronAPI.checkOAuthTokensExist(serverId);
      console.log(`[OAuth Wizard] Token check for ${serverId}:`, tokenCheck);

      if (tokenCheck.exists) {
        item.status = 'done';
        item.preConfigured = true;
        oauthWizardState.completedCount++;
        oauthWizardState.completedServerIds.push(serverId);
        console.log(`[OAuth Wizard] ${serverId} already has tokens - marked as pre-configured`);
      }
    } catch (e) {
      console.warn(`[OAuth Wizard] Failed to check tokens for ${item.server.id}:`, e);
    }
  }

  // Check if ALL servers are already configured
  const pendingServers = oauthWizardState.servers.filter(s => s.status === 'pending');

  if (pendingServers.length === 0) {
    console.log('[OAuth Wizard] All OAuth servers already have tokens');
    // Still show the wizard with all servers marked as done
    // User can see the summary and dismiss
  }

  // Find first server that needs OAuth
  const firstPendingIndex = oauthWizardState.servers.findIndex(s => s.status === 'pending');
  if (firstPendingIndex !== -1) {
    oauthWizardState.currentIndex = firstPendingIndex;
    oauthWizardState.servers[firstPendingIndex].status = 'current';
  }

  updateWizardDescriptionText(oauthWizardState.servers.length);

  // Render UI
  renderWizardPreviewBar();
  updateWizardCurrentServerUI();
  updateWizardPreviewBar();
}

/**
 * Main entry point - run OAuth wizard for servers
 * @param {Array<Object>} servers - Array of server objects needing OAuth
 * @returns {Promise<{completedCount: number, completedServerIds: Array, skipped: boolean}>}
 */
async function runOAuthWizard(servers, options = {}) {
  // Guard against concurrent flows.
  //
  // Special case (H-21 Bug C regression): a NEW backend-triggered flow for
  // a server that is NOT in the current wizard's queue means the LLM
  // detected a 401 on a different integration while the wizard was busy
  // with another. In that case `revealExistingOAuthWizard` would just
  // re-show the stale wizard (the new server isn't in its list) and the
  // browser would never open. Instead, abort the in-flight wizard and
  // start a fresh one for the new server.
  const incomingServerIds = new Set(
    (servers || [])
      .map((s) => getWizardServerId(s) || s?.id || s?.server_name)
      .filter(Boolean),
  );
  const currentServerIds = new Set(
    (oauthWizardState.servers || [])
      .map((item) => getWizardServerId(item))
      .filter(Boolean),
  );
  const hasNewServer = [...incomingServerIds].some(
    (sid) => !currentServerIds.has(sid),
  );

  if (oauthWizardFlowInProgress && !hasNewServer) {
    console.log('[OAuth Wizard] Flow already in progress, revealing existing wizard');
    attachBackendRequestToExistingWizard(options);
    revealExistingOAuthWizard(options);
    return {
      completedCount: 0,
      completedServerIds: [...oauthWizardState.completedServerIds],
      skipped: false,
      reusedExistingFlow: true,
    };
  }

  if (oauthWizardFlowInProgress && hasNewServer) {
    console.log(
      `[OAuth Wizard] Flow in progress, but new server(s) requested (${[...incomingServerIds].join(', ')}); aborting prior flow and re-initializing`,
    );
    if (oauthWizardState.activePollAbortController) {
      try {
        oauthWizardState.activePollAbortController.abort();
      } catch (e) {
        console.warn('[OAuth Wizard] Failed to abort prior flow during takeover:', e);
      }
    }
    // Resolve the prior wizard's outer promise so its outer try/finally
    // can run, releasing oauthWizardFlowInProgress.
    if (oauthWizardState.resolveFlow) {
      try {
        dismissWizardRequestedServerIfNeeded();
        oauthWizardState.resolveFlow();
      } catch (e) {
        console.warn('[OAuth Wizard] Failed to resolve prior flow during takeover:', e);
      }
      oauthWizardState.resolveFlow = null;
    }
    // Yield so the prior flow's finally block can clear the in-progress flag.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  oauthWizardFlowInProgress = true;

  try {
    // Load template if needed
    await loadWizardTemplate();

    // Hard-reset all modal UI state before each invocation.
    resetWizardModalUIState();

    // Initialize wizard
    await initOAuthWizard(servers, options);

    // Set up button handlers
    setupWizardButtonHandlers();

    // Show modal
    showOAuthWizardModal();

    // Auto-start the first server when the flow is backend-triggered (LLM).
    // The user should not need to click "Authorize" manually — the browser
    // should open immediately so they can complete the OAuth handshake.
    if (options.flowSource === 'backend-requested') {
      scheduleWizardAutoStartForCurrent();
    }

    // Wait for user to complete flow
    await new Promise((resolve) => {
      oauthWizardState.resolveFlow = resolve;
    });

    const outcome = getWizardOutcomeCounts();
    console.log(`[OAuth Wizard] Flow complete: ${outcome.completed} completed, ${outcome.skipped} skipped, ${outcome.failed} failed; main-stack recovery started when required`);

    return {
      completedCount: outcome.completed,
      completedServerIds: [...oauthWizardState.completedServerIds],
      skipped: outcome.skipped > 0 || oauthWizardState.wasDismissed
    };

  } finally {
    setOAuthWizardInteractionSuppressed(false);
    oauthWizardFlowInProgress = false;
  }
}

// Export to window for use by mcp-servers.js
window.runOAuthWizard = runOAuthWizard;
window.closeWizardModal = closeWizardModal;
