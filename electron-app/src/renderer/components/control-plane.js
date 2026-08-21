// Control plane component

// Fun loading messages (Sims-style)
const funnyLoadingMessages = [
  'Reticulating splines...',
  'Calibrating flux capacitors...',
  'Untangling quantum strings...',
  'Herding digital cats...',
  'Convincing electrons to cooperate...',
  'Bribing the database...',
  'Warming up the hamster wheels...',
  'Consulting the magic 8-ball...',
  'Generating witty loading messages...',
  'Reversing the polarity...',
  'Compiling the compilations...',
  'Asking Atlas for directions...',
  'Spinning up the spinny things...',
  'Defragmenting the mainframe...',
  'Rounding up stray pixels...',
  'Tuning the algorithms...',
  'Synchronizing timelines...',
  'Brewing fresh data...',
  'Assembling the minions...',
  'Negotiating with the cloud...',
];

let loadingMessageInterval = null;

function escapeLoadingHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MCP_OPERATION_PRESENTATION_STORAGE_KEY =
  'portico.mcp-operation-presentation.v1';
const MCP_OPERATION_FOREGROUND_SUCCESS_DELAY_MS = 1_500;
const MCP_OPERATION_BACKGROUND_SUCCESS_DELAY_MS = 5_000;
const MCP_OPERATION_WARNING_STAGES = new Set([
  'needs_oauth',
  'waiting_callback',
  'not_configured',
]);

