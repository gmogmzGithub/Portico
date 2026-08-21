/**
 * Shared OAuth Modal Handler with Navigation Support
 *
 * This module provides OAuth flow functionality with:
 * - Server preview bar showing all servers needing auth
 * - Navigation between servers (prev/next/click)
 * - Status indicators for each server
 * - Skip individual or all servers
 */

// Guard against concurrent OAuth flows
let oauthFlowInProgress = false;

// Module-level state for navigation
let oauthState = {
  servers: [],           // Array of {server, metadata, status, authUrl}
  currentIndex: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  skippedAll: false,
  logFn: console.log,
  resolveFlow: null,     // Promise resolver for completing the flow
  completedServerIds: [], // Track IDs of servers that completed OAuth successfully
  escapeHandler: null,   // Reference to escape key handler for cleanup
  dismissedServerIds: new Set(),
  backendManagedFinalization: false,
};

/**
 * Unified OAuth logging wrapper
 * Logs to both the local console and the main process OAuth log file
 *
 * @param {string} message - Log message
 * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
 */
function logOAuth(message, level = 'INFO') {
  // Keep existing console output via logFn
  if (oauthState.logFn) {
    oauthState.logFn(message);
  }

  // Send to main process for unified OAuth log file
  if (window.electronAPI && window.electronAPI.logOAuthEvent) {
    // Remove [OAuth] prefix if present since the logger adds its own prefix
    const cleanMessage = message.replace(/^\[OAuth\]\s*/, '');
    window.electronAPI.logOAuthEvent({
      layer: 'Frontend',
      level: level,
      message: cleanMessage
    });
  }
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
    default: return '○';  // pending
  }
}

/**
 * Render the server preview bar
 */
function renderPreviewBar() {
  const previewContainer = document.getElementById('oauth-server-preview');
  if (!previewContainer) return;

  logOAuth(`[OAuth] Rendering preview bar with ${oauthState.servers.length} server(s)`);

  previewContainer.innerHTML = oauthState.servers.map((item, index) => {
    const { metadata, status } = item;
    const statusIcon = getStatusIcon(status);
    const iconSrc = metadata.icon || '';
    const name = metadata.display_name || metadata.name || item.server.server_name;

    return `
      <div class="oauth-preview-card ${status}" data-index="${index}">
        <img class="oauth-preview-icon" src="${iconSrc}" alt="${name}" onerror="this.style.display='none'" />
        <span class="oauth-preview-name" title="${name}">${name}</span>
        <span class="oauth-preview-status">${statusIcon}</span>
      </div>
    `;
  }).join('');

  // Add click handlers
  const cards = previewContainer.querySelectorAll('.oauth-preview-card');
  cards.forEach((card, index) => {
    card.addEventListener('click', () => navigateToServer(index));
  });
}

/**
 * Update preview bar status indicators
 */
function updatePreviewBar() {
  const cards = document.querySelectorAll('.oauth-preview-card');
  cards.forEach((card, index) => {
    if (index < oauthState.servers.length) {
      const item = oauthState.servers[index];
      card.className = `oauth-preview-card ${item.status}`;
      const statusSpan = card.querySelector('.oauth-preview-status');
      if (statusSpan) {
        statusSpan.textContent = getStatusIcon(item.status);
      }
    }
  });
}

/**
 * Update the main server display for current server
 */
function updateCurrentServerUI() {
  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) return;

  const { metadata, server } = item;

  const icon = document.getElementById('oauth-server-icon');
  const name = document.getElementById('oauth-server-name');
  const description = document.getElementById('oauth-server-description');
  const progress = document.getElementById('oauth-progress-text');
  const currentServerDiv = document.getElementById('oauth-current-server');
  const buttonsContainer = document.querySelector('.oauth-buttons-container');

  if (icon && metadata.icon) {
    icon.src = metadata.icon;
    icon.style.display = 'block';
  } else if (icon) {
    icon.style.display = 'none';
  }

  if (name) {
    name.textContent = metadata.display_name || metadata.name || server.server_name;
  }
  if (description) {
    description.textContent = metadata.description || 'MCP Server requiring OAuth authentication';
  }
  if (progress) {
    progress.textContent = `Server ${oauthState.currentIndex + 1} of ${oauthState.servers.length}`;
  }

  // Show current server section, hide completion
  if (currentServerDiv) currentServerDiv.style.display = 'block';
  if (buttonsContainer) buttonsContainer.style.display = 'flex';

  const completionSummary = document.getElementById('oauth-completion-summary');
  if (completionSummary) completionSummary.classList.remove('visible');

  // Reset UI state
  const buttons = document.getElementById('oauth-buttons');
  const waiting = document.getElementById('oauth-waiting');
  const success = document.getElementById('oauth-success');
  const skipAllBtn = document.getElementById('oauth-skip-all-btn');

  if (buttons) buttons.style.display = 'flex';
  if (waiting) waiting.classList.remove('visible');
  if (success) success.classList.remove('visible');

  // Only show "Skip All" if there's more than 1 server
  if (skipAllBtn) {
    skipAllBtn.style.display = oauthState.servers.length > 1 ? 'block' : 'none';
  }

  updateNavigationButtons();
}

/**
 * Update navigation button states
 */