function createMcpOperationOverlayController() {
  let currentSnapshot = null;
  let initialized = false;
  let unsubscribe = null;
  let foregroundSuccessTimer = null;
  let backgroundSuccessTimer = null;
  let eventsBound = false;
  let cardRefreshQueued = false;
  let deferredOperationId = null;
  let deferredOperationTabId = null;

  function progressApi() {
    return window.McpOperationProgress || null;
  }

  function getFullTabId(tabId) {
    return tabId === 'chat' || tabId === 'control'
      ? tabId
      : `conversation-${tabId}`;
  }

  function resolveOperationOriginTabId(snapshot) {
    const chatId =
      snapshot?.metadata?.chat_id || snapshot?.metadata?.chatId || null;
    if (!chatId) {
      return null;
    }
    const resolver = window.backendModalAttention?.resolveTabIdForPayload;
    if (typeof resolver !== 'function') {
      return null;
    }
    try {
      return resolver({ chat_id: chatId }) || null;
    } catch (error) {
      console.warn('[MCP Operation UI] Could not resolve origin tab:', error);
      return null;
    }
  }

  function setOperationTabAttention(tabId, required) {
    if (!tabId) return;
    if (typeof window.setChatTabAttentionRequired === 'function') {
      window.setChatTabAttentionRequired(tabId, required === true);
    }
  }

  function deferOperationToTab(operationId, tabId) {
    deferredOperationId = operationId;
    deferredOperationTabId = tabId;
    setOperationTabAttention(tabId, true);
  }

  function clearDeferredOperationAttention() {
    if (deferredOperationTabId) {
      // Leave the attention indicator lit if a backend-requested modal (OAuth,
      // guided setup, etc.) is still queued for the same tab so we don't cancel
      // its flashing/dot before the user has addressed it.
      const pending =
        window.backendModalAttention?.getPendingCountForTab?.(
          deferredOperationTabId,
        ) || 0;
      if (pending === 0) {
        setOperationTabAttention(deferredOperationTabId, false);
      }
    }
    deferredOperationId = null;
    deferredOperationTabId = null;
  }

  function auditPresentation(event, reason, snapshot = currentSnapshot) {
    console.info(
      `[MCP Operation Audit] ${JSON.stringify({
        schemaVersion: 1,
        event,
        timestamp: new Date().toISOString(),
        operationId: snapshot?.operationId || null,
        status: snapshot?.status || null,
        phase: snapshot?.phase || null,
        revision: snapshot?.revision ?? null,
        source: 'renderer',
        rootClassification: 'active-project-root',
        channel: 'control-plane',
        elapsedMs: Math.max(
          0,
          Date.now() - (Number(snapshot?.createdAt) || Date.now()),
        ),
        safeErrorCode: null,
        reason,
      })}`,
    );
  }

  function getElements() {
    return {
      overlay: document.getElementById('mcp-operation-overlay'),
      spinner: document.getElementById('mcp-operation-spinner'),
      title: document.getElementById('mcp-operation-title'),
      subtitle: document.getElementById('mcp-operation-subtitle'),
      summary: document.getElementById('mcp-operation-summary'),
      progressBarFill: document.getElementById('mcp-operation-bar-fill'),
      list: document.getElementById('mcp-operation-list'),
      backgroundButton: document.getElementById('mcp-operation-background-btn'),
      hideButton: document.getElementById('mcp-operation-hide-btn'),
      footer: document.getElementById('mcp-operation-footer'),
      footerMessage: document.getElementById('mcp-operation-footer-message'),
      doneButton: document.getElementById('mcp-operation-done-btn'),
      banner: document.getElementById('mcp-operation-banner'),
      bannerDot: document.getElementById('mcp-operation-banner-dot'),
      bannerTitle: document.getElementById('mcp-operation-banner-title'),
      bannerSubtitle: document.getElementById('mcp-operation-banner-subtitle'),
    };
  }

  function readPresentationState() {
    try {
      const raw = window.localStorage?.getItem(
        MCP_OPERATION_PRESENTATION_STORAGE_KEY,
      );
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        typeof parsed.operationId === 'string' &&
        ['foreground', 'background', 'dismissed'].includes(parsed.mode)
      ) {
        return parsed;
      }
    } catch (error) {
      console.warn('[MCP Operation UI] Could not read presentation state:', error);
    }
    return null;
  }

  function writePresentationState(operationId, mode, patch = {}) {
    if (!operationId) return;
    try {
      const existing = readPresentationState();
      window.localStorage?.setItem(
        MCP_OPERATION_PRESENTATION_STORAGE_KEY,
        JSON.stringify({
          ...(existing?.operationId === operationId ? existing : {}),
          ...patch,
          operationId,
          mode,
        }),
      );
    } catch (error) {
      console.warn('[MCP Operation UI] Could not persist presentation state:', error);
    }
  }

  function getPresentationMode(operationId) {
    const stored = readPresentationState();
    return stored?.operationId === operationId ? stored.mode : 'foreground';
  }

  function clearCompletionTimers() {
    if (foregroundSuccessTimer) {
      clearTimeout(foregroundSuccessTimer);
      foregroundSuccessTimer = null;
    }
    if (backgroundSuccessTimer) {
      clearTimeout(backgroundSuccessTimer);
      backgroundSuccessTimer = null;
    }
  }

  function setOverlayVisible(element, visible) {
    if (!element) return;
    element.classList.toggle?.('visible', visible);
    if (!element.classList.toggle) {
      if (visible) element.classList.add('visible');
      else element.classList.remove('visible');
    }
    element.setAttribute?.('aria-hidden', visible ? 'false' : 'true');
  }

  function setBannerVisible(element, visible) {
    if (!element) return;
    if (visible) element.classList.remove('hidden');
    else element.classList.add('hidden');
    element.setAttribute?.('aria-hidden', visible ? 'false' : 'true');
  }

  function setOperationOverlayNativeSuppression(suppressed) {
    // A native WebContentsView (the chat) always paints above renderer DOM, so
    // the operation modal is only visible on top of the chat when the native
    // view is suppressed. Suppressing also moves the native view off the shell
    // header region, keeping the header/menu bar visible while the modal shows.
    window.setNativeOverlayInteractionSuppressed?.(
      'mcp-operation-overlay',
      suppressed === true,
    );
  }

  function renderRows(list, rows) {
    if (!list) return;
    list.innerHTML = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const classes = ['loading-progress-row'];
        const iconClasses = ['loading-progress-row-icon'];
        if (row.terminal) {
          let terminalClass = 'terminal-success';
          if (row.attention) {
            terminalClass = MCP_OPERATION_WARNING_STAGES.has(row.stage)
              ? 'terminal-warning'
              : 'terminal-error';
          }
          classes.push(terminalClass);
          iconClasses.push(terminalClass);
        } else {
          iconClasses.push('active');
        }
        let action = null;
        if (row.terminal && row.attention) {
          if (
            row.requiredAction === 'authenticate' ||
            row.requiredAction === 'authorize' ||
            row.requiredAction === 'oauth' ||
            row.stage === 'needs_oauth' ||
            row.stage === 'waiting_callback'
          ) {
            action = { kind: 'oauth', label: 'Authenticate' };
          } else if (
            row.requiredAction === 'configure' ||
            row.stage === 'not_configured'
          ) {
            action = { kind: 'configure', label: 'Configure' };
          } else if (
            ['failed', 'startup_failed', 'timeout', 'not_running', 'error'].includes(
              row.stage,
            )
          ) {
            action = { kind: 'logs', label: 'View logs' };
          }
        }
        const actionMarkup = action
          ? `<button class="mcp-operation-row-action" type="button" data-mcp-operation-action="${action.kind}" data-server-id="${escapeLoadingHtml(row.id)}">${action.label}</button>`
          : '';

        return `
          <div class="${classes.join(' ')}" data-server-id="${escapeLoadingHtml(row.id)}">
            <div class="loading-progress-row-header">
              <div class="loading-progress-row-main">
                <div class="${iconClasses.join(' ')}" aria-hidden="true">
                  <span></span><span></span><span></span><span></span>
                </div>
                <div class="loading-progress-row-copy">
                  <div class="loading-progress-row-label">${escapeLoadingHtml(row.label)}</div>
                  <div class="loading-progress-row-detail">${escapeLoadingHtml(row.detail || '')}</div>
                </div>
              </div>
              <div class="mcp-operation-row-actions">
                <div class="loading-progress-row-stage stage-${escapeLoadingHtml(row.stage)}">${escapeLoadingHtml(row.stageLabel || row.stage.replace(/_/g, ' '))}</div>
                ${actionMarkup}
              </div>
            </div>
            <div class="loading-progress-row-bar">
              <div class="loading-progress-row-bar-fill" style="width: ${Math.max(0, Math.min(100, Number(row.percent || 0)))}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function notifyTerminalOnce() {
    if (
      !currentSnapshot?.terminal ||
      currentSnapshot.presentationSource !== 'authoritative'
    ) {
      return;
    }
    const presentation = readPresentationState();
    if (
      presentation?.operationId === currentSnapshot.operationId &&
      presentation.terminalNotified === true
    ) {
      return;
    }

    // Reconcile the renderer's local toggle cache from the authoritative
    // terminal result. Enable operations that finish needing OAuth/config must
    // still show the card enabled with an Authenticate/Configure affordance,
    // even when the user dismisses the overlay with "Done".
    window.reconcileMcpEnableTerminalState?.(currentSnapshot);

    const total = currentSnapshot.total || currentSnapshot.rows.length;
    const noun = `MCP server${total === 1 ? '' : 's'}`;
    const verb =
      currentSnapshot.kind === 'enable'
        ? 'enabled'
        : currentSnapshot.kind === 'disable'
          ? 'disabled'
          : currentSnapshot.kind === 'restart'
            ? 'restarted'
            : 'updated';
    if (currentSnapshot.successful) {
      window.showNotification?.(
        `${total} ${noun} ${verb} successfully`,
        'success',
      );
    } else {
      window.showNotification?.(
        `${currentSnapshot.completed}/${total} ${noun} processed; review the items that need attention`,
        'warning',
      );
    }
    writePresentationState(
      currentSnapshot.operationId,
      getPresentationMode(currentSnapshot.operationId),
      { terminalNotified: true },
    );
  }

  function render() {
    const elements = getElements();
    clearCompletionTimers();

    if (!currentSnapshot) {
      setOverlayVisible(elements.overlay, false);
      setBannerVisible(elements.banner, false);
      setOperationOverlayNativeSuppression(false);
      return;
    }

    const mode = getPresentationMode(currentSnapshot.operationId);
    const dismissed = mode === 'dismissed';
    const userBackgrounded = mode === 'background';

    // Gate the full-screen modal on the tab that triggered the operation. When
    // the originating chat tab is not the active tab, the modal is deferred to a
    // compact banner and the originating tab flashes for attention instead of
    // taking over whatever the user is currently looking at.
    const activeTab = String(window.appState?.activeTab || 'chat');
    const originTabId = resolveOperationOriginTabId(currentSnapshot);
    const originTabActive =
      !originTabId || getFullTabId(originTabId) === activeTab;
    const deferredForTab = !dismissed && !originTabActive;

    const overlayVisible = !dismissed && !userBackgrounded && !deferredForTab;
    const backgrounded = userBackgrounded || deferredForTab;
    setOverlayVisible(elements.overlay, overlayVisible);
    setBannerVisible(elements.banner, !dismissed && backgrounded);
    setOperationOverlayNativeSuppression(overlayVisible);

    // Flash the originating tab while the modal is deferred so the user knows
    // where to return; release it as soon as the modal can be shown or the
    // operation is finished/dismissed.
    if (deferredForTab && !currentSnapshot.terminal && originTabId) {
      if (
        deferredOperationId !== currentSnapshot.operationId ||
        deferredOperationTabId !== originTabId
      ) {
        deferOperationToTab(currentSnapshot.operationId, originTabId);
      }
    } else {
      clearDeferredOperationAttention();
    }

    if (elements.overlay) {
      elements.overlay.classList.remove('is-success', 'needs-attention');
      if (currentSnapshot.successful) {
        elements.overlay.classList.add('is-success');
      } else if (currentSnapshot.attention) {
        elements.overlay.classList.add('needs-attention');
      }
    }
    if (elements.spinner) {
      elements.spinner.style.display = currentSnapshot.terminal ? 'none' : '';
    }
    if (elements.title) elements.title.textContent = currentSnapshot.title;
    if (elements.subtitle) elements.subtitle.textContent = currentSnapshot.subtitle;
    if (elements.summary) {
      elements.summary.textContent = `${currentSnapshot.overallPercent}%`;
    }
    if (elements.progressBarFill) {
      elements.progressBarFill.style.width = `${currentSnapshot.overallPercent}%`;
    }
    renderRows(elements.list, currentSnapshot.rows);

    const showDone = currentSnapshot.terminal && !currentSnapshot.successful;
    if (elements.footer) {
      if (showDone) elements.footer.classList.remove('hidden');
      else elements.footer.classList.add('hidden');
    }
    if (elements.doneButton) {
      elements.doneButton.style.display = showDone ? '' : 'none';
    }
    if (elements.footerMessage) {
      elements.footerMessage.textContent = currentSnapshot.attention
        ? 'Some servers need attention. Review the details above.'
        : currentSnapshot.error || 'The operation did not complete successfully.';
    }

    if (elements.banner) {
      elements.banner.classList.remove('is-success', 'needs-attention');
      if (currentSnapshot.successful) {
        elements.banner.classList.add('is-success');
      } else if (currentSnapshot.attention) {
        elements.banner.classList.add('needs-attention');
      }
      elements.banner.disabled = false;
      elements.banner.title = 'Open MCP operation progress';
      elements.banner.setAttribute?.('aria-label', 'Open MCP operation progress');
    }
    if (elements.bannerDot) {
      elements.bannerDot.classList.toggle?.('is-running', !currentSnapshot.terminal);
    }
    if (elements.bannerTitle) {
      elements.bannerTitle.textContent = currentSnapshot.title;
    }
    if (elements.bannerSubtitle) {
      elements.bannerSubtitle.textContent = currentSnapshot.subtitle;
    }
    notifyTerminalOnce();

    if (dismissed || !currentSnapshot.successful) {
      return;
    }

    const operationId = currentSnapshot.operationId;
    if (backgrounded) {
      backgroundSuccessTimer = setTimeout(() => {
        if (currentSnapshot?.operationId !== operationId) return;
        writePresentationState(operationId, 'dismissed');
        auditPresentation('modal_close', 'background_success_timeout');
        render();
      }, MCP_OPERATION_BACKGROUND_SUCCESS_DELAY_MS);
    } else {
      foregroundSuccessTimer = setTimeout(() => {
        if (currentSnapshot?.operationId !== operationId) return;
        writePresentationState(operationId, 'dismissed');
        auditPresentation('modal_close', 'foreground_success_timeout');
        render();
      }, MCP_OPERATION_FOREGROUND_SUCCESS_DELAY_MS);
    }
  }

  function acceptSnapshot(payload, options = {}) {
    const api = progressApi();
    const normalized = api?.normalizeOperationSnapshot?.(payload);
    if (!normalized) return null;
    normalized.presentationSource = options.source || 'authoritative';

    if (!api.shouldAcceptOperationSnapshot(currentSnapshot, normalized)) {
      return currentSnapshot;
    }

    const previousSnapshot = currentSnapshot;
    const previousOperationId = previousSnapshot?.operationId || null;
    const previousMode = previousOperationId
      ? getPresentationMode(previousOperationId)
      : null;
    const replacesOptimisticSnapshot =
      previousSnapshot?.optimistic === true && normalized.optimistic !== true;
    currentSnapshot = normalized;
    const persistedPresentation = readPresentationState();
    const restoresOptimisticPresentation = Boolean(
      normalized.clientRequestId &&
        persistedPresentation?.operationId === normalized.clientRequestId &&
        (persistedPresentation.mode === 'background' ||
          persistedPresentation.mode === 'dismissed'),
    );
    if (restoresOptimisticPresentation) {
      writePresentationState(
        normalized.operationId,
        persistedPresentation.mode,
      );
    } else if (
      replacesOptimisticSnapshot &&
      (previousMode === 'background' || previousMode === 'dismissed')
    ) {
      writePresentationState(normalized.operationId, previousMode);
    } else if (
      options.foreground === true ||
      (previousOperationId !== normalized.operationId &&
        readPresentationState()?.operationId !== normalized.operationId)
    ) {
      // Record the user-facing intent to foreground the operation. Whether the
      // modal is actually shown is decided at render time based on the active
      // tab, so a chat-triggered operation never takes over an unrelated tab.
      writePresentationState(normalized.operationId, 'foreground');
    }
    render();
    if (previousOperationId !== normalized.operationId) {
      const acceptedMode = getPresentationMode(normalized.operationId);
      auditPresentation(
        acceptedMode === 'foreground'
          ? 'modal_foreground'
          : acceptedMode === 'background'
            ? 'modal_background'
            : 'modal_close',
        options.source || 'new_operation',
      );
    }
    if (!cardRefreshQueued && typeof window.updateMcpServersList === 'function') {
      cardRefreshQueued = true;
      const refresh = () => {
        cardRefreshQueued = false;
        window.updateMcpServersList?.();
        window.updateMcpBadgeWithHealth?.();
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(refresh);
      } else {
        setTimeout(refresh, 0);
      }
    }
    return currentSnapshot;
  }

  function presentLegacyView(view) {
    if (!view || typeof view !== 'object') return null;
    if (
      currentSnapshot &&
      currentSnapshot.presentationSource === 'authoritative' &&
      !currentSnapshot.terminal
    ) {
      return currentSnapshot;
    }
    const revision =
      currentSnapshot?.operationId === view.operationId
        ? currentSnapshot.revision + 1
        : 1;
    return acceptSnapshot(
      {
        ...view,
        revision,
        status: view.terminal ? 'succeeded' : 'running',
      },
      { source: 'legacy' },
    );
  }

  function background() {
    if (!currentSnapshot) return;
    writePresentationState(currentSnapshot.operationId, 'background');
    auditPresentation('modal_background', 'continue_in_background');
    render();
  }

  async function foreground() {
    if (!currentSnapshot) return;
    const operationId = currentSnapshot.operationId;
    writePresentationState(operationId, 'foreground');
    auditPresentation('modal_reopen', 'compact_control');
    render();
    if (typeof window.electronAPI?.getMcpOperation !== 'function') return;
    try {
      const latest = await window.electronAPI.getMcpOperation(operationId);
      acceptSnapshot(latest);
    } catch (error) {
      console.warn('[MCP Operation UI] Could not refresh operation:', error);
    }
  }

  function handleActiveTabChange() {
    // Presentation is gated on the active tab inside render(), so simply
    // re-render: the modal surfaces if the newly active tab is the operation's
    // originating tab, and is deferred to a banner otherwise.
    if (!currentSnapshot) {
      return false;
    }
    render();
    return getPresentationMode(currentSnapshot.operationId) !== 'dismissed';
  }

  function done() {
    if (!currentSnapshot) return;
    writePresentationState(currentSnapshot.operationId, 'dismissed');
    auditPresentation('modal_close', 'user_done');
    render();
  }

  function didOAuthFlowComplete(serverId, oauthResult) {
    const completedServerIds = Array.isArray(oauthResult?.completedServerIds)
      ? oauthResult.completedServerIds
      : [];
    return (
      oauthResult?.completed === true ||
      completedServerIds.includes(serverId) ||
      (oauthResult?.completedCount === 1 && currentSnapshot?.rows.length === 1)
    );
  }

  async function reconcileOAuthCompletion(serverId, options = {}) {
    const operationId = options.operationId || currentSnapshot?.operationId;
    if (!operationId || currentSnapshot?.operationId !== operationId) {
      return false;
    }
    const originalRow = currentSnapshot.rows.find((row) => row.id === serverId);
    if (
      !originalRow?.terminal ||
      !['needs_oauth', 'waiting_callback'].includes(originalRow.stage)
    ) {
      return false;
    }

    const server = window.appState?.servers?.find((entry) => entry?.id === serverId);
    const configurationPending =
      server?.isConfigured === false &&
      (server?.requiresConfig === true || server?.requires_config === true);
    let readiness = null;
    if (!configurationPending && typeof window.refreshServerAfterOperation === 'function') {
      readiness = await window.refreshServerAfterOperation(serverId, {
        waitForHealthy: true,
        maxWait: 60_000,
      });
    }
    if (currentSnapshot?.operationId !== operationId) return false;
    const ready = readiness?.healthy === true;
    if (!configurationPending && !ready) return false;

    const currentRow = currentSnapshot.rows.find((row) => row.id === serverId);
    if (
      !currentRow?.terminal ||
      !['needs_oauth', 'waiting_callback'].includes(currentRow.stage)
    ) {
      return false;
    }

    const rows = currentSnapshot.rows.map((row) => {
      if (row.id !== serverId) return row;
      return configurationPending
        ? {
            ...row,
            stage: 'not_configured',
            stageLabel: 'Configuration required',
            detail: 'Authentication complete; configuration required.',
            terminalState: 'not_configured',
            requiredAction: 'configure',
            attention: true,
          }
        : {
            ...row,
            stage: 'healthy',
            stageLabel: 'Connected',
            detail: 'Authenticated and ready',
            terminalState: 'healthy',
            requiredAction: null,
            attention: false,
          };
    });
    const attention = rows.some((row) => row.attention);
    acceptSnapshot(
      {
        ...currentSnapshot,
        sequence: Number(currentSnapshot.revision || 0) + 1,
        status: attention ? 'attention_required' : 'succeeded',
        phase: attention ? 'attention_required' : 'succeeded',
        rows,
        summary: {
          ...currentSnapshot.summary,
          completed: rows.filter((row) => row.terminal).length,
          failed: rows.filter((row) => row.attention).length,
        },
      },
      { source: 'oauth-follow-up' },
    );
    return true;
  }

  function createStartErrorSnapshot(request, error, optimisticSnapshot) {
    const rows = (optimisticSnapshot?.rows || []).map((row) => ({
      ...row,
      stage: 'failed',
      detail: error.message || 'Could not start operation',
      terminal: true,
      attention: true,
      percent: 100,
    }));
    return {
      operationId: optimisticSnapshot?.operationId || request.clientRequestId,
      revision: Number(optimisticSnapshot?.revision || 0) + 1,
      kind: request.kind,
      status: 'failed',
      error: error.message || 'Could not start operation',
      rows,
    };
  }

  async function startOperation(request, options = {}) {
    if (typeof window.electronAPI?.startMcpOperation !== 'function') {
      throw new Error('Authoritative MCP operations are unavailable');
    }

    const api = progressApi();
    const activeSnapshotBeforeStart =
      currentSnapshot && currentSnapshot.terminal !== true
        ? currentSnapshot
        : null;
    const activeModeBeforeStart = activeSnapshotBeforeStart
      ? getPresentationMode(activeSnapshotBeforeStart.operationId)
      : null;
    const preserveActiveBackground =
      activeModeBeforeStart === 'background' ||
      activeModeBeforeStart === 'dismissed';
    const acceptStartedSnapshot = (payload) => {
      const snapshot = api?.extractOperationSnapshot?.(payload);
      const preservePresentation = Boolean(
        preserveActiveBackground &&
          activeSnapshotBeforeStart?.operationId &&
          snapshot?.operationId === activeSnapshotBeforeStart.operationId,
      );
      return acceptSnapshot(payload, {
        foreground: !preservePresentation,
      });
    };
    const optimisticSnapshot = api?.createOptimisticOperationSnapshot?.(
      request,
      options.servers,
    );
    if (optimisticSnapshot && !preserveActiveBackground) {
      acceptSnapshot(optimisticSnapshot, {
        foreground: true,
        source: 'optimistic',
      });
    }

    try {
      const result = await window.electronAPI.startMcpOperation(request);
      const resultSnapshot = api?.extractOperationSnapshot?.(result);
      if (result?.success === false && !resultSnapshot) {
        const error = new Error(result.error || 'Could not start MCP operation');
        error.code = result.errorCode || result.code || null;
        throw error;
      }

      let accepted = resultSnapshot
        ? acceptStartedSnapshot(result)
        : null;
      if (!accepted && typeof window.electronAPI.getActiveMcpOperation === 'function') {
        const active = await window.electronAPI.getActiveMcpOperation();
        accepted = acceptStartedSnapshot(active);
      }
      if (!accepted) {
        throw new Error('MCP operation started without an operation snapshot');
      }
      return accepted;
    } catch (error) {
      const activeSnapshot = api?.extractOperationSnapshot?.(
        error?.activeOperation || error?.operation || error,
      );
      if (
        (error?.code === 'MCP_OPERATION_BUSY' ||
          error?.errorCode === 'MCP_OPERATION_BUSY') &&
        activeSnapshot
      ) {
        return acceptStartedSnapshot(activeSnapshot);
      }
      if (optimisticSnapshot) {
        acceptSnapshot(createStartErrorSnapshot(request, error, optimisticSnapshot), {
          foreground: true,
          source: 'optimistic',
        });
      }
      throw error;
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    getElements().backgroundButton?.addEventListener('click', background);
    // Eye button is a cosmetic twin of the X and performs the same action.
    getElements().hideButton?.addEventListener('click', background);
    getElements().banner?.addEventListener('click', foreground);
    getElements().doneButton?.addEventListener('click', done);
    getElements().list?.addEventListener('click', async (event) => {
      const button = event.target?.closest?.('[data-mcp-operation-action]');
      if (!button) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      const action = button.dataset?.mcpOperationAction;
      const serverId = button.dataset?.serverId;
      if (!action || !serverId) return;
      try {
        if (action === 'oauth' && window.runOAuthFlowForServer) {
          const operationId = currentSnapshot?.operationId;
          const result = await window.runOAuthFlowForServer(serverId);
          if (didOAuthFlowComplete(serverId, result)) {
            await reconcileOAuthCompletion(serverId, { operationId });
          }
        } else if (action === 'oauth' && window.runOAuthFlowForSingleServer) {
          const operationId = currentSnapshot?.operationId;
          const result = await window.runOAuthFlowForSingleServer(serverId);
          if (didOAuthFlowComplete(serverId, result)) {
            await reconcileOAuthCompletion(serverId, { operationId });
          }
        } else if (action === 'configure' && window.openMcpConfigModal) {
          window.openMcpConfigModal(serverId, event);
        } else if (action === 'logs' && window.showMcpServerLogs) {
          const row = currentSnapshot?.rows.find((entry) => entry.id === serverId);
          const server = window.appState?.servers?.find(
            (entry) => entry.id === serverId,
          );
          await window.showMcpServerLogs(
            serverId,
            row?.deploymentType ||
              server?.deploymentType ||
              server?.deployment_type ||
              'docker',
            Boolean(server?.isCore),
          );
        }
      } catch (error) {
        console.error('[MCP Operation UI] Follow-up action failed:', error);
        window.showNotification?.(
          `Could not open follow-up action: ${error.message || 'Unknown error'}`,
          'error',
        );
      }
    });
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    bindEvents();

    if (typeof window.electronAPI?.onMcpOperationUpdated === 'function') {
      const maybeUnsubscribe = window.electronAPI.onMcpOperationUpdated((payload) => {
        acceptSnapshot(payload);
      });
      if (typeof maybeUnsubscribe === 'function') {
        unsubscribe = maybeUnsubscribe;
      }
    }

    if (typeof window.electronAPI?.getActiveMcpOperation === 'function') {
      const snapshotBeforeFetch = currentSnapshot;
      try {
        const active = await window.electronAPI.getActiveMcpOperation();
        if (
          currentSnapshot === snapshotBeforeFetch ||
          progressApi()?.extractOperationSnapshot?.(active)?.operationId ===
            currentSnapshot?.operationId
        ) {
          acceptSnapshot(active);
        }
      } catch (error) {
        console.warn('[MCP Operation UI] Could not restore active operation:', error);
      }
    }

    const persistedPresentation = readPresentationState();
    if (
      !currentSnapshot &&
      persistedPresentation?.mode !== 'dismissed' &&
      persistedPresentation?.operationId &&
      typeof window.electronAPI?.getMcpOperation === 'function'
    ) {
      try {
        const persistedOperation = await window.electronAPI.getMcpOperation(
          persistedPresentation.operationId,
        );
        acceptSnapshot(persistedOperation);
      } catch (error) {
        console.warn('[MCP Operation UI] Could not restore saved operation:', error);
      }
    }
  }

  function dispose() {
    clearCompletionTimers();
    clearDeferredOperationAttention();
    setOperationOverlayNativeSuppression(false);
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
    initialized = false;
  }

  return {
    acceptSnapshot,
    background,
    dispose,
    done,
    foreground,
    handleActiveTabChange,
    getCurrentSnapshot: () => currentSnapshot,
    initialize,
    isSupported: () =>
      typeof window.electronAPI?.startMcpOperation === 'function' &&
      typeof window.electronAPI?.getActiveMcpOperation === 'function' &&
      typeof window.electronAPI?.getMcpOperation === 'function' &&
      typeof window.electronAPI?.onMcpOperationUpdated === 'function',
    presentLegacyView,
    reconcileOAuthCompletion,
    startOperation,
  };
}

const mcpOperationOverlayController = createMcpOperationOverlayController();

let _loadingSafetyTimer = null;
const LOADING_SAFETY_TIMEOUT_MS = 60_000;

function showLoading(message) {
  const state = window.appState;
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingSpinner = document.getElementById('loading-spinner');
  const loadingText = document.getElementById('loading-text');

  if (message && typeof message === 'object' && message.type === 'mcp-operation') {
    mcpOperationOverlayController.presentLegacyView(message);
    return;
  }

  state.isLoading = true;
  if (loadingOverlay) loadingOverlay.classList.add('visible');

  if (_loadingSafetyTimer) clearTimeout(_loadingSafetyTimer);
  _loadingSafetyTimer = setTimeout(() => {
    if (state.isLoading) {
      console.warn('[UI] Loading overlay safety timeout — auto-hiding after', LOADING_SAFETY_TIMEOUT_MS, 'ms');
      hideLoading();
    }
  }, LOADING_SAFETY_TIMEOUT_MS);

  // Clear any existing interval
  if (loadingMessageInterval) {
    clearInterval(loadingMessageInterval);
    loadingMessageInterval = null;
  }

  if (loadingSpinner) loadingSpinner.style.display = '';
  if (loadingText) loadingText.style.display = '';

  // If a specific message is provided, show it and rotate funny messages
  if (loadingText) {
    if (typeof message === 'string' && message.trim()) {
      loadingText.textContent = message;
    } else {
      const getRandomMessage = () => funnyLoadingMessages[Math.floor(Math.random() * funnyLoadingMessages.length)];
      loadingText.textContent = getRandomMessage();
      loadingMessageInterval = setInterval(() => {
        loadingText.textContent = getRandomMessage();
      }, 2500);
    }
  }
}

function hideLoading() {
  const state = window.appState;
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingSpinner = document.getElementById('loading-spinner');
  const loadingText = document.getElementById('loading-text');

  if (_loadingSafetyTimer) {
    clearTimeout(_loadingSafetyTimer);
    _loadingSafetyTimer = null;
  }
  state.isLoading = false;
  if (loadingOverlay) loadingOverlay.classList.remove('visible');
  if (loadingSpinner) loadingSpinner.style.display = '';
  if (loadingText) loadingText.style.display = '';

  // Clear the message rotation interval
  if (loadingMessageInterval) {
    clearInterval(loadingMessageInterval);
    loadingMessageInterval = null;
  }
}

// In-app DOM toasts are retired (user-facing notifications go through the
// native macOS path). The function must keep this name, arity, and its
// window binding: ~150 call sites and many test stubs target the global, and
// replacing the top-level declaration in this classic script re-opens the
// global-clobber regression documented in marketplaces.js
// (showMarketplacesNotification).
//
// Chat-status notifications have their own typed path
// (services/chat-native-notifications.js); everything else lands here and is
// forwarded — DOM-free, timer-free — to the generic native-notification
// bridge so marketplace/config feedback is actually visible. The message
// text is passed through verbatim; the severity only picks the title.
const NATIVE_NOTIFICATION_TITLES = Object.freeze({
  success: 'Success',
  error: 'Error',
  warning: 'Warning',
});

function showNotification(message, type) {
  console.log(`[Notification:${type || "info"}] ${message}`);
  const body = String(message ?? '').trim();
  if (!body) return;
  const forwarded = window.electronAPI?.showNativeNotification?.({
    title: NATIVE_NOTIFICATION_TITLES[type] || 'Portico',
    body,
  });
  // Tolerate a main process that predates the bridge (e.g. a dev renderer
  // reload against a running app) instead of leaking unhandled rejections.
  if (forwarded && typeof forwarded.catch === 'function') {
    forwarded.catch((error) => {
      console.warn('[Notification] Native forward failed:', error?.message || error);
    });
  }
}

function updateDockerStatus(status) {
  const state = window.appState;
  state.dockerStatus = status;
  const criticalServices = ['llm-gateway', 'mcpo', 'portico-open-webui'];
  const criticalServicesRunning = criticalServices.every(service =>
    status.containers && status.containers[service] === 'running'
  );
  const mainServices = ['llm-gateway', 'mcpo', 'portico-open-webui'];
  const mainServicesRunning = mainServices.every(service =>
    status.containers && status.containers[service] === 'running'
  );

  // Update main status indicator
  const statusIndicator = document.getElementById('status-indicator');
  if (statusIndicator) {
    const statusDot = statusIndicator.querySelector('.status-dot');
    const statusText = statusIndicator.querySelector('.status-text');

    // Check health check status
    const healthCheckStatus = status.containers ? status.containers['open-webui-health-check'] : null;
    const healthCheckPassed = healthCheckStatus === 'stopped' ||
                             healthCheckStatus === 'exited' ||
                             status.healthCheckCompleted;

    // Update status indicator based on main services
    if (mainServicesRunning && healthCheckPassed) {
      if (statusDot) {
        statusDot.classList.add('running');
        statusDot.classList.remove('error');
      }
      if (statusText) statusText.textContent = 'Running';
    } else if (status.error) {
      if (statusDot) {
        statusDot.classList.add('error');
        statusDot.classList.remove('running');
      }
      if (statusText) statusText.textContent = 'Error';
    } else if (mainServicesRunning && !healthCheckPassed) {
      if (statusDot) statusDot.classList.remove('running', 'error');
      if (statusText) statusText.textContent = 'Running (Health Check Pending)';
    } else if (criticalServicesRunning) {
      if (statusDot) statusDot.classList.remove('running', 'error');
      if (statusText) statusText.textContent = 'Partial Restart in Progress';
    } else {
      if (statusDot) statusDot.classList.remove('running', 'error');
      if (statusText) statusText.textContent = 'Services Stopped';
    }
  }

  // Update individual service statuses
  if (status.containers) {
    Object.entries(status.containers).forEach(([service, serviceStatus]) => {
      const element = document.querySelector(`.service-status[data-service="${service}"]`);
      if (element) {
        const dot = element.querySelector('.status-dot');
        const text = element.querySelector('span:last-child');
        const hostModeAvailable =
          status.containers['host-mcpo-supported'] !== false && state.hostModeSupported;
        const hostMcpoConfigured = status.containers['host-mcpo-configured'] === true;

        if (!dot || !text) {
          console.warn(`Missing status elements for service: ${service}`);
          return;
        }

        // Special handling for health check service
        if (service === 'open-webui-health-check') {
          if (serviceStatus === 'stopped' || serviceStatus === 'exited') {
            dot.classList.add('running');
            dot.classList.remove('error');
            text.textContent = 'Completed';
          } else if (serviceStatus === 'running') {
            dot.classList.remove('running', 'error');
            text.textContent = 'Running...';
          } else if (serviceStatus === 'error' || serviceStatus === 'failed') {
            dot.classList.add('error');
            dot.classList.remove('running');
            text.textContent = 'Failed';
          } else if (serviceStatus === 'not_found') {
            dot.classList.add('error');
            dot.classList.remove('running');
            text.textContent = 'Not Running';
          } else {
            dot.classList.remove('running', 'error');
            text.textContent = 'Not Running';
          }
        } else {
          // Regular services
          if (serviceStatus === 'running') {
            dot.classList.add('running');
            dot.classList.remove('error', 'warning');
            const servicePid = status.containers[`${service}-pid`];
            if (servicePid) {
              text.textContent = `Running (PID: ${servicePid})`;
            } else {
              text.textContent = 'Running';
            }
          } else if (service === 'host-mcpo' && (serviceStatus === 'not_available' || !hostModeAvailable)) {
            dot.classList.add('warning');
            dot.classList.remove('running', 'error');
            text.textContent = 'Not Available';
          } else if (service === 'host-mcpo' && (serviceStatus === 'not_configured' || !hostMcpoConfigured)) {
            dot.classList.remove('running', 'error', 'warning');
            text.textContent = 'Not Needed';
          } else if (serviceStatus === 'stopped' || serviceStatus === 'exited') {
            // Special handling for host-mcpo when HOST_MODE is not supported
            if (service === 'host-mcpo' && !state.hostModeSupported) {
              dot.classList.add('warning');
              dot.classList.remove('running', 'error');
              text.textContent = 'Not Available';
            } else {
              dot.classList.add('error');
              dot.classList.remove('running', 'warning');
              text.textContent = 'Stopped';
            }
          } else if (serviceStatus === 'not_found' || serviceStatus === 'not_running') {
            if (service === 'host-mcpo' && !state.hostModeSupported) {
              dot.classList.add('warning');
              dot.classList.remove('running', 'error');
              text.textContent = 'Not Available';
            } else {
              dot.classList.add('error');
              dot.classList.remove('running', 'warning');
              text.textContent = 'Not Running';
            }
          } else {
            dot.classList.remove('running', 'error', 'warning');
            text.textContent = 'Checking...';
          }
        }
      }
    });
  }

  // Update button visibility based on service status
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const restartBtn = document.getElementById('restart-btn');

  const chatServicesAvailable = Boolean(status.containers) && (
    status.containers['portico-open-webui'] === 'running' ||
    criticalServicesRunning ||
    mainServicesRunning
  );
  const appServicesRunning = Boolean(status.running) || chatServicesAvailable;

  // Update MCP servers list whenever status changes
  // NOTE: This was causing flickering - commenting out since health status listener handles this
  // if (mainServicesRunning && window.updateMcpServersList) {
  //   console.log('[Docker DEBUG] >>> CALLING updateMcpServersList from updateDockerStatus');
  //   window.updateMcpServersList();
  // }

  if (appServicesRunning) {
    // Services are running - hide Start, show Stop and Restart
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'flex';
    if (restartBtn) restartBtn.style.display = 'flex';
  } else {
    // Services are stopped - show Start, hide Stop and Restart
    if (startBtn) startBtn.style.display = 'flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (restartBtn) restartBtn.style.display = 'none';
  }

  // Load chat interface if on chat tab and not yet loaded.
  if (chatServicesAvailable) {
    const chatTab = document.getElementById('chat-tab');
    if (chatTab && chatTab.classList.contains('active') && window.loadChatInterface && !state.chatLoaded) {
      window.loadChatInterface();
    }
    return;
  }

  // A status sample can be incomplete immediately after macOS wakes or while
  // Docker is reconciling. Preserve the existing OWUI view and chatLoaded
  // state; its own bounded readiness/reconnect path decides whether a reload
  // is actually necessary. Tearing it down here caused repeated new-session
  // veils and focus handoffs after every transient status update.
}

function updateEnvSummary() {
  const state = window.appState;
  const summary = document.getElementById('env-summary');

  if (!summary) return;

  const importantVars = ['PORTICO_USER_ID', 'PORTICO_USER_NAME', 'PORTICO_REDACT_ALLOW'];

  summary.innerHTML = importantVars.map(key => {
    const value = state.env[key] || 'Not Set';
    const displayValue = key.includes('KEY') || key.includes('TOKEN')
      ? value.substring(0, 8) + '...'
      : value;

    return `
      <div class="env-item">
        <span class="env-key">${key}</span>
        <span class="env-value">${displayValue}</span>
      </div>
    `;
  }).join('');
}

function setDrawerModalOverlaySuppressed(reason, suppressed) {
  window.setNativeOverlayInteractionSuppressed?.(reason, suppressed);
}

// Configuration modal functions
function showConfiguration() {
  const modal = document.getElementById('config-modal');
  if (modal) {
    setDrawerModalOverlaySuppressed('config-modal', true);
    modal.classList.add('visible');
    loadConfigurationInterface();
  }
}

function hideConfiguration() {
  const modal = document.getElementById('config-modal');
  if (modal) {
    modal.classList.remove('visible');
    setDrawerModalOverlaySuppressed('config-modal', false);
  }
}

// Handle Escape key to close config modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('config-modal');
    if (modal && modal.classList.contains('visible')) {
      hideConfiguration();
    }
  }
});

async function loadConfigurationInterface() {
  const state = window.appState;
  const container = document.getElementById('config-interface');
  if (!container) return;

  // Sort environment variables: PORTICO_* vars first in specific order, then rest alphabetically
  const porticoVarOrder = ['PORTICO_USER_ID', 'PORTICO_USER_NAME', 'PORTICO_REDACT_ALLOW'];
  const envEntries = Object.entries(state.env);

  const sortedEntries = envEntries.sort(([keyA], [keyB]) => {
    const isPorticoA = keyA.startsWith('PORTICO_');
    const isPorticoB = keyB.startsWith('PORTICO_');

    if (isPorticoA && isPorticoB) {
      const indexA = porticoVarOrder.indexOf(keyA);
      const indexB = porticoVarOrder.indexOf(keyB);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return keyA.localeCompare(keyB);
    }

    if (isPorticoA && !isPorticoB) return -1;
    if (!isPorticoA && isPorticoB) return 1;
    return keyA.localeCompare(keyB);
  });

  container.innerHTML = `
    <div class="tab-content active" id="env-tab">
      <h3>Environment Variables</h3>
      <div class="env-config-list">
        ${sortedEntries.map(([key, value]) => `
          <div class="env-config-item">
            <label>${key}</label>
            <input type="text"
                   data-key="${key}"
                   value="${value}"
                   class="env-input">
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function saveConfiguration() {
  const state = window.appState;
  showLoading('Saving configuration...');

  try {
    const envInputs = document.querySelectorAll('.env-input');
    for (const input of envInputs) {
      const key = input.dataset.key;
      const value = input.value;
      await window.electronAPI.updateEnvVar(key, value);
      state.env[key] = value;
    }

    const result = await window.electronAPI.saveConfig();
    if (result.success) {
      showNotification('Configuration saved successfully', 'success');
      hideConfiguration();
      updateEnvSummary();

      const restart = confirm('Configuration has been saved.\n\nServices need to be restarted for the changes to take effect.\n\nWould you like to restart services now?');
      if (restart && window.restartServices) {
        await window.restartServices();
      }
    } else {
      showNotification(`Failed to save configuration: ${result.error}`, 'error');
    }
  } catch (error) {
    showNotification(`Error: ${error.message}`, 'error');
  }

  hideLoading();
}

// Bug report modal helpers
function showBugReportModal() {
  const modal = document.getElementById('bug-report-modal');
  if (!modal) return;
  document.getElementById('bug-report-description').value = '';
  document.getElementById('bug-report-severity').value = '';
  document.getElementById('bug-report-reporter').value = '';
  const errorEl = document.getElementById('bug-report-error');
  errorEl.style.display = 'none';
  errorEl.textContent = '';
  document.getElementById('bug-report-submit-btn').disabled = false;
  populateBugReportIdentity();
  modal.classList.add('visible');
}

// Shows who the report will be attributed to (one-shot fetch on modal open).
// Transparency: the LDAP is attached automatically so admins can find the report.
async function populateBugReportIdentity() {
  const identityEl = document.getElementById('bug-report-identity');
  if (!identityEl || !window.electronAPI?.getBugReportIdentity) return;
  identityEl.textContent = '';
  try {
    const identity = await window.electronAPI.getBugReportIdentity();
    if (identity?.ldap) {
      identityEl.textContent = `Reporting as: ${identity.ldap}`;
    }
  } catch {
    // Identity display is best-effort; the upload resolves it independently.
  }
}

function hideBugReportModal() {
  const modal = document.getElementById('bug-report-modal');
  if (modal) modal.classList.remove('visible');
}

function initBugReportModal() {
  const closeBtn = document.getElementById('bug-report-close-btn');
  const cancelBtn = document.getElementById('bug-report-cancel-btn');
  const submitBtn = document.getElementById('bug-report-submit-btn');

  if (closeBtn) closeBtn.addEventListener('click', hideBugReportModal);
  if (cancelBtn) cancelBtn.addEventListener('click', hideBugReportModal);

  const modal = document.getElementById('bug-report-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideBugReportModal();
    });
  }

  if (submitBtn) submitBtn.addEventListener('click', collectAndUploadDebugInfo);
}

// Debug info collection runs in the BACKGROUND. Collection is a read-only
// snapshot (docker logs + file copies), so nothing about it needs the UI
// frozen: instead of the full-screen loading overlay we disable the trigger
// buttons and show a spinner + live percentage anchored to the right edge
// of the Collect Debug Info button itself, streamed from the main process.
// Completion/failure land on the existing native notifications.
let debugCollectionInFlight = false;
let debugCollectProgressSubscribed = false;
let debugCollectLastPercent = -1;

function setDebugCollectionTriggersDisabled(disabled) {
  for (const id of ['debug-btn', 'bug-report-submit-btn']) {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  }
}

function setDebugCollectPercent(percent) {
  const label = document.getElementById('debug-btn-percent');
  if (label) label.textContent = `${Math.round(percent)}%`;
}

function updateDebugCollectProgress(payload) {
  const percent = Number(payload?.percent);
  if (!Number.isFinite(percent) || percent < debugCollectLastPercent) {
    return;
  }
  debugCollectLastPercent = percent;
  setDebugCollectPercent(percent);
}

function showDebugCollectProgress() {
  if (!debugCollectProgressSubscribed && window.electronAPI?.onDebugCollectProgress) {
    window.electronAPI.onDebugCollectProgress((payload) => {
      if (debugCollectionInFlight) {
        updateDebugCollectProgress(payload);
      }
    });
    debugCollectProgressSubscribed = true;
  }
  debugCollectLastPercent = -1;
  setDebugCollectPercent(0);
  const progress = document.getElementById('debug-btn-progress');
  if (progress) progress.classList.remove('hidden');
}

function hideDebugCollectProgress() {
  const progress = document.getElementById('debug-btn-progress');
  if (progress) progress.classList.add('hidden');
}

async function collectDebugInfo() {
  if (debugCollectionInFlight) {
    showNotification('Debug collection is already running.', 'info');
    return;
  }
  const startedAt = Date.now();

  if (window.electronAPI?.logToMain) {
    window.electronAPI.logToMain('info', '[Debug Info] Collection started (quick action)', {
      source: 'control-plane',
      startedAt
    });
  }

  debugCollectionInFlight = true;
  setDebugCollectionTriggersDisabled(true);
  showDebugCollectProgress();

  try {
    const result = await window.electronAPI.collectDebugInfo();
    if (!result.success) {
      if (!result.alreadyRunning) {
        showNotification('Failed to collect debug info. Please try again.', 'error');
      }
      if (window.electronAPI?.logToMain) {
        window.electronAPI.logToMain('error', '[Debug Info] Collection failed', {
          source: 'control-plane',
          elapsedMs: Date.now() - startedAt,
          error: result.error || 'unknown'
        });
      }
      return;
    }

    showNotification(`Debug info saved to: ${result.zipFile}`, 'success');
    if (window.electronAPI?.logToMain) {
      window.electronAPI.logToMain('info', '[Debug Info] Collection complete', {
        source: 'control-plane',
        elapsedMs: Date.now() - startedAt,
        zipFile: result.zipFile || null
      });
    }
  } catch (error) {
    showNotification('Something went wrong collecting debug info.', 'error');
    if (window.electronAPI?.logToMain) {
      window.electronAPI.logToMain('error', '[Debug Info] Collection errored', {
        source: 'control-plane',
        elapsedMs: Date.now() - startedAt,
        error: error.message
      });
    }
  } finally {
    debugCollectionInFlight = false;
    setDebugCollectionTriggersDisabled(false);
    hideDebugCollectProgress();
  }
}

async function collectAndUploadDebugInfo() {
  const description = document.getElementById('bug-report-description').value.trim();
  const severity = document.getElementById('bug-report-severity').value;
  const reporter = document.getElementById('bug-report-reporter').value.trim();
  const errorEl = document.getElementById('bug-report-error');
  const submitBtn = document.getElementById('bug-report-submit-btn');

  if (!description) {
    errorEl.textContent = 'Please describe what happened before sending.';
    errorEl.style.display = 'block';
    return;
  }

  if (debugCollectionInFlight) {
    errorEl.textContent = 'Debug collection is already running — please wait for it to finish.';
    errorEl.style.display = 'block';
    return;
  }

  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  hideBugReportModal();

  const startedAt = Date.now();

  if (window.electronAPI?.logToMain) {
    window.electronAPI.logToMain('info', '[Debug Info] Control Plane collection started', {
      source: 'control-plane',
      startedAt
    });
  }

  debugCollectionInFlight = true;
  setDebugCollectionTriggersDisabled(true);
  showDebugCollectProgress();

  try {
    const result = await window.electronAPI.collectDebugInfo();
    if (!result.success) {
      showNotification('Something went wrong while preparing your report. Please try again.', 'error');
      if (window.electronAPI?.logToMain) {
        window.electronAPI.logToMain('error', '[Debug Info] Control Plane collection failed', {
          source: 'control-plane',
          elapsedMs: Date.now() - startedAt,
          error: result.error || 'unknown'
        });
      }
      return;
    }

    if (window.electronAPI?.logToMain) {
      window.electronAPI.logToMain('info', '[Debug Info] Collection complete, uploading...', {
        source: 'control-plane',
        elapsedMs: Date.now() - startedAt,
        zipFile: result.zipFile || null
      });
    }



    const uploadResult = await window.electronAPI.uploadDebugLogs({
      zipFile: result.zipFile,
      description,
      reporter: reporter || undefined,
      severity: severity || undefined,
    });

    if (uploadResult.success) {
      showNotification('Your report has been sent! Thank you.', 'success');
      if (window.electronAPI?.logToMain) {
        window.electronAPI.logToMain('info', '[Debug Info] Upload completed', {
          source: 'control-plane',
          elapsedMs: Date.now() - startedAt,
          slug: uploadResult.slug
        });
      }
    } else {
      const modalErrorEl = document.getElementById('bug-report-error');
      modalErrorEl.textContent = `We couldn't send your report right now. Your logs are saved here: ${result.zipFile}`;
      modalErrorEl.style.display = 'block';
      document.getElementById('bug-report-submit-btn').disabled = false;
      showBugReportModal();
      if (window.electronAPI?.logToMain) {
        window.electronAPI.logToMain('error', '[Debug Info] Upload failed', {
          source: 'control-plane',
          elapsedMs: Date.now() - startedAt,
          error: uploadResult.error
        });
      }
    }
  } catch (error) {
    const modalErrorEl = document.getElementById('bug-report-error');
    modalErrorEl.textContent = 'Something went wrong while sending your report. Please try again.';
    modalErrorEl.style.display = 'block';
    document.getElementById('bug-report-submit-btn').disabled = false;
    showBugReportModal();
    if (window.electronAPI?.logToMain) {
      window.electronAPI.logToMain('error', '[Debug Info] Control Plane collection errored', {
        source: 'control-plane',
        elapsedMs: Date.now() - startedAt,
        error: error.message
      });
    }
  } finally {
    debugCollectionInFlight = false;
    setDebugCollectionTriggersDisabled(false);
    hideDebugCollectProgress();
    const modalSubmitBtn = document.getElementById('bug-report-submit-btn');
    if (modalSubmitBtn) modalSubmitBtn.disabled = false;
  }
}

// MCP restart function - shows restart confirmation modal
function restartMcpServers() {
  // Use the restart confirmation modal from mcp-servers.js
  // Pass null for serverId/serverName to trigger "restart all" mode
  if (window.showRestartConfirmationModal) {
    window.showRestartConfirmationModal(null, null);
  } else {
    console.error('[Restart] showRestartConfirmationModal not available');
  }
}

async function refreshMcpServers() {
  if (refreshHealthCheckInProgress) {
    return;
  }

  if (!window.electronAPI || !window.electronAPI.apiHealthCheck) {
    console.error('[Health] apiHealthCheck not available');
    return;
  }

  const refreshBtn = document.getElementById('refresh-servers-btn');
  const spinnerDelayMs = 150;
  let spinnerTimeoutId = null;
  refreshHealthCheckInProgress = true;
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    spinnerTimeoutId = setTimeout(() => {
      if (refreshBtn) refreshBtn.classList.add('is-refreshing');
    }, spinnerDelayMs);

    const result = await window.electronAPI.apiHealthCheck();
    if (result && result.success === false) {
      showNotification(`Health check failed: ${result.error || 'Unknown error'}`, 'error');
    }
  } catch (error) {
    console.error('[Health] Refresh health check error:', error);
    showNotification(`Health check failed: ${error.message}`, 'error');
  } finally {
    refreshHealthCheckInProgress = false;
    if (spinnerTimeoutId) {
      clearTimeout(spinnerTimeoutId);
    }
    if (refreshBtn) {
      refreshBtn.classList.remove('is-refreshing');
      refreshBtn.disabled = false;
    }
  }
}