function updateNavigationButtons() {
  const prevBtn = document.getElementById('oauth-prev-btn');
  const nextBtn = document.getElementById('oauth-next-btn');
  const authorizeBtn = document.getElementById('oauth-authorize-btn');
  const skipBtn = document.getElementById('oauth-skip-btn');

  if (prevBtn) {
    prevBtn.disabled = oauthState.currentIndex === 0;
  }
  if (nextBtn) {
    nextBtn.disabled = oauthState.currentIndex >= oauthState.servers.length - 1;
  }

  // Disable authorize/skip for already processed servers (but NOT for 'failed' - allow retry)
  const currentItem = oauthState.servers[oauthState.currentIndex];
  const isProcessed = currentItem && ['done', 'skipped'].includes(currentItem.status);

  if (authorizeBtn) {
    authorizeBtn.disabled = isProcessed;
    authorizeBtn.textContent = isProcessed ?
      (currentItem.status === 'done' ? 'Already Authorized' : 'Skipped') :
      'Authorize Access';
  }
  if (skipBtn) {
    skipBtn.disabled = isProcessed;
  }
}

/**
 * Show error message below the authorize button
 */
function showOAuthErrorMessage() {
  const errorContainer = document.getElementById('oauth-error-container');
  if (errorContainer) {
    errorContainer.classList.add('visible');
  }
}

/**
 * Hide error message
 */
function hideOAuthErrorMessage() {
  const errorContainer = document.getElementById('oauth-error-container');
  if (errorContainer) {
    errorContainer.classList.remove('visible');
  }
}

/**
 * Reset modal UI state so repeated invocations start clean.
 */
function resetOAuthModalUIState() {
  const modal = document.getElementById('oauth-modal');
  const currentServerDiv = document.getElementById('oauth-current-server');
  const buttonsContainer = document.querySelector('.oauth-buttons-container');
  const buttons = document.getElementById('oauth-buttons');
  const waiting = document.getElementById('oauth-waiting');
  const waitingText = document.querySelector('.oauth-waiting-text');
  const waitingHint = document.querySelector('.oauth-waiting-hint');
  const success = document.getElementById('oauth-success');
  const completionSummary = document.getElementById('oauth-completion-summary');
  const skipAllBtn = document.getElementById('oauth-skip-all-btn');
  const statDone = document.getElementById('oauth-stat-done');
  const statSkipped = document.getElementById('oauth-stat-skipped');
  const statFailed = document.getElementById('oauth-stat-failed');
  const authorizeBtn = document.getElementById('oauth-authorize-btn');
  const skipBtn = document.getElementById('oauth-skip-btn');
  const prevBtn = document.getElementById('oauth-prev-btn');
  const nextBtn = document.getElementById('oauth-next-btn');

  if (modal) modal.classList.remove('single-server');
  if (currentServerDiv) currentServerDiv.style.display = 'block';
  if (buttonsContainer) buttonsContainer.style.display = 'flex';
  if (buttons) buttons.style.display = 'flex';
  if (waiting) waiting.classList.remove('visible');
  if (success) success.classList.remove('visible');
  if (completionSummary) completionSummary.classList.remove('visible');

  if (skipAllBtn) skipAllBtn.style.display = 'block';

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
    statFailed.style.display = 'flex';
  }

  if (waitingText) waitingText.textContent = 'Waiting for authorization in browser...';
  if (waitingHint) waitingHint.textContent = 'Complete the authorization in your browser, then return here.';

  if (authorizeBtn) {
    authorizeBtn.disabled = false;
    authorizeBtn.textContent = 'Authorize Access';
  }
  if (skipBtn) skipBtn.disabled = false;
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = false;

  hideOAuthErrorMessage();
  setPollRestartControls({ visible: false });
}

/**
 * Open logs for the current server
 */
function openLogsForCurrentServer() {
  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) return;

  const serverId = item.server.server_name;

  // Determine service name - most OAuth servers use mcpo-{serverId}
  // Core servers would use mcpo-core-{serverId}
  const server = window.appState?.servers?.find(s => s.id === serverId);
  const isCore = server?.is_core || false;
  const deploymentType = server?.deployment_type || 'docker';

  let serviceName;
  if (isCore) {
    serviceName = server?.runtimeContainerName || `mcpo-core-${serverId}`;
  } else if (deploymentType === 'host') {
    serviceName = 'host-mcpo';
  } else {
    serviceName = server?.runtimeContainerName || `mcpo-${serverId}`;
  }

  // Close OAuth modal first
  closeOAuthModal();

  // Open log viewer modal after a brief delay to let OAuth modal close
  setTimeout(() => {
    if (window.openLogViewerModal) {
      window.openLogViewerModal(serverId, serviceName, {
        name: item.metadata?.display_name || item.metadata?.name || serverId,
        icon: item.metadata?.icon
      });
    }
  }, 150);
}

/**
 * Extract authorization URL from OAuth status response
 */