// Track escape handler for setup wizard modal
let setupWizardEscapeHandler = null;

// Show setup wizard confirmation modal
function showSetupWizardModal() {
  const modal = document.getElementById('setup-wizard-modal');
  if (!modal) return;

  setDrawerModalOverlaySuppressed('setup-wizard-modal', true);
  modal.classList.add('visible');

  // Set up button handlers
  const cancelBtn = document.getElementById('setup-wizard-modal-cancel-btn');
  const confirmBtn = document.getElementById('setup-wizard-modal-confirm-btn');
  const closeBtn = document.getElementById('setup-wizard-modal-close-btn');

  if (cancelBtn) {
    cancelBtn.onclick = hideSetupWizardModal;
  }

  if (confirmBtn) {
    confirmBtn.onclick = confirmSetupWizard;
  }

  if (closeBtn) {
    closeBtn.onclick = hideSetupWizardModal;
  }

  // Handle escape key - remove old handler first
  if (setupWizardEscapeHandler) {
    document.removeEventListener('keydown', setupWizardEscapeHandler);
  }
  setupWizardEscapeHandler = (e) => {
    if (e.key === 'Escape') {
      hideSetupWizardModal();
    }
  };
  document.addEventListener('keydown', setupWizardEscapeHandler);

  // Handle click outside modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      hideSetupWizardModal();
    }
  };
}