function extractAuthUrlFromStatus(oauthStatus, serverId) {
  if (!oauthStatus) return null;

  // Check 'current' field
  if (oauthStatus.current?.server_name === serverId && oauthStatus.current?.authorization_url) {
    return oauthStatus.current.authorization_url;
  }

  // Check 'active' array
  if (oauthStatus.active) {
    const server = oauthStatus.active.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'waiting_callback' array
  if (oauthStatus.waiting_callback) {
    const server = oauthStatus.waiting_callback.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  // Check 'pending' array
  if (oauthStatus.pending) {
    const server = oauthStatus.pending.find(s => s.server_name === serverId);
    if (server?.authorization_url) return server.authorization_url;
  }

  return null;
}

/**
 * Wait for OAuth to be ready after server restart
 * Polls OAuth status until authorization URL is available
 */
async function waitForOAuthReady(serverId, timeout = 60000) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeout) {
    try {
      const oauthStatus = await window.electronAPI.getOAuthCurrent();

      // Check if server has auth URL in any status array
      const authUrl = extractAuthUrlFromStatus(oauthStatus, serverId);
      if (authUrl) {
        return { ready: true, authUrl };
      }
    } catch (e) {
      logOAuth(`[OAuth] waitForOAuthReady poll error: ${e.message}`, 'DEBUG');
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logOAuth(`[OAuth] Waiting for OAuth ready... (${elapsed}s)`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { ready: false };
}

/**
 * Wait until OAuth token files are persisted to disk.
 * Uses IPC token check which validates both *_tokens.json and *_client.json.
 */
async function waitForOAuthTokensPersisted(serverId, options = {}) {
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
 * Wait for server to have tools available after restart
 * This verifies OAuth actually worked end-to-end
 */
async function waitForServerTools(serverId, timeout = 60000) {
  const startTime = Date.now();
  const pollInterval = 3000;

  while (Date.now() - startTime < timeout) {
    try {
      // Use existing getServerTools API to check for tools
      const toolsResult = await window.electronAPI.getServerTools(serverId);

      if (toolsResult?.success && toolsResult?.tools?.length > 0) {
        return { healthy: true, tools: toolsResult.tools };
      }
    } catch (e) {
      logOAuth(`[OAuth] waitForServerTools poll error: ${e.message}`, 'DEBUG');
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logOAuth(`[OAuth] Waiting for tools... (${elapsed}s)`);
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { healthy: false, tools: [] };
}

/**
 * Navigate to a specific server by index
 */
function navigateToServer(index) {
  if (index < 0 || index >= oauthState.servers.length) return;

  // Don't navigate away if in waiting state
  const waiting = document.getElementById('oauth-waiting');
  if (waiting && waiting.classList.contains('visible')) {
    logOAuth('[OAuth] Cannot navigate while waiting for authorization', 'WARN');
    return;
  }

  // Hide error message when navigating
  hideOAuthErrorMessage();

  const currentItem = oauthState.servers[oauthState.currentIndex];

  // Update current status back to pending if it was just 'current'
  if (currentItem && currentItem.status === 'current') {
    currentItem.status = 'pending';
  }

  // Move to new server
  oauthState.currentIndex = index;

  // Only set to 'current' if not already processed
  const newItem = oauthState.servers[index];
  if (newItem && !['done', 'failed', 'skipped'].includes(newItem.status)) {
    newItem.status = 'current';
  }

  updateCurrentServerUI();
  updatePreviewBar();

  logOAuth(`[OAuth] Navigated to server ${index + 1}: ${oauthState.servers[index].server.server_name}`);
}

/**
 * Find next pending server index
 */
function findNextPendingServer(fromIndex = oauthState.currentIndex) {
  for (let i = fromIndex + 1; i < oauthState.servers.length; i++) {
    if (oauthState.servers[i].status === 'pending') {
      return i;
    }
  }
  // Wrap around to find any pending
  for (let i = 0; i < fromIndex; i++) {
    if (oauthState.servers[i].status === 'pending') {
      return i;
    }
  }
  return -1;
}

/**
 * Check if all servers are processed
 */
function areAllServersProcessed() {
  return oauthState.servers.every(s => ['done', 'failed', 'skipped'].includes(s.status));
}

function notifyOAuthDismissed(serverId) {
  if (!serverId || oauthState.dismissedServerIds.has(serverId)) {
    return;
  }

  oauthState.dismissedServerIds.add(serverId);
  if (window.electronAPI && window.electronAPI.notifyOAuthDismissed) {
    window.electronAPI.notifyOAuthDismissed(serverId);
  }
}

function notifyUnresolvedOAuthDismissals() {
  oauthState.servers.forEach((item) => {
    if (!item || ['done', 'skipped'].includes(item.status)) {
      return;
    }

    notifyOAuthDismissed(item.server.server_name);
  });
}

/**
 * Compute outcome counts from current per-server status values.
 * This avoids stale counter values when a server fails and is later retried successfully.
 */
function getOAuthOutcomeCounts() {
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const server of oauthState.servers) {
    if (server.status === 'done') completed++;
    else if (server.status === 'skipped') skipped++;
    else if (server.status === 'failed') failed++;
  }

  return { completed, skipped, failed };
}

/**
 * Ensure the waiting-state retry button exists in the modal.
 * The modal markup is duplicated across views, so create it dynamically if missing.
 */
function ensurePollRestartButton() {
  const waiting = document.getElementById('oauth-waiting');
  if (!waiting) return null;

  let actionRow = document.getElementById('oauth-waiting-actions');
  if (!actionRow) {
    actionRow = document.createElement('div');
    actionRow.id = 'oauth-waiting-actions';
    actionRow.style.display = 'none';
    actionRow.style.marginTop = '4px';
    waiting.appendChild(actionRow);
  }

  let restartBtn = document.getElementById('oauth-restart-auth-btn');
  if (!restartBtn) {
    restartBtn = document.createElement('button');
    restartBtn.id = 'oauth-restart-auth-btn';
    restartBtn.className = 'oauth-btn secondary';
    restartBtn.style.padding = '6px 12px';
    restartBtn.style.fontSize = '12px';
    restartBtn.style.display = 'inline-flex';
    restartBtn.style.alignItems = 'center';
    restartBtn.textContent = 'Stuck? Retry';
    actionRow.appendChild(restartBtn);
  }

  return restartBtn;
}

/**
 * Show/hide callback-retry controls while waiting for OAuth callback.
 */
function setPollRestartControls(options = {}) {
  const restartBtn = ensurePollRestartButton();
  const actionRow = document.getElementById('oauth-waiting-actions');
  if (!restartBtn || !actionRow) return;

  const visible = Boolean(options.visible);
  if (!visible) {
    actionRow.style.display = 'none';
    restartBtn.disabled = false;
    restartBtn.textContent = 'Stuck? Retry';
    restartBtn.onclick = null;
    return;
  }

  actionRow.style.display = 'flex';
  actionRow.style.justifyContent = 'center';

  const inProgress = Boolean(options.inProgress);
  restartBtn.disabled = inProgress;
  restartBtn.textContent = inProgress ? 'Retrying...' : 'Stuck? Retry';
  restartBtn.onclick = null;

  if (!inProgress && typeof options.onRestart === 'function') {
    restartBtn.onclick = () => options.onRestart();
  }
}

/**
 * Poll OAuth completion in short chunks so users can request an immediate retry.
 */
async function pollOAuthCompletionWithManualRestart(serverId, options = {}) {
  const timeoutMs = options.timeoutMs || 300000;
  const chunkTimeoutMs = options.chunkTimeoutMs || 6000;
  const shouldRestart = typeof options.shouldRestart === 'function'
    ? options.shouldRestart
    : () => false;
  const onProgress = options.onProgress;
  const startTime = Date.now();
  let lastResult = { success: false, timeout: true };

  while (Date.now() - startTime < timeoutMs) {
    if (shouldRestart()) {
      return { restartRequested: true };
    }

    const elapsedMs = Date.now() - startTime;
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const pollWindowMs = Math.max(2000, Math.min(chunkTimeoutMs, remainingMs));
    const result = await window.electronAPI.pollOAuthCompletion(serverId, pollWindowMs);
    lastResult = result || lastResult;

    if (result?.completed || result?.failed) {
      return result;
    }

    if (shouldRestart()) {
      return { restartRequested: true };
    }

    // Most chunk calls return { timeout: true } while waiting.
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
 * Restart OAuth authorization session and reopen browser with a fresh URL.
 * Uses the regular stack (not single-server stack).
 */
async function restartOAuthAuthorizationSession(serverId) {
  await prepareForFreshOAuthStart(serverId);
  let authUrl = null;
  const refreshResult = await window.electronAPI.refreshOAuthUrl(serverId);
  if (refreshResult?.success && refreshResult.authorization_url) {
    authUrl = refreshResult.authorization_url;
    logOAuth(`[OAuth] Refreshed authorization URL during callback retry`);
  } else {
    logOAuth(`[OAuth] Refresh failed during callback retry; restarting MCP server...`, 'WARN');
    await window.electronAPI.apiRestartMcpServers([serverId]);

    const readyResult = await waitForOAuthReady(serverId, 60000);
    if (!readyResult.ready || !readyResult.authUrl) {
      throw new Error('Unable to get a fresh authorization URL after retry restart');
    }
    authUrl = readyResult.authUrl;
  }

  logOAuth(`[OAuth] Reopening browser after callback retry for ${serverId}`);
  await window.electronAPI.openExternal(authUrl, {
    kind: 'oauth',
    event: 'authorization_restarted',
    serverId,
    sessionId: 'main-stack',
  });
  return { authUrl };
}

/**
 * Show completion summary
 */
function showCompletionSummary() {
  const outcome = getOAuthOutcomeCounts();
  logOAuth(`[OAuth] All servers processed - showing completion summary`);
  logOAuth(`[OAuth] Results: ${outcome.completed} done, ${outcome.skipped} skipped, ${outcome.failed} failed`);

  const currentServerDiv = document.getElementById('oauth-current-server');
  const buttonsContainer = document.querySelector('.oauth-buttons-container');
  const completionSummary = document.getElementById('oauth-completion-summary');
  const statDone = document.getElementById('oauth-stat-done');
  const statSkipped = document.getElementById('oauth-stat-skipped');
  const statFailed = document.getElementById('oauth-stat-failed');

  if (currentServerDiv) currentServerDiv.style.display = 'none';
  if (buttonsContainer) buttonsContainer.style.display = 'none';

  if (statDone) statDone.textContent = `✓ ${outcome.completed} authorized`;
  if (statSkipped) {
    if (outcome.skipped > 0) {
      statSkipped.textContent = `⊘ ${outcome.skipped} skipped`;
      statSkipped.style.display = 'flex';
    } else {
      statSkipped.style.display = 'none';
    }
  }
  if (statFailed) statFailed.textContent = `✗ ${outcome.failed} failed`;

  // Hide failed stat if none failed
  if (statFailed && outcome.failed === 0) {
    statFailed.style.display = 'none';
  } else if (statFailed) {
    statFailed.style.display = 'flex';
  }

  if (completionSummary) completionSummary.classList.add('visible');
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
async function markCurrentAsDone() {
  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) return;

  item.status = 'done';
  oauthState.completedCount++;
  oauthState.completedServerIds.push(item.server.server_name); // Track completed server ID
  updatePreviewBar();

  const serverId = item.server.server_name;
  logOAuth(`[OAuth] Authorization successful for ${serverId}`);

  // Show success briefly, then show "finalizing" with funny messages
  const buttons = document.getElementById('oauth-buttons');
  const waiting = document.getElementById('oauth-waiting');
  const success = document.getElementById('oauth-success');
  const skipAllBtn = document.getElementById('oauth-skip-all-btn');
  const waitingText = document.querySelector('.oauth-waiting-text');

  if (buttons) buttons.style.display = 'none';
  if (waiting) waiting.classList.remove('visible');
  if (success) success.classList.add('visible');
  if (skipAllBtn) skipAllBtn.style.display = 'none';

  // After 1.5s showing success, start the MCP restart process
  await new Promise(resolve => setTimeout(resolve, 1500));

  if (success) success.classList.remove('visible');

  // Show waiting state with funny messages while restarting MCP
  if (waiting) waiting.classList.add('visible');
  if (waitingText) waitingText.textContent = getRandomOAuthMessage();

  // Start rotating funny messages
  let messageInterval = setInterval(() => {
    if (waitingText) waitingText.textContent = getRandomOAuthMessage();
  }, 2500);

  try {
    // Ensure token files are persisted before restart (typically immediate)
    await waitForOAuthTokensPersisted(serverId, { timeoutMs: 15000, pollIntervalMs: 250 });

    if (oauthState.backendManagedFinalization) {
      logOAuth(
        `[OAuth] Backend-managed finalization enabled for ${serverId}; skipping frontend restart`,
      );
    } else {
      logOAuth(`[OAuth] Restarting MCP server ${serverId} to complete setup...`);

      // Restart the MCP server to pick up the new auth tokens
      if (window.electronAPI && window.electronAPI.apiRestartMcpServers) {
        const restartResult = await window.electronAPI.apiRestartMcpServers([serverId]);
        logOAuth(`[OAuth] MCP restart result for ${serverId}: ${JSON.stringify(restartResult)}`);

        // Wait for server tools to confirm readiness, but don't fail flow if it takes longer
        const readyResult = await waitForServerTools(serverId, 30000);
        if (!readyResult.healthy) {
          logOAuth(`[OAuth] Post-restart readiness check timed out for ${serverId}`, 'WARN');
        }
      } else {
        logOAuth(`[OAuth] No apiRestartMcpServers available, skipping restart`);
      }
    }
  } catch (error) {
    logOAuth(`[OAuth] Error restarting MCP server ${serverId}: ${error.message}`, 'WARN');
    // Don't fail the OAuth flow if restart fails - the server can be restarted manually
  } finally {
    // Stop the message rotation
    clearInterval(messageInterval);
    if (waiting) waiting.classList.remove('visible');
  }

  // Now advance to next server or show completion
  if (areAllServersProcessed()) {
    showCompletionSummary();
  } else {
    const nextPending = findNextPendingServer();
    if (nextPending !== -1) {
      navigateToServer(nextPending);
    } else {
      showCompletionSummary();
    }
  }
}

/**
 * Mark current server as failed
 */
function markCurrentAsFailed(errorMessage) {
  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) return;

  item.status = 'failed';
  oauthState.failedCount++;
  updatePreviewBar();

  logOAuth(`[OAuth] Authorization failed for ${item.server.server_name}: ${errorMessage}`, 'ERROR');

  // Reset UI but stay on current server
  const buttons = document.getElementById('oauth-buttons');
  const waiting = document.getElementById('oauth-waiting');

  if (buttons) buttons.style.display = 'flex';
  if (waiting) waiting.classList.remove('visible');

  // Show error message
  showOAuthErrorMessage();

  updateNavigationButtons();
}

/**
 * Skip current server and advance
 */
function skipCurrentServer() {
  logOAuth(`[OAuth] skipCurrentServer called`);

  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) {
    logOAuth(`[OAuth] No item at currentIndex ${oauthState.currentIndex}`, 'WARN');
    return;
  }

  if (['done', 'failed', 'skipped'].includes(item.status)) {
    logOAuth(`[OAuth] Item already processed with status: ${item.status}`, 'WARN');
    return;
  }

  item.status = 'skipped';
  oauthState.skippedCount++;
  updatePreviewBar();

  logOAuth(`[OAuth] User skipped ${item.server.server_name}`);

  // Notify main process
  notifyOAuthDismissed(item.server.server_name);

  // If only one server, close modal immediately
  if (oauthState.servers.length === 1) {
    logOAuth(`[OAuth] Single server skipped, closing modal`);
    closeOAuthModal();
    return;
  }

  if (areAllServersProcessed()) {
    showCompletionSummary();
  } else {
    const nextPending = findNextPendingServer();
    if (nextPending !== -1) {
      navigateToServer(nextPending);
    } else {
      showCompletionSummary();
    }
  }
}

/**
 * Close the OAuth modal and resolve the flow
 */
function closeOAuthModal() {
  notifyUnresolvedOAuthDismissals();
  resetOAuthModalUIState();
  const modal = document.getElementById('oauth-modal');
  if (modal) {
    modal.classList.remove('visible');
    // Delay removing single-server class until after fade completes to prevent layout jank
    setTimeout(() => {
      modal.classList.remove('single-server');
    }, 200);
  }
  // Unsuppress the OWUI BrowserView so chat is interactive again
  if (window.setOwuiInteractionSuppressed) {
    window.setOwuiInteractionSuppressed('oauth-modal', false);
  }
  // Clean up escape handler
  if (oauthState.escapeHandler) {
    document.removeEventListener('keydown', oauthState.escapeHandler);
    oauthState.escapeHandler = null;
  }
  if (oauthState.resolveFlow) {
    oauthState.resolveFlow();
    oauthState.resolveFlow = null;
  }
}

/**
 * Skip all remaining servers
 */
function skipAllRemainingServers() {
  logOAuth(`[OAuth] User clicked Skip All - skipping remaining servers`);

  oauthState.servers.forEach((item, index) => {
    if (item.status === 'pending' || item.status === 'current') {
      item.status = 'skipped';
      oauthState.skippedCount++;

      // Notify main process for each
      notifyOAuthDismissed(item.server.server_name);
    }
  });

  oauthState.skippedAll = true;
  updatePreviewBar();

  // For small number of servers, just close immediately
  if (oauthState.servers.length <= 2) {
    logOAuth(`[OAuth] Few servers, closing modal directly`);
    closeOAuthModal();
  } else {
    showCompletionSummary();
  }
}

async function prepareForFreshOAuthStart(serverId) {
  if (!window.electronAPI?.prepareOAuthStart) {
    logOAuth(`[OAuth] prepareOAuthStart unavailable for ${serverId}; continuing without clearing bootstrap state`);
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

  logOAuth(
    `[OAuth] Prepared fresh OAuth flow for ${serverId} (preservedSecureRecord=true, cleared=${Boolean(prepareResult.cleared)}, tokenFiles=${tokenFilesCleared}, clientFiles=${clientFilesCleared})`,
  );
}

/**
 * Handle authorize button click - Robust version
 * Includes server restart on stale OAuth, token verification, and tool verification
 */
async function handleAuthorize() {
  const item = oauthState.servers[oauthState.currentIndex];
  if (!item) return;

  const serverId = item.server.server_name;
  logOAuth(`[OAuth] User clicked Authorize for ${serverId}`);

  // Hide any previous error message
  hideOAuthErrorMessage();
  // Clear prior failed state visuals when retrying this server.
  item.status = 'current';
  updatePreviewBar();
  updateNavigationButtons();

  // Show waiting state
  const buttons = document.getElementById('oauth-buttons');
  const waiting = document.getElementById('oauth-waiting');
  const waitingText = document.querySelector('.oauth-waiting-text');
  const skipAllBtn = document.getElementById('oauth-skip-all-btn');

  if (buttons) buttons.style.display = 'none';
  if (waiting) waiting.classList.add('visible');
  if (skipAllBtn) skipAllBtn.style.display = 'none';

  const updateWaitingText = (text) => {
    if (waitingText) waitingText.textContent = text;
  };

  try {
    await prepareForFreshOAuthStart(serverId);

    // Step 1: Try to get fresh authorization URL
    updateWaitingText('Preparing authorization...');
    logOAuth(`[OAuth] Refreshing authorization URL for ${serverId}...`);

    let authUrl = null;
    const refreshResult = await window.electronAPI.refreshOAuthUrl(serverId);

    if (refreshResult?.success && refreshResult.authorization_url) {
      authUrl = refreshResult.authorization_url;
      logOAuth(`[OAuth] Got fresh authorization URL`);
    } else {
      // Step 2: URL refresh failed - likely stale OAuth state
      // Restart the MCP server to get fresh OAuth handshake
      logOAuth(`[OAuth] URL refresh failed, restarting MCP server to refresh OAuth...`, 'WARN');
      updateWaitingText('Restarting server for fresh authentication...');

      try {
        await window.electronAPI.apiRestartMcpServers([serverId]);
        logOAuth(`[OAuth] MCP server restart initiated for ${serverId}`);

        // Wait for server to come back up and OAuth to be ready
        updateWaitingText('Waiting for server to be ready...');
        const readyResult = await waitForOAuthReady(serverId, 60000);

        if (readyResult.ready && readyResult.authUrl) {
          authUrl = readyResult.authUrl;
          logOAuth(`[OAuth] Got fresh auth URL after restart for ${serverId}`);
        } else {
          throw new Error('Server restart completed but OAuth not ready');
        }
      } catch (restartError) {
        logOAuth(`[OAuth] Server restart failed: ${restartError.message}`, 'ERROR');
        throw new Error(`Failed to restart server: ${restartError.message}`);
      }
    }

    if (!authUrl) {
      throw new Error('No authorization URL available');
    }

    // Step 3: Open browser for authorization
    updateWaitingText('Opening browser for authorization...');
    logOAuth(`[OAuth] Opening browser for ${serverId}`);
    await window.electronAPI.openExternal(authUrl, {
      kind: 'oauth',
      event: 'authorization_opened',
      serverId,
      sessionId: 'main-stack',
    });

    // Step 4: Poll for completion
    updateWaitingText('Waiting for authorization in browser...');
    logOAuth(`[OAuth] Polling for OAuth completion (5 min timeout)...`);

    let pollResult = null;
    try {
      while (true) {
        let restartRequested = false;
        setPollRestartControls({
          visible: true,
          onRestart: () => {
            if (!restartRequested) {
              restartRequested = true;
              setPollRestartControls({ visible: true, inProgress: true });
              updateWaitingText('Restart requested. Reinitializing authorization...');
            }
          }
        });

        const currentPollResult = await pollOAuthCompletionWithManualRestart(serverId, {
          timeoutMs: 300000,
          chunkTimeoutMs: 6000,
          shouldRestart: () => restartRequested,
          onProgress: (elapsedSeconds) => {
            if (!restartRequested) {
              updateWaitingText(`Waiting for authorization in browser... (${elapsedSeconds}s)`);
            }
          }
        });

        if (currentPollResult.restartRequested) {
          updateWaitingText('Restarting authorization flow...');
          await restartOAuthAuthorizationSession(serverId);
          updateWaitingText('Browser reopened. Complete authorization in your browser...');
          continue;
        }

        pollResult = currentPollResult;
        break;
      }
    } finally {
      setPollRestartControls({ visible: false });
    }

    logOAuth(`[OAuth] Poll result: ${JSON.stringify(pollResult)}`, 'DEBUG');

    if (pollResult.timeout) {
      throw new Error('Authorization timeout - please try again');
    }

    if (pollResult.failed) {
      throw new Error(pollResult.server?.error_message || 'Authorization failed');
    }

    if (!pollResult.completed) {
      throw new Error('Authorization was not completed');
    }

    // Step 5: Verify tokens actually exist
    // DCR OAuth (Atlassian, etc.) may report "completed" but not actually save tokens
    updateWaitingText('Verifying authorization...');
    logOAuth(`[OAuth] Verifying tokens exist for ${serverId}...`);

    const tokenPersistence = await waitForOAuthTokensPersisted(serverId, {
      timeoutMs: 15000,
      pollIntervalMs: 250,
      onProgress: (elapsedSeconds) => {
        updateWaitingText(`Verifying authorization... (${elapsedSeconds}s)`);
      }
    });
    const tokensExist = tokenPersistence.persisted;

    if (!tokensExist) {
      // Tokens not saved - OAuth didn't really complete
      // This happens with DCR OAuth when SDK times out before callback exchange
      const reason = tokenPersistence.result?.reason || 'unknown';
      logOAuth(
        `[OAuth] Tokens not found after completion (reason=${reason}), attempting re-authentication...`,
        'WARN'
      );
      updateWaitingText('Re-authenticating (your session is remembered)...');

      // Restart server to trigger a fresh OAuth flow with prepared bootstrap state.
      await prepareForFreshOAuthStart(serverId);
      await window.electronAPI.apiRestartMcpServers([serverId]);

      // Wait for OAuth ready with new URL
      const reAuthReady = await waitForOAuthReady(serverId, 60000);
      if (!reAuthReady.ready || !reAuthReady.authUrl) {
        throw new Error('Re-authentication failed - could not get new auth URL');
      }

      // Open browser for re-auth (should auto-approve since user already authorized)
      logOAuth(`[OAuth] Opening browser for re-auth for ${serverId}`);
      await window.electronAPI.openExternal(reAuthReady.authUrl, {
        kind: 'oauth',
        event: 'reauthorization_opened',
        serverId,
        sessionId: 'main-stack',
      });

      // Poll for completion again (shorter timeout since user already authorized)
      updateWaitingText('Completing re-authentication...');
      const reAuthPoll = await window.electronAPI.pollOAuthCompletion(serverId, 120000);

      if (!reAuthPoll.completed) {
        throw new Error('Re-authentication failed or timed out');
      }

      // Verify token files exist this time
      const reAuthTokenPersistence = await waitForOAuthTokensPersisted(serverId, {
        timeoutMs: 15000,
        pollIntervalMs: 250,
        onProgress: (elapsedSeconds) => {
          updateWaitingText(`Completing re-authentication... (${elapsedSeconds}s)`);
        }
      });
      if (!reAuthTokenPersistence.persisted) {
        const reason = reAuthTokenPersistence.result?.reason || 'unknown';
        throw new Error(`Re-authentication completed but tokens still not saved (${reason})`);
      }

      logOAuth(`[OAuth] Re-authentication successful, tokens verified`);
    }

    // Final verification is owned by the Electron API trigger-oauth-flow path.
    // The modal should stop after browser completion + token persistence so it
    // does not race that backend recovery with a second restart.
    updateWaitingText('Authorization complete.');
    logOAuth(
      `[OAuth] Authorization complete for ${serverId}; backend readiness recovery will continue if needed`,
    );
    await markCurrentAsDone();

  } catch (error) {
    logOAuth(`[OAuth] Error during authorization for ${serverId}: ${error.message}`, 'ERROR');
    markCurrentAsFailed(error.message);
  } finally {
    setPollRestartControls({ visible: false });
  }
}

/**
 * Initialize the OAuth flow with preview bar
 */
async function initializeServerPreview(pendingServers, logFn, options = {}) {
  oauthState.servers = [];
  oauthState.currentIndex = 0;
  oauthState.completedCount = 0;
  oauthState.skippedCount = 0;
  oauthState.failedCount = 0;
  oauthState.skippedAll = false;
  oauthState.logFn = logFn;
  oauthState.completedServerIds = []; // Reset completed server IDs
  oauthState.dismissedServerIds = new Set();
  oauthState.backendManagedFinalization =
    options.backendManagedFinalization === true;

  logOAuth(`[OAuth] Initializing preview for ${pendingServers.length} server(s)`);

  // Load metadata for all servers in parallel
  const metadataPromises = pendingServers.map(async (server) => {
    const serverId = server.server_name;
    let metadata;
    try {
      metadata = await window.electronAPI.getServerMetadata(serverId);
      if (metadata.error) {
        logOAuth(`[OAuth] Could not load metadata for ${serverId}: ${metadata.error}`, 'WARN');
        metadata = { name: serverId, display_name: serverId };
      } else {
        logOAuth(`[OAuth] Loaded metadata for ${serverId}: ${metadata.display_name || metadata.name}`);
      }
    } catch (e) {
      logOAuth(`[OAuth] Error loading metadata for ${serverId}: ${e.message}`, 'ERROR');
      metadata = { name: serverId, display_name: serverId };
    }

    return {
      server,
      metadata,
      status: 'pending'
    };
  });

  oauthState.servers = await Promise.all(metadataPromises);

  // Render preview bar
  renderPreviewBar();

  // Set first server as current
  if (oauthState.servers.length > 0) {
    oauthState.servers[0].status = 'current';
    updateCurrentServerUI();
    updatePreviewBar();
  }

  logFn(`[OAuth] Preview initialized with ${oauthState.servers.length} server(s)`);
}

/**
 * Set up button event handlers
 */
function setupButtonHandlers() {
  logOAuth('[OAuth] Setting up button handlers...');

  const authorizeBtn = document.getElementById('oauth-authorize-btn');
  const skipBtn = document.getElementById('oauth-skip-btn');
  const skipAllBtn = document.getElementById('oauth-skip-all-btn');
  const prevBtn = document.getElementById('oauth-prev-btn');
  const nextBtn = document.getElementById('oauth-next-btn');
  const doneBtn = document.getElementById('oauth-done-btn');
  const closeBtn = document.getElementById('oauth-close-btn');

  logOAuth(`[OAuth] Found buttons: authorize=${!!authorizeBtn}, skip=${!!skipBtn}, skipAll=${!!skipAllBtn}, prev=${!!prevBtn}, next=${!!nextBtn}, done=${!!doneBtn}, close=${!!closeBtn}`);

  // Remove existing handlers by cloning and re-adding
  if (authorizeBtn) {
    const newAuthorize = authorizeBtn.cloneNode(true);
    authorizeBtn.parentNode.replaceChild(newAuthorize, authorizeBtn);
    newAuthorize.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] Authorize button clicked');
      handleAuthorize();
    });
  }

  if (skipBtn) {
    const newSkip = skipBtn.cloneNode(true);
    skipBtn.parentNode.replaceChild(newSkip, skipBtn);
    newSkip.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] Skip button clicked');
      skipCurrentServer();
    });
  }

  if (skipAllBtn) {
    const newSkipAll = skipAllBtn.cloneNode(true);
    skipAllBtn.parentNode.replaceChild(newSkipAll, skipAllBtn);
    newSkipAll.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] Skip All button clicked');
      skipAllRemainingServers();
    });
  }

  if (prevBtn) {
    const newPrev = prevBtn.cloneNode(true);
    prevBtn.parentNode.replaceChild(newPrev, prevBtn);
    newPrev.addEventListener('click', (e) => {
      e.preventDefault();
      if (oauthState.currentIndex > 0) {
        navigateToServer(oauthState.currentIndex - 1);
      }
    });
  }

  if (nextBtn) {
    const newNext = nextBtn.cloneNode(true);
    nextBtn.parentNode.replaceChild(newNext, nextBtn);
    newNext.addEventListener('click', (e) => {
      e.preventDefault();
      if (oauthState.currentIndex < oauthState.servers.length - 1) {
        navigateToServer(oauthState.currentIndex + 1);
      }
    });
  }

  if (doneBtn) {
    const newDone = doneBtn.cloneNode(true);
    doneBtn.parentNode.replaceChild(newDone, doneBtn);
    newDone.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] Done button clicked');
      closeOAuthModal();
    });
  }

  // Close button (X) handler
  if (closeBtn) {
    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    newClose.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] Close button (X) clicked');
      closeOAuthModal();
    });
  }

  // View Logs button handler
  const viewLogsBtn = document.getElementById('oauth-view-logs-btn');
  if (viewLogsBtn) {
    const newViewLogs = viewLogsBtn.cloneNode(true);
    viewLogsBtn.parentNode.replaceChild(newViewLogs, viewLogsBtn);
    newViewLogs.addEventListener('click', (e) => {
      e.preventDefault();
      logOAuth('[OAuth] View Logs button clicked');
      openLogsForCurrentServer();
    });
  }

  // Escape key handler
  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('oauth-modal');
      if (modal && modal.classList.contains('visible')) {
        logOAuth('[OAuth] Escape key pressed - closing modal');
        closeOAuthModal();
        // Remove the event listener after closing
        document.removeEventListener('keydown', escapeHandler);
      }
    }
  };
  // Remove any previous escape handler and add new one
  document.removeEventListener('keydown', oauthState.escapeHandler);
  oauthState.escapeHandler = escapeHandler;
  document.addEventListener('keydown', escapeHandler);

  logOAuth('[OAuth] Button handlers setup complete');
}

/**
 * Run OAuth flow for a single server (backwards compatibility)
 * @param {string} serverId - The server ID to authorize
 * @param {Function} logFn - Optional logging function
 * @returns {Promise<{completed: boolean, error?: string}>}
 */
async function runOAuthFlowForSingleServer(
  serverId,
  logFn = console.log,
  options = {},
) {
  // Create a fake pending servers array with just this server
  const fakeServer = { server_name: serverId, state: 'active' };
  const result = await runOAuthFlowForMultipleServers([fakeServer], logFn, options);
  return {
    completed: result.completedCount > 0,
    error: result.completedCount === 0 ? 'Authorization not completed' : undefined
  };
}

/**
 * Run OAuth flow for multiple servers with preview and navigation
 * @param {Array<Object>} pendingServers - Array of server objects needing OAuth
 * @param {Function} logFn - Optional logging function
 * @returns {Promise<{completedCount: number, skipped: boolean}>}
 */
async function runOAuthFlowForMultipleServers(
  pendingServers,
  logFn = console.log,
  options = {},
) {
  // Guard against concurrent flows
  if (oauthFlowInProgress) {
    logFn('[OAuth] OAuth flow already in progress, skipping duplicate call');
    return { completedCount: 0, skipped: false };
  }

  oauthFlowInProgress = true;

  try {
    logFn(`[OAuth] Starting OAuth flow for ${pendingServers.length} server(s)...`);

    // Always reset modal visuals before reusing this component in the same session.
    resetOAuthModalUIState();

    // Initialize preview
    await initializeServerPreview(pendingServers, logFn, options);

    // Set up button handlers
    setupButtonHandlers();

    // Show modal — suppress the OWUI BrowserView so the modal is visible
    if (window.setOwuiInteractionSuppressed) {
      window.setOwuiInteractionSuppressed('oauth-modal', true);
    }
    const modal = document.getElementById('oauth-modal');
    if (modal) {
      modal.classList.add('visible');
      // Add single-server class if only one server to simplify the UI
      if (pendingServers.length === 1) {
        modal.classList.add('single-server');
      } else {
        modal.classList.remove('single-server');
      }
    }

    // Wait for user to complete flow
    await new Promise((resolve) => {
      oauthState.resolveFlow = resolve;
    });

    const outcome = getOAuthOutcomeCounts();
    logFn(`[OAuth] OAuth flow complete`);
    logFn(`[OAuth] Results: ${outcome.completed} completed, ${outcome.skipped} skipped, ${outcome.failed} failed`);

    return {
      completedCount: outcome.completed,
      skipped: oauthState.skippedAll || outcome.skipped > 0,
      completedServerIds: [...oauthState.completedServerIds] // Return copy of completed server IDs
    };

  } finally {
    oauthFlowInProgress = false;
  }
}

// Expose for external callers (e.g. index.js onOAuthFlowCompleted handler)
window.closeOAuthModal = closeOAuthModal;