// Hide setup wizard modal
function hideSetupWizardModal() {
  const modal = document.getElementById('setup-wizard-modal');
  if (modal) {
    modal.classList.remove('visible');
    setDrawerModalOverlaySuppressed('setup-wizard-modal', false);
  }
  // Clean up escape handler
  if (setupWizardEscapeHandler) {
    document.removeEventListener('keydown', setupWizardEscapeHandler);
    setupWizardEscapeHandler = null;
  }
}

// Confirm and launch setup wizard
async function confirmSetupWizard() {
  hideSetupWizardModal();
  if (window.electronAPI.launchGuidedSetup) {
    await window.electronAPI.launchGuidedSetup();
  }
}

// Guided setup launcher - now shows modal instead of confirm()
function launchGuidedSetup() {
  showSetupWizardModal();
}

// Track if control plane buttons have been initialized
let controlPlaneButtonsInitialized = false;
let refreshHealthCheckInProgress = false;

// Initialize Control Plane V2 UI elements
function initControlPlaneV2() {
  // Initialize search and filter
  if (window.initMcpSearchFilter) {
    window.initMcpSearchFilter();
  }
  if (window.initCostDashboard) {
    window.initCostDashboard();
  }

  // Only add button listeners once to prevent duplicate listeners (3-prompt bug fix)
  if (controlPlaneButtonsInitialized) {
    return;
  }
  controlPlaneButtonsInitialized = true;

  // Initialize service log buttons via logs-panel.js
  if (window.initLogsPanel) {
    window.initLogsPanel();
  }

  initBugReportModal();
}

// Export functions
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.showNotification = showNotification;
window.updateDockerStatus = updateDockerStatus;
window.updateEnvSummary = updateEnvSummary;
window.showConfiguration = showConfiguration;
window.hideConfiguration = hideConfiguration;
window.saveConfiguration = saveConfiguration;
window.collectDebugInfo = collectDebugInfo;
window.restartMcpServers = restartMcpServers;
window.refreshMcpServers = refreshMcpServers;
window.launchGuidedSetup = launchGuidedSetup;
window.showSetupWizardModal = showSetupWizardModal;
window.hideSetupWizardModal = hideSetupWizardModal;
window.initControlPlaneV2 = initControlPlaneV2;
window.McpOperationOverlayController = mcpOperationOverlayController;

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => mcpOperationOverlayController.initialize(),
    { once: true },
  );
} else {
  mcpOperationOverlayController.initialize();
}
if (typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    mcpOperationOverlayController.dispose();
  });
}

// Add styles for configuration interface - EXACT code from services/renderer.js
const style = document.createElement('style');
style.textContent = `
  .config-tabs {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .env-config-list,
  .mcp-config-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .env-config-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .env-config-item label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: monospace;
  }

  .env-input {
    padding: 0.625rem 0.75rem;
    background: var(--bg-dark);
    border: 1px solid var(--border-default);
    border-radius: 0.25rem;
    color: var(--text-primary);
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .env-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .mcp-config-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 0.375rem;
  }

  .mcp-config-item label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .mcp-status {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: #334155;
    border-radius: 9999px;
    color: #94a3b8;
  }

  .mcp-status.configured {
    background: #064e3b;
    color: #10b981;
  }
`;
document.head.appendChild(style);
