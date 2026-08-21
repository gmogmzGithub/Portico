// Artifact Panel Component
// Handles display of live web app previews from Agent VMs

// Suppress ERR_ABORTED errors from Electron's webview internal code
// These occur when webview.src is changed while a previous load is in progress
// The errors are thrown asynchronously by Electron and can't be caught with try-catch
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && event.reason.message && event.reason.message.includes('ERR_ABORTED')) {
    event.preventDefault();
    console.log('[Artifacts] Suppressed ERR_ABORTED (expected during version switch)');
  }
});

// Divider drag state (module-level for smooth dragging)
let artifactDividerDragState = {
  isDragging: false,
  startX: 0,
  startWidth: 0,
  wrapperWidth: 0,  // Cache wrapper width on drag start
  chatContainer: null,  // Cache reference
  ratio: 0.5,  // Position as ratio of available space (persists across drags)
  pendingWidth: null,
  appliedWidth: null,
  rafId: null,
};

const ARTIFACT_CHAT_MIN_WIDTH = 640;
const ARTIFACT_PANEL_MIN_WIDTH = 300;
const ARTIFACT_DIVIDER_FALLBACK_WIDTH = 6;
const ARTIFACT_NORMAL_WINDOW_MIN_WIDTH = 640;
const ARTIFACT_RECOVERABLE_PREVIEW_ERROR_CODES = new Set([-102, -312]);
const ARTIFACT_ERR_UNSAFE_PORT = -312;

function setArtifactDividerHoverState(isHovering) {
  document.getElementById('artifact-divider')?.classList.toggle('hovering', Boolean(isHovering));
}

function clearArtifactDividerHoverState() {
  setArtifactDividerHoverState(false);
}

function getActiveArtifactTabKey() {
  return window.appState?.activeTab || 'chat';
}

function getConversationIdFromTabKey(tabKey) {
  const key = String(tabKey || '');
  return key.startsWith('conversation-') ? key.slice('conversation-'.length) : null;
}

function getArtifactViewKeyForTab(tabKey) {
  const safeTabKey = String(tabKey || 'chat').replace(/[^A-Za-z0-9_-]/g, '_');
  return `attached-artifact-panel:${safeTabKey}`;
}

function getChatContainerForArtifactTab(tabKey = getActiveArtifactTabKey()) {
  const conversationId = getConversationIdFromTabKey(tabKey);
  if (conversationId) {
    return document.getElementById(`chat-container-${conversationId}`);
  }
  return document.getElementById('chat-container');
}

function getChatWebviewForArtifactTab(tabKey = getActiveArtifactTabKey()) {
  const conversationId = getConversationIdFromTabKey(tabKey);
  if (conversationId) {
    return document.getElementById(`conversation-webview-${conversationId}`);
  }
  return document.getElementById('chat-webview');
}

// Multi-chat tiling is a PER-TAB condition: only the tab whose chat is tiled
// has no artifact real estate. tabKey -> host element -> owuiViewKey -> the
// per-view state owui-host.js tracks from tab-activity events.
function isMultiChatActiveForArtifactTab(tabKey) {
  if (!tabKey) {
    return false;
  }
  const viewKey = getChatWebviewForArtifactTab(tabKey)?.dataset?.owuiViewKey;
  return Boolean(viewKey && window.owuiMultiChat?.isActiveForViewKey?.(viewKey));
}

function ensureArtifactWrapperForChatContainer(chatContainer, tabKey = getActiveArtifactTabKey()) {
  if (!chatContainer) {
    return null;
  }

  const existing = chatContainer.closest('.chat-and-artifact-wrapper');
  if (existing) {
    existing.dataset.artifactTabKey = tabKey;
    return existing;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-and-artifact-wrapper';
  wrapper.dataset.artifactTabKey = tabKey;
  chatContainer.parentNode?.insertBefore(wrapper, chatContainer);
  wrapper.appendChild(chatContainer);
  return wrapper;
}

function getCurrentArtifactChatContainer() {
  return window.artifactPanel?.getActiveChatContainer?.() ||
    getChatContainerForArtifactTab();
}

function getCurrentArtifactWrapper() {
  return window.artifactPanel?.getActiveWrapper?.() ||
    ensureArtifactWrapperForChatContainer(getCurrentArtifactChatContainer());
}

function getArtifactDividerWidth() {
  const divider = document.getElementById('artifact-divider');
  if (!divider) {
    return ARTIFACT_DIVIDER_FALLBACK_WIDTH;
  }

  const rectWidth = divider.getBoundingClientRect().width;
  if (Number.isFinite(rectWidth) && rectWidth > 0) {
    return rectWidth;
  }

  const computedWidth = Number.parseFloat(window.getComputedStyle(divider).width);
  if (Number.isFinite(computedWidth) && computedWidth > 0) {
    return computedWidth;
  }

  return ARTIFACT_DIVIDER_FALLBACK_WIDTH;
}

function getArtifactAvailableWidth(wrapperWidth) {
  return Math.max(0, wrapperWidth - getArtifactDividerWidth());
}

function clampArtifactChatWidth(width, wrapperWidth) {
  const maxChatWidth = Math.max(
    ARTIFACT_CHAT_MIN_WIDTH,
    wrapperWidth - getArtifactDividerWidth() - ARTIFACT_PANEL_MIN_WIDTH
  );
  return Math.max(ARTIFACT_CHAT_MIN_WIDTH, Math.min(Math.floor(width), maxChatWidth));
}

function applyArtifactChatWidth(chatContainer, width) {
  if (!chatContainer || !Number.isFinite(width)) return;
  chatContainer.style.setProperty('--artifact-chat-width', `${width}px`);
  artifactDividerDragState.appliedWidth = width;
  window.syncOwuiHosts?.();
  window.syncArtifactViewHosts?.();
  window.artifactPanel?.queueDividerOverlaySync?.();
}

function flushArtifactDividerWidth() {
  if (!artifactDividerDragState.chatContainer || !Number.isFinite(artifactDividerDragState.pendingWidth)) {
    return;
  }

  applyArtifactChatWidth(
    artifactDividerDragState.chatContainer,
    artifactDividerDragState.pendingWidth
  );
}

function scheduleArtifactDividerWidth(width) {
  artifactDividerDragState.pendingWidth = width;

  if (artifactDividerDragState.rafId !== null) {
    return;
  }

  artifactDividerDragState.rafId = window.requestAnimationFrame(() => {
    artifactDividerDragState.rafId = null;
    flushArtifactDividerWidth();
  });
}

// Track if resize listener is initialized
let dividerResizeListenerInitialized = false;

// Handle window resize - maintain divider position as percentage
function onWindowResizeForDivider() {
  const chatContainer = getCurrentArtifactChatContainer();
  const wrapper = getCurrentArtifactWrapper();

  // Only apply if artifact panel is open
  if (!chatContainer || !wrapper) return;
  if (!chatContainer.classList.contains('with-artifact-panel')) return;

  const wrapperWidth = wrapper.getBoundingClientRect().width;
  const availableWidth = getArtifactAvailableWidth(wrapperWidth);
  if (availableWidth <= 0) return;

  // Calculate new width from stored ratio
  const newWidth = clampArtifactChatWidth(
    artifactDividerDragState.ratio * availableWidth,
    wrapperWidth
  );

  applyArtifactChatWidth(chatContainer, newWidth);
  window.artifactPanel?.queueDividerOverlaySync?.();
}

// Initialize resize listener (called once)
function initDividerResizeListener() {
  if (dividerResizeListenerInitialized) return;
  window.addEventListener('resize', onWindowResizeForDivider);
  dividerResizeListenerInitialized = true;
}

function getArtifactDividerEventX(event) {
  const screenX = Number(event?.screenX);
  if (Number.isFinite(screenX)) {
    return screenX;
  }

  const clientX = Number(event?.clientX);
  if (Number.isFinite(clientX)) {
    return clientX;
  }

  return null;
}

// Standalone drag handlers (fed by the native divider overlay)
function startArtifactDividerDrag(event) {
  if (event?.button !== undefined && event.button !== 0) {
    return;
  }

  const chatContainer = getCurrentArtifactChatContainer();
  const wrapper = getCurrentArtifactWrapper();
  if (!chatContainer || !wrapper) return;
  if (!chatContainer.classList.contains('with-artifact-panel')) return;

  const startX = getArtifactDividerEventX(event);
  if (!Number.isFinite(startX)) {
    return;
  }

  artifactDividerDragState.isDragging = true;
  artifactDividerDragState.startX = startX;
  artifactDividerDragState.startWidth = chatContainer.getBoundingClientRect().width;
  artifactDividerDragState.wrapperWidth = wrapper.getBoundingClientRect().width;
  artifactDividerDragState.chatContainer = chatContainer;
  artifactDividerDragState.pendingWidth = artifactDividerDragState.startWidth;
  artifactDividerDragState.appliedWidth = artifactDividerDragState.startWidth;

  document.getElementById('artifact-divider')?.classList.add('dragging');
  wrapper.classList.add('dragging-artifact-divider');
  document.getElementById('artifact-panel')?.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onArtifactDividerDrag(event) {
  if (!artifactDividerDragState.isDragging) return;

  const currentX = getArtifactDividerEventX(event);
  if (!Number.isFinite(currentX)) {
    return;
  }

  const { startX, startWidth, wrapperWidth, chatContainer } = artifactDividerDragState;
  if (!chatContainer) return;

  const delta = currentX - startX;
  const newWidth = clampArtifactChatWidth(startWidth + delta, wrapperWidth);

  scheduleArtifactDividerWidth(newWidth);
}

function stopArtifactDividerDrag() {
  if (!artifactDividerDragState.isDragging) return;

  if (artifactDividerDragState.rafId !== null) {
    window.cancelAnimationFrame(artifactDividerDragState.rafId);
    artifactDividerDragState.rafId = null;
  }
  flushArtifactDividerWidth();

  // Calculate and store ratio before clearing state
  const chatContainer = artifactDividerDragState.chatContainer;
  if (chatContainer) {
    const wrapper = getCurrentArtifactWrapper();
    if (wrapper) {
      const wrapperWidth = wrapper.getBoundingClientRect().width;
      const chatWidth = artifactDividerDragState.appliedWidth ?? chatContainer.getBoundingClientRect().width;
      const availableWidth = getArtifactAvailableWidth(wrapperWidth);
      if (availableWidth > 0) {
        artifactDividerDragState.ratio = chatWidth / availableWidth;
        window.artifactPanel?.rememberActiveDividerRatio?.(artifactDividerDragState.ratio);
      }
    }
  }

  artifactDividerDragState.isDragging = false;
  artifactDividerDragState.chatContainer = null;
  artifactDividerDragState.pendingWidth = null;
  artifactDividerDragState.appliedWidth = null;
  document.getElementById('artifact-divider')?.classList.remove('dragging');
  clearArtifactDividerHoverState();
  getCurrentArtifactWrapper()?.classList.remove('dragging-artifact-divider');
  document.getElementById('artifact-panel')?.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.artifactPanel?.queueDividerOverlaySync?.();
}

class ArtifactPanel {
  constructor() {
    this.currentArtifact = null;
    this.isOpen = false;
    this.panel = null;
    this.webview = null;
    this.nativeArtifactViewSuppressionReasons = new Set();
    this.runningVersions = new Map();  // version -> {host_port, isRunning}
    this.healthCheckInterval = null;
    this.dividerInitialized = false;
    this.activePreviewUrl = null;
    this.usingFallbackPreview = false;
    this.previewRecoveryPromise = null;
    this.dividerOverlaySyncRaf = null;
    this.isPublishing = false;
    this.publishedUrl = null;
    this.attachedArtifactsByTab = new Map();
    this.pendingArtifactOpensByChatId = new Map();
    this.activeTabKey = getActiveArtifactTabKey();
    this.activeViewKey = null;
    this.windowArtifactLayoutActive = false;
    this.initElements();
    this.initEventListeners();
    this.initDividerDrag();
  }

  initElements() {
    this.panel = document.getElementById('artifact-panel');
    this.divider = document.getElementById('artifact-divider');
    this.webviewHost = document.getElementById('artifact-webview-host');
    this.webview = this.webviewHost ? this.webviewHost.querySelector('webview') : null;
    this.nameEl = document.getElementById('artifact-name');
    this.loadingOverlay = document.getElementById('artifact-loading-overlay');
    this.loadingText = document.getElementById('artifact-loading-text');
    // Custom dropdown elements (replaces native select)
    this.versionDropdown = document.getElementById('version-dropdown');
    this.versionTrigger = document.getElementById('version-dropdown-trigger');
    this.versionTriggerIndicator = document.getElementById('version-trigger-indicator');
    this.versionText = document.getElementById('version-dropdown-text');
    this.publishBtn = document.getElementById('artifact-publish-btn');
    this.publishStatusEl = document.getElementById('artifact-publish-status');
    this.refreshBtn = document.getElementById('artifact-refresh-btn');
    this.detachBtn = document.getElementById('artifact-detach-btn');
    this.closeBtn = document.getElementById('artifact-close-btn');
    this.chatContainer = getChatContainerForArtifactTab(this.activeTabKey);
    // Track dropdown state
    this.dropdownOpen = false;
    this.versions = [];  // Store version data for dropdown
  }

  getActiveTabKey() {
    return getActiveArtifactTabKey();
  }

  getActiveChatContainer() {
    return getChatContainerForArtifactTab(this.activeTabKey || this.getActiveTabKey());
  }

  getActiveWrapper() {
    return ensureArtifactWrapperForChatContainer(
      this.getActiveChatContainer(),
      this.activeTabKey || this.getActiveTabKey()
    );
  }

  getAttachedState(tabKey = this.activeTabKey || this.getActiveTabKey()) {
    return this.attachedArtifactsByTab.get(tabKey) || null;
  }

  getLoadedChatIdForWebview(webview) {
    if (!webview) {
      return null;
    }
    return this.extractChatIdFromUrl(webview);
  }

  getLoadedChatIdForTabKey(tabKey = this.getActiveTabKey()) {
    return this.getLoadedChatIdForWebview(getChatWebviewForArtifactTab(tabKey));
  }

  isTabLoadedForChat(tabKey, chatId) {
    const normalizedChatId = String(chatId || '').trim();
    return Boolean(normalizedChatId && this.getLoadedChatIdForTabKey(tabKey) === normalizedChatId);
  }

  getActiveLoadedChatId() {
    return this.getLoadedChatIdForTabKey(this.getActiveTabKey());
  }

  isAttachedStateValidForTab(tabKey, state = this.getAttachedState(tabKey)) {
    const attachedChatId = String(state?.artifact?.chat_id || '').trim();
    return Boolean(attachedChatId && this.isTabLoadedForChat(tabKey, attachedChatId));
  }

  rememberActiveDividerRatio(ratio) {
    const state = this.getAttachedState();
    if (!state || !Number.isFinite(ratio)) {
      return;
    }
    state.ratio = Math.max(0, Math.min(1, ratio));
  }

  saveCurrentTabRuntimeState() {
    const state = this.getAttachedState();
    if (!state || !this.currentArtifact) {
      return;
    }

    state.artifact = { ...this.currentArtifact };
    state.activePreviewUrl = this.activePreviewUrl;
    state.usingFallbackPreview = this.usingFallbackPreview;
    state.versions = [...this.versions];
    state.runningVersions = [...this.runningVersions.entries()];
    state.publishedUrl = this.publishedUrl;
    state.hasLoaded = Boolean(state.hasLoaded || this.activePreviewUrl);

    const chatContainer = this.chatContainer || this.getActiveChatContainer();
    const wrapper = this.getActiveWrapper();
    if (chatContainer && wrapper && chatContainer.classList.contains('with-artifact-panel')) {
      const availableWidth = getArtifactAvailableWidth(wrapper.getBoundingClientRect().width);
      const chatWidth = chatContainer.getBoundingClientRect().width;
      if (availableWidth > 0 && Number.isFinite(chatWidth)) {
        state.ratio = Math.max(0, Math.min(1, chatWidth / availableWidth));
      }
    }
  }

  // Per-tab multi-chat query for a chat id (artifact-indicator uses this):
  // true only when the tab OWNING that chat is tiled.
  isMultiChatActiveForChatId(chatId) {
    return isMultiChatActiveForArtifactTab(this.resolveTabKeyForChatId(chatId));
  }

  resolveTabKeyForChatId(chatId) {
    const normalizedChatId = String(chatId || '').trim();
    const activeTab = this.getActiveTabKey();
    if (!normalizedChatId) {
      return this.getLoadedChatIdForTabKey(activeTab) ? activeTab : null;
    }

    const mainChatId = this.getLoadedChatIdForTabKey('chat');
    if (mainChatId === normalizedChatId) {
      return 'chat';
    }

    for (const conversationId of Object.keys(window.appState?.conversationTabs || {})) {
      const tabKey = `conversation-${conversationId}`;
      if (this.isTabLoadedForChat(tabKey, normalizedChatId)) {
        return tabKey;
      }
    }

    return this.isTabLoadedForChat(activeTab, normalizedChatId) ? activeTab : null;
  }

  queuePendingArtifactOpen(data) {
    const chatId = String(data?.chat_id || '').trim();
    if (!chatId || !data?.artifact_id) {
      return false;
    }

    const queued = [...(this.pendingArtifactOpensByChatId.get(chatId) || [])];
    const existingIndex = queued.findIndex(
      (entry) => entry?.artifact_id === data.artifact_id,
    );
    if (existingIndex >= 0) {
      queued[existingIndex] = { ...data, chat_id: chatId };
    } else {
      queued.push({ ...data, chat_id: chatId });
    }
    this.pendingArtifactOpensByChatId.set(chatId, queued);
    console.log(
      `[Artifacts] Queued artifact ${data.artifact_id} until chat ${chatId} is loaded`,
    );
    return true;
  }

  async routeArtifactOpen(data, options = {}) {
    // Explicit detach requests always open windowed.
    if (data?.detached) {
      this.openDetached(data);
      this.notifyIndicator();
      return true;
    }

    const requestedChatId = String(data?.chat_id || '').trim();
    const targetTabKey =
      options.targetTabKey || this.resolveTabKeyForChatId(requestedChatId);
    // Multi-chat tiling: windowed-only applies PER TAB — only when the tab
    // that owns this artifact's chat is itself tiled (no real estate there).
    // A tiled workflow in another tab must not window this tab's artifacts.
    if (isMultiChatActiveForArtifactTab(targetTabKey)) {
      this.openDetached(data);
      this.notifyIndicator();
      return true;
    }
    // Unresolvable target (chat not loaded in any tab): conservative fallback
    // to the shell-wide check — except dock-backs, which the user explicitly
    // aimed at an (untiled) tab.
    if (!targetTabKey && !data?.reattached && window.owuiMultiChat?.anyActive?.()) {
      this.openDetached(data);
      this.notifyIndicator();
      return true;
    }
    const targetChatId = requestedChatId || this.getLoadedChatIdForTabKey(targetTabKey);
    if (!targetTabKey || !targetChatId || !this.isTabLoadedForChat(targetTabKey, targetChatId)) {
      if (options.queueIfUnavailable !== false && this.queuePendingArtifactOpen(data)) {
        this.notifyIndicator();
        return false;
      }
      console.warn('[Artifacts] Ignoring attached artifact-open without a loaded target chat:', data);
      this.notifyIndicator();
      return false;
    }

    const targetState = this.getAttachedState(targetTabKey);
    const shouldDetach =
      this.isAttachedStateValidForTab(targetTabKey, targetState) &&
      targetState?.artifact?.artifact_id &&
      targetState.artifact.artifact_id !== data.artifact_id;

    if (shouldDetach) {
      console.log('[Artifacts] Tab artifact slot occupied by different artifact, opening detached');
      this.openDetached(data);
    } else {
      await this.open(
        data.artifact_id,
        data.preview_url,
        data.name,
        data.version,
        targetChatId,
        {
          tabKey: targetTabKey,
          preserveRatio: targetState?.artifact?.artifact_id === data.artifact_id,
        },
      );
      if (data.reattached) {
        console.log('[Artifacts] Reattached artifact from detached window');
      }
    }

    this.notifyIndicator();
    return true;
  }

  async handleTabChatLoaded(tabKey, chatId) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId || !this.isTabLoadedForChat(tabKey, normalizedChatId)) {
      return false;
    }

    const queued = this.pendingArtifactOpensByChatId.get(normalizedChatId);
    if (!Array.isArray(queued) || queued.length === 0) {
      return false;
    }

    // Remove the queue before awaiting so duplicate navigation events cannot
    // drain the same artifact into multiple tab slots.
    this.pendingArtifactOpensByChatId.delete(normalizedChatId);
    console.log(
      `[Artifacts] Routing ${queued.length} queued artifact open event(s) to ${tabKey}`,
    );
    for (const data of queued) {
      await this.routeArtifactOpen(data, {
        targetTabKey: tabKey,
        queueIfUnavailable: false,
      });
    }
    return true;
  }

  getCurrentSlotForChat(chatId) {
    const tabKey = this.resolveTabKeyForChatId(chatId);
    if (!tabKey) {
      return null;
    }
    const state = this.getAttachedState(tabKey);
    return this.isAttachedStateValidForTab(tabKey, state) ? state : null;
  }

  canAttachArtifactToChat(chatId = null, artifactId = null) {
    const tabKey = this.resolveTabKeyForChatId(chatId);
    if (!tabKey) {
      return false;
    }
    const state = this.getAttachedState(tabKey);
    if (!this.isAttachedStateValidForTab(tabKey, state)) {
      return true;
    }
    if (!state?.artifact?.artifact_id) {
      return true;
    }
    return Boolean(artifactId && state.artifact.artifact_id === artifactId);
  }

  hasAttachedArtifact(artifactId) {
    if (!artifactId) {
      return false;
    }
    return Array.from(this.attachedArtifactsByTab.values()).some(
      (state) => state?.artifact?.artifact_id === artifactId,
    );
  }

  retainArtifactView(artifactId, tabKey) {
    if (!artifactId || !tabKey || !window.electronAPI?.artifacts?.retainView) {
      return;
    }
    void window.electronAPI.artifacts.retainView(artifactId, getArtifactViewKeyForTab(tabKey)).catch((error) => {
      console.error('[Artifacts] Failed to retain artifact runtime:', error);
    });
  }

  releaseArtifactView(artifactId, tabKey) {
    if (!artifactId || !window.electronAPI?.artifacts?.releaseView) {
      return;
    }
    void window.electronAPI.artifacts.releaseView(
      artifactId,
      getArtifactViewKeyForTab(tabKey),
    ).catch((error) => {
      console.error('[Artifacts] Failed to release artifact runtime:', error);
    });
  }

  moveChromeToActiveWrapper() {
    const wrapper = this.getActiveWrapper();
    if (!wrapper || !this.panel || !this.divider) {
      return null;
    }

    const chatContainer = this.getActiveChatContainer();
    if (chatContainer && chatContainer.parentElement !== wrapper) {
      wrapper.appendChild(chatContainer);
    }
    if (this.divider.parentElement !== wrapper) {
      wrapper.appendChild(this.divider);
    }
    if (this.panel.parentElement !== wrapper) {
      wrapper.appendChild(this.panel);
    } else if (this.divider.nextElementSibling !== this.panel) {
      wrapper.appendChild(this.panel);
    }

    return wrapper;
  }

  async setArtifactLayoutActive(active) {
    const nextActive = Boolean(active);
    this.windowArtifactLayoutActive = nextActive;
    const minWidth = nextActive
      ? (ARTIFACT_CHAT_MIN_WIDTH * 2) + getArtifactDividerWidth()
      : ARTIFACT_NORMAL_WINDOW_MIN_WIDTH;

    try {
      await window.electronAPI?.setArtifactLayoutActive?.({
        active: nextActive,
        minWidth,
      });
    } catch (error) {
      console.warn('[Artifacts] Failed to update window artifact layout minimum:', error);
    }
  }

  applyActiveTabWidth(options = {}) {
    const chatContainer = this.chatContainer || this.getActiveChatContainer();
    const wrapper = this.getActiveWrapper();
    if (!chatContainer || !wrapper) {
      return;
    }

    const wrapperWidth = wrapper.getBoundingClientRect().width;
    const availableWidth = getArtifactAvailableWidth(wrapperWidth);
    if (availableWidth <= 0) {
      return;
    }

    const state = this.getAttachedState();
    const ratio = options.resetToHalf
      ? 0.5
      : (Number.isFinite(state?.ratio) ? state.ratio : 0.5);
    artifactDividerDragState.ratio = ratio;
    const width = clampArtifactChatWidth(ratio * availableWidth, wrapperWidth);
    applyArtifactChatWidth(chatContainer, width);
  }

  hideActiveChrome(options = {}) {
    const { destroyView = false, clearState = false } = options;
    this.stopHealthChecks();
    stopArtifactDividerDrag();
    this.closeDropdown();
    this.resetDividerOverlaySync();

    this.saveCurrentTabRuntimeState();

    if (this.webview) {
      this.clearNativeArtifactViewSuppression();
      window.disposeArtifactViewHost?.(this.webview, { destroyView });
      this.webview.removeAttribute('src');
    }
    this.webview = null;
    this.activeViewKey = null;

    if (this.panel) {
      this.panel.classList.add('hidden');
    }
    if (this.chatContainer) {
      this.chatContainer.classList.remove('with-artifact-panel');
      this.chatContainer.style.removeProperty('--artifact-chat-width');
    }

    if (clearState) {
      this.attachedArtifactsByTab.delete(this.activeTabKey);
    }

    this.currentArtifact = null;
    this.isOpen = false;
    this.runningVersions.clear();
    this.activePreviewUrl = null;
    this.usingFallbackPreview = false;
    this.previewRecoveryPromise = null;
    this.clearPublishStatus();
    void this.setArtifactLayoutActive(false);
  }

  canUseNativeArtifactView() {
    return Boolean(
      window.electronAPI?.artifactView &&
      typeof window.ensureArtifactViewHost === 'function' &&
      typeof window.disposeArtifactViewHost === 'function'
    );
  }

  isNativeArtifactView(element = this.webview) {
    return Boolean(element?.dataset?.artifactViewHost === 'true');
  }

  syncNativeArtifactViewSuppression() {
    if (!this.webviewHost || !this.isNativeArtifactView(this.webviewHost)) {
      return;
    }

    const suppressed = this.nativeArtifactViewSuppressionReasons.size > 0;
    this.webviewHost.classList.toggle('artifact-view-suppressed', suppressed);
    window.syncArtifactViewHosts?.();
  }

  setNativeArtifactViewSuppressed(reason, suppressed) {
    if (!reason) {
      return;
    }

    if (suppressed) {
      this.nativeArtifactViewSuppressionReasons.add(reason);
    } else {
      this.nativeArtifactViewSuppressionReasons.delete(reason);
    }

    this.syncNativeArtifactViewSuppression();
  }

  clearNativeArtifactViewSuppression() {
    this.nativeArtifactViewSuppressionReasons.clear();
    this.syncNativeArtifactViewSuppression();
  }

  setDropdownOpenState(isOpen) {
    this.dropdownOpen = Boolean(isOpen);
    this.versionDropdown?.classList.toggle('open', this.dropdownOpen);
  }

  getVersionMenuItems() {
    return this.versions.map((versionInfo) => {
      const isCurrentVersion = versionInfo.version === this.currentArtifact?.version;
      const runningInfo = this.runningVersions.get(versionInfo.version);
      const label = versionInfo.version_note
        ? `v${versionInfo.version} - ${versionInfo.version_note}`
        : `v${versionInfo.version}`;

      return {
        version: versionInfo.version,
        label,
        running: Boolean(isCurrentVersion || runningInfo?.isRunning),
      };
    });
  }

  getVersionMenuPayload() {
    if (!this.versionTrigger) {
      return null;
    }

    const items = this.getVersionMenuItems();
    const triggerRect = this.versionTrigger.getBoundingClientRect();
    if (triggerRect.width <= 0 || triggerRect.height <= 0) {
      return null;
    }

    const longestLabelLength = items.reduce(
      (max, item) => Math.max(max, String(item.label || '').length),
      0,
    );
    const width = Math.max(
      Math.round(triggerRect.width),
      Math.min(360, Math.max(220, (longestLabelLength * 7) + 72)),
    );
    const height = Math.min(240, Math.max(44, (items.length * 36) + 8));
    const horizontalMargin = 8;
    const verticalGap = 4;

    let x = Math.round(triggerRect.left);
    let y = Math.round(triggerRect.bottom + verticalGap);
    if (y + height > window.innerHeight && triggerRect.top - verticalGap - height >= 0) {
      y = Math.round(triggerRect.top - verticalGap - height);
    }

    x = Math.max(
      horizontalMargin,
      Math.min(x, Math.max(horizontalMargin, window.innerWidth - width - horizontalMargin)),
    );
    y = Math.max(
      horizontalMargin,
      Math.min(y, Math.max(horizontalMargin, window.innerHeight - height - horizontalMargin)),
    );

    return {
      x,
      y,
      width,
      height,
      theme:
        document.documentElement.getAttribute('data-theme') ||
        localStorage.getItem('theme') ||
        'dark',
      currentVersion: this.currentArtifact?.version ?? null,
      versions: items,
    };
  }

  async presentVersionDropdown() {
    const payload = this.getVersionMenuPayload();
    if (!payload || !window.electronAPI?.artifactVersionMenu?.show) {
      return false;
    }

    const shown = await window.electronAPI.artifactVersionMenu.show(payload);
    this.setDropdownOpenState(shown);
    return shown;
  }

  syncDividerOverlay() {
    if (!window.electronAPI?.artifactDividerOverlay?.sync) {
      return;
    }

    const divider = document.getElementById('artifact-divider');
    if (
      !this.isOpen ||
      !divider ||
      !this.getActiveChatContainer()?.classList.contains('with-artifact-panel')
    ) {
      clearArtifactDividerHoverState();
      void window.electronAPI.artifactDividerOverlay.hide({ notifyOwner: false }).catch(() => {});
      return;
    }

    const style = window.getComputedStyle(divider);
    const rect = divider.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      clearArtifactDividerHoverState();
      void window.electronAPI.artifactDividerOverlay.hide({ notifyOwner: false }).catch(() => {});
      return;
    }

    void window.electronAPI.artifactDividerOverlay.sync({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(getArtifactDividerWidth(), Math.round(rect.width)),
      height: Math.round(rect.height),
    }).catch((error) => {
      console.warn('[Artifacts] Failed to sync divider overlay:', error);
    });
  }

  queueDividerOverlaySync() {
    if (this.dividerOverlaySyncRaf !== null) {
      return;
    }

    this.dividerOverlaySyncRaf = window.requestAnimationFrame(() => {
      this.dividerOverlaySyncRaf = null;
      this.syncDividerOverlay();
    });
  }

  resetDividerOverlaySync() {
    if (this.dividerOverlaySyncRaf !== null) {
      window.cancelAnimationFrame(this.dividerOverlaySyncRaf);
      this.dividerOverlaySyncRaf = null;
    }

    clearArtifactDividerHoverState();
    const hidePromise = window.electronAPI?.artifactDividerOverlay?.hide?.({ notifyOwner: false });
    hidePromise?.catch?.(() => {});
  }

  handleVersionMenuEvent(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'select') {
      const version = Number(payload.version);
      if (Number.isFinite(version)) {
        this.selectVersion(version, { hideNative: false });
      }
      return;
    }

    if (payload.type === 'close') {
      this.closeDropdown({ hideNative: false });
    }
  }

  handleDividerOverlayEvent(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'drag-start') {
      startArtifactDividerDrag(payload);
      return;
    }

    if (payload.type === 'drag-move') {
      onArtifactDividerDrag(payload);
      return;
    }

    if (payload.type === 'drag-end' || payload.type === 'drag-cancel') {
      stopArtifactDividerDrag();
      return;
    }

    if (payload.type === 'hover-start') {
      setArtifactDividerHoverState(true);
      return;
    }

    if (payload.type === 'hover-end') {
      clearArtifactDividerHoverState();
    }
  }

  initEventListeners() {
    // Button handlers
    if (this.publishBtn) {
      this.publishBtn.addEventListener('click', () => {
        void this.publish();
      });
    }

    if (this.publishStatusEl) {
      this.publishStatusEl.addEventListener('click', () => {
        if (this.publishedUrl && window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(this.publishedUrl);
        }
      });
    }

    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => this.refresh());
    }

    if (this.detachBtn) {
      this.detachBtn.addEventListener('click', () => this.detach());
    }

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }

    // Custom dropdown handlers
    if (this.versionTrigger) {
      this.versionTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });
    }

    this.bindWebviewEvents();

    window.electronAPI?.artifactVersionMenu?.onEvent?.((payload) => {
      this.handleVersionMenuEvent(payload);
    });
    window.electronAPI?.artifactDividerOverlay?.onEvent?.((payload) => {
      this.handleDividerOverlayEvent(payload);
    });

    // Listen for artifact events from main process
    if (window.electronAPI) {
      window.electronAPI.onArtifactOpen((data) => {
        console.log('[Artifacts] Received artifact-open:', data);
        void this.routeArtifactOpen(data);
      });

      window.electronAPI.onArtifactClose((data) => {
        console.log('[Artifacts] Received artifact-close:', data);
        if (!data.artifact_id || data.artifact_id === this.currentArtifact?.artifact_id) {
          this.close();
        } else if (data.artifact_id) {
          for (const [tabKey, state] of this.attachedArtifactsByTab.entries()) {
            if (state?.artifact?.artifact_id === data.artifact_id) {
              this.closeTab(tabKey, { destroyView: true });
              break;
            }
          }
        }
        // Refresh indicator
        this.notifyIndicator();
      });

      window.electronAPI.onArtifactVersionChanged((data) => {
        console.log('[Artifacts] Received version-changed:', data);
        if (data.artifact_id === this.currentArtifact?.artifact_id) {
          this.updateVersion(data.version, data.preview_url, data.host_port);
        } else if (data.artifact_id) {
          for (const state of this.attachedArtifactsByTab.values()) {
            if (state?.artifact?.artifact_id === data.artifact_id) {
              state.artifact.version = data.version;
              const versionPreviewUrl = this.getVersionPreviewUrl(data.version, state.artifact);
              if (versionPreviewUrl) {
                state.artifact.preview_url = versionPreviewUrl;
              } else if (data.preview_url) {
                state.artifact.preview_url = data.preview_url;
              } else if (data.host_port) {
                state.artifact.preview_url = `http://localhost:${data.host_port}`;
              }
            }
          }
        }
      });
    }
  }

  bindWebviewEvents() {
    if (!this.webview) return;
    if (this.webview.dataset.artifactEventsBound === 'true') return;

    this.webview.addEventListener('did-fail-load', (event) => {
      // ERR_ABORTED (-3) is expected when we change the URL while loading
      // This happens during rapid version switches - not an error to worry about
      if (event.errorCode === -3) {
        console.log('[Artifacts] Webview load aborted (expected during version switch)');
        return;
      }
      // Log other errors for debugging
      if (event.errorCode !== 0) {
        console.warn('[Artifacts] Webview load failed:', event.errorCode, event.errorDescription);
        void this.handlePreviewLoadFailure(event);
      }
    });

    // Hide loading overlay when content finishes loading
    this.webview.addEventListener('did-finish-load', () => {
      this.hideLoading();
    });

    this.webview.dataset.artifactEventsBound = 'true';
  }
  getFallbackPreviewUrl() {
    if (!this.currentArtifact?.chat_id || !this.currentArtifact?.artifact_id) {
      return null;
    }

    return `http://localhost:9876/artifact-preview/${encodeURIComponent(this.currentArtifact.chat_id)}/${encodeURIComponent(this.currentArtifact.artifact_id)}/`;
  }

  getVersionPreviewUrl(version, artifact = this.currentArtifact) {
    const versionNumber = Number(version);
    if (
      !artifact?.chat_id ||
      !artifact?.artifact_id ||
      !Number.isInteger(versionNumber) ||
      versionNumber < 1
    ) {
      return null;
    }

    return `http://localhost:9876/artifact-preview/${encodeURIComponent(artifact.chat_id)}/${encodeURIComponent(artifact.artifact_id)}/versions/${versionNumber}/`;
  }

  extractPreviewPort(url) {
    if (!url) return null;

    try {
      const parsed = new URL(url);
      if (!parsed.port) return null;
      const port = Number(parsed.port);
      return Number.isFinite(port) ? port : null;
    } catch (error) {
      return null;
    }
  }

  async handlePreviewLoadFailure(event) {
    const primaryUrl = this.currentArtifact?.preview_url;
    if (!primaryUrl || !this.activePreviewUrl || this.activePreviewUrl !== primaryUrl) {
      if (this.usingFallbackPreview) {
        this.hideLoading();
      }
      return;
    }

    if (!ARTIFACT_RECOVERABLE_PREVIEW_ERROR_CODES.has(event.errorCode)) {
      this.hideLoading();
      return;
    }

    if (this.previewRecoveryPromise) {
      return;
    }

    const fallbackUrl = this.getFallbackPreviewUrl();
    this.previewRecoveryPromise = this.recoverPreviewLoad(primaryUrl, fallbackUrl, {
      skipLiveProbe: event.errorCode === ARTIFACT_ERR_UNSAFE_PORT,
    }).finally(() => {
      this.previewRecoveryPromise = null;
    });

    await this.previewRecoveryPromise;
  }

  async recoverPreviewLoad(primaryUrl, fallbackUrl, options = {}) {
    const port = this.extractPreviewPort(primaryUrl);

    if (!options.skipLiveProbe && port && window.electronAPI?.artifacts?.pingServers) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const result = await window.electronAPI.artifacts.pingServers([port]);
          const health = result?.health?.[port];
          if (result?.success && health?.running) {
            if (this.currentArtifact?.preview_url === primaryUrl) {
              console.log('[Artifacts] Preview became reachable, retrying live load');
              this.safeLoadWebview(primaryUrl);
            }
            return;
          }
        } catch (error) {
          console.warn('[Artifacts] Preview health probe failed:', error);
        }

        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }

    if (fallbackUrl && this.activePreviewUrl !== fallbackUrl) {
      console.warn('[Artifacts] Live preview unavailable, falling back to materialized workspace');
      this.showLoading('Loading artifact preview...');
      this.safeLoadWebview(fallbackUrl);
      return;
    }

    this.hideLoading();
  }

  ensureWebview() {
    const viewKey = getArtifactViewKeyForTab(this.activeTabKey || this.getActiveTabKey());
    if (this.webview && document.contains(this.webview) && this.activeViewKey === viewKey) {
      return this.webview;
    }

    if (!this.webviewHost) {
      this.webviewHost = document.getElementById('artifact-webview-host');
    }

    if (!this.webviewHost) {
      console.warn('[Artifacts] Webview host not found');
      return null;
    }

    if (!this.canUseNativeArtifactView()) {
      console.error('[Artifacts] Native artifact view host is unavailable');
      return null;
    }

    if (this.webview && this.activeViewKey && this.activeViewKey !== viewKey) {
      window.disposeArtifactViewHost?.(this.webview, { destroyView: false });
    }

    const hostElement = window.ensureArtifactViewHost(this.webviewHost, {
      viewKey,
      createImmediately: true,
    });
    this.webview = hostElement;
    this.activeViewKey = viewKey;
    this.bindWebviewEvents();
    console.log(`[Artifacts] Using native artifact view host for attached panel: ${viewKey}`);
    return hostElement;
  }

  destroyWebview() {
    if (!this.webview) return;

    this.clearNativeArtifactViewSuppression();
    window.disposeArtifactViewHost?.(this.webview, { destroyView: true });
    this.webview.removeAttribute('src');
    this.webview = null;
    this.activeViewKey = null;
  }

  // Initialize divider drag functionality (uses standalone functions for performance)
  initDividerDrag() {
    const divider = document.getElementById('artifact-divider');
    if (!divider) {
      console.log('[Artifacts] Divider element not found, will retry on panel open');
      return;
    }

    if (this.dividerInitialized) return;

    this.dividerInitialized = true;
    this.queueDividerOverlaySync();
    console.log('[Artifacts] Divider drag initialized via native overlay');
  }

  // Notify the artifact indicator to refresh
  notifyIndicator() {
    if (window.artifactIndicator) {
      window.artifactIndicator.refreshFromCurrentChat();
    }
  }

  // Extract chat_id from a URL, or from the current active chat webview when omitted.
  // This is used as a fallback when chat_id is not provided in artifact-open events.
  extractChatIdFromUrl(urlOrWebview = null) {
    try {
      let url = null;
      if (typeof urlOrWebview === 'string') {
        url = urlOrWebview;
      } else {
        const webview = urlOrWebview || (
          this.activeTabKey === 'chat'
            ? document.getElementById('chat-webview')
            : document.getElementById(`conversation-webview-${getConversationIdFromTabKey(this.activeTabKey)}`)
        );
        // Try getURL() first (more reliable for webviews), fall back to src
        if (webview) {
          url = (webview.getURL ? webview.getURL() : null) || webview.src;
        }
      }
      if (url) {
        // Match both /c/uuid and /chat/uuid patterns
        const match = url.match(/\/c(?:hat)?\/([a-f0-9-]+)/i);
        if (match) {
          console.log('[Artifacts] Extracted chat_id from URL:', match[1]);
          return match[1];
          }
      }
    } catch (e) {
      console.error('[Artifacts] Failed to extract chat_id from URL:', e);
    }
    return null;
  }

  async activateForCurrentTab(tabKey = getActiveArtifactTabKey()) {
    if (this.activeTabKey !== tabKey || this.isOpen) {
      this.hideActiveChrome({ destroyView: false });
    }

    this.activeTabKey = tabKey;
    this.chatContainer = getChatContainerForArtifactTab(tabKey);
    this.moveChromeToActiveWrapper();

    const state = this.getAttachedState(tabKey);
    if (!state?.artifact || !this.isAttachedStateValidForTab(tabKey, state)) {
      this.hideActiveChrome({ destroyView: false });
      this.notifyIndicator();
      return;
    }

    this.currentArtifact = { ...state.artifact };
    this.activePreviewUrl = state.activePreviewUrl || state.artifact.preview_url || null;
    this.usingFallbackPreview = Boolean(state.usingFallbackPreview);
    this.versions = Array.isArray(state.versions) && state.versions.length > 0
      ? [...state.versions]
      : [{ version: this.currentArtifact.version || 1, version_note: null }];
    this.runningVersions = new Map(state.runningVersions || []);
    this.publishedUrl = state.publishedUrl || null;

    this.renderAttachedHeader();
    this.panel?.classList.remove('hidden');
    this.chatContainer?.classList.add('with-artifact-panel');
    await this.setArtifactLayoutActive(true);
    this.applyActiveTabWidth();
    window.requestAnimationFrame?.(() => this.applyActiveTabWidth());
    this.ensureWebview();
    const wasLoaded = Boolean(state.hasLoaded);
    if (!wasLoaded && this.currentArtifact.preview_url) {
      this.showLoading();
      this.safeLoadWebview(this.currentArtifact.preview_url);
      state.hasLoaded = true;
    }
    this.isOpen = true;
    if (wasLoaded) {
      this.hideLoading();
    }
    this.queueDividerOverlaySync();
    this.startHealthChecks();
    this.notifyIndicator();
  }

  renderAttachedHeader() {
    if (!this.currentArtifact) {
      return;
    }

    if (this.nameEl) {
      this.nameEl.textContent = this.currentArtifact.name || 'Artifact';
    }
    if (this.versionText) {
      this.versionText.textContent = `v${this.currentArtifact.version || 1}`;
    }
    this.setDropdownOpenState(false);
    this.updateVersionDisplay();
  }

  handleTabChatChanged(tabKey, oldChatId, newChatId) {
    const state = this.getAttachedState(tabKey);
    if (!state?.artifact?.chat_id || state.artifact.chat_id !== oldChatId) {
      return;
    }
    this.closeTab(tabKey, { destroyView: true });
    console.log('[Artifacts] Closed attached artifact after tab chat navigation:', {
      tabKey,
      oldChatId,
      newChatId,
    });
  }

  closeTab(tabKey, options = {}) {
    const previousActiveTab = this.activeTabKey;
    const wasActive = previousActiveTab === tabKey;
    const artifactId = this.getAttachedState(tabKey)?.artifact?.artifact_id || null;
    if (wasActive) {
      this.hideActiveChrome({
        destroyView: options.destroyView !== false,
        clearState: true,
      });
    } else {
      const viewKey = getArtifactViewKeyForTab(tabKey);
      if (window.electronAPI?.artifactView?.destroyView && options.destroyView !== false) {
        void window.electronAPI.artifactView.destroyView(viewKey);
      } else if (window.electronAPI?.artifactView?.setVisible) {
        void window.electronAPI.artifactView.setVisible(viewKey, false);
      }
      this.attachedArtifactsByTab.delete(tabKey);
    }
    if (wasActive) {
      this.activeTabKey = previousActiveTab;
    }
    this.releaseArtifactView(artifactId, tabKey);
    this.notifyIndicator();
  }

  async open(artifactId, previewUrl, name, version = null, chatId = null, options = {}) {
    if (!this.panel) {
      console.error('[Artifacts] Panel elements not found');
      return;
    }

    // Clear preparing state if we were in it
    this.isPreparing = false;

    const preferredVersion = window.artifactIndicator?.getSessionPreferredVersion?.(artifactId);
    const hasPreferredVersion = Number.isInteger(preferredVersion);
    const initialVersion = version || 1;

    // If chatId not provided, try to extract it from the active tab's loaded OWUI URL.
    if (!chatId) {
      chatId = this.getActiveLoadedChatId();
      console.log('[Artifacts] chat_id was null, extracted from URL:', chatId);
    }

    const tabKey = options.tabKey || this.resolveTabKeyForChatId(chatId);
    if (!tabKey || !this.isTabLoadedForChat(tabKey, chatId)) {
      console.warn('[Artifacts] Refusing to attach artifact without a loaded matching chat:', {
        artifactId,
        chatId,
        tabKey,
      });
      return;
    }
    const attachedState = {
      artifact: {
      artifact_id: artifactId,
      preview_url: previewUrl,
      name: name,
      version: initialVersion,  // Temporary until we determine latest
      chat_id: chatId
      },
      ratio: options.preserveRatio
        ? (this.getAttachedState(tabKey)?.ratio ?? 0.5)
        : 0.5,
      viewKey: getArtifactViewKeyForTab(tabKey),
      activePreviewUrl: previewUrl,
      usingFallbackPreview: false,
      versions: [{ version: initialVersion, version_note: null }],
      runningVersions: [],
      publishedUrl: null,
      hasLoaded: false,
    };
    this.attachedArtifactsByTab.set(tabKey, attachedState);

    if (tabKey !== this.getActiveTabKey()) {
      console.log(`[Artifacts] Stored attached artifact ${artifactId} for inactive tab ${tabKey}`);
      this.notifyIndicator();
      return;
    }

    if (this.activeTabKey !== tabKey || this.isOpen) {
      this.hideActiveChrome({ destroyView: false });
    }
    this.activeTabKey = tabKey;
    this.chatContainer = getChatContainerForArtifactTab(tabKey);
    this.moveChromeToActiveWrapper();
    this.currentArtifact = { ...attachedState.artifact };
    this.clearPublishStatus();

    // Store whether we need to auto-switch to latest or preferred version
    this._preferredVersion = hasPreferredVersion ? preferredVersion : null;
    this._autoSwitchToLatest = !hasPreferredVersion;

    // Update UI
    if (this.nameEl) {
      this.nameEl.textContent = name || 'Artifact';
    }

    // Update version dropdown display with temporary value
    if (this.versionText) {
      this.versionText.textContent = `v${initialVersion}`;
    }
    this.setDropdownOpenState(false);
    this.versions = [{ version: initialVersion, version_note: null }];

    // Show loading overlay while artifact loads
    // This is especially important for old chats where artifact infra may need to be restored
    this.showLoading();

    // Load preview in webview
    this.ensureWebview();
    this.safeLoadWebview(previewUrl);
    attachedState.hasLoaded = true;

    // Show panel and shrink chat container
    this.panel.classList.remove('hidden');
    if (this.chatContainer) {
      this.chatContainer.classList.add('with-artifact-panel');

      // Reset ratio to 50% and calculate initial width
      artifactDividerDragState.ratio = 0.5;
      await this.setArtifactLayoutActive(true);
      this.applyActiveTabWidth({ resetToHalf: true });
      window.requestAnimationFrame?.(() => this.applyActiveTabWidth({ resetToHalf: true }));
    }

    // Ensure divider drag and resize listener are initialized
    if (!this.dividerInitialized) {
      this.initDividerDrag();
    }
    initDividerResizeListener();

    this.isOpen = true;
    this.retainArtifactView(artifactId, tabKey);
    this.queueDividerOverlaySync();
    console.log(`[Artifacts] Opened artifact ${artifactId} at ${previewUrl}`);

    // Notify detached windows that panel is now occupied
    if (window.electronAPI?.artifacts?.notifyPanelState) {
      window.electronAPI.artifacts.notifyPanelState(true, chatId, artifactId);
    }

    // Fetch all versions IMMEDIATELY after opening (fixes race condition)
    await this.refreshVersionList();

    // Auto-switch to latest version if no specific version was requested
    if (this._preferredVersion && this._preferredVersion !== this.currentArtifact.version) {
      console.log(`[Artifacts] Auto-switching to preferred version: v${this._preferredVersion}`);
      await this.switchVersion(this._preferredVersion);
    } else if (this._autoSwitchToLatest && this.versions.length > 0) {
      // First version in array is latest (sorted descending in loadVersions)
      const latestVersion = this.versions[0].version;
      if (latestVersion && latestVersion !== this.currentArtifact.version) {
        console.log(`[Artifacts] Auto-switching to latest version: v${latestVersion}`);
        await this.switchVersion(latestVersion);
      }
    }
    this._preferredVersion = null;
    this._autoSwitchToLatest = false;  // Reset flag

    // Fetch running versions and start health checks
    await this.fetchRunningVersions();
    this.saveCurrentTabRuntimeState();
    this.startHealthChecks();

    // Refresh indicator
    this.notifyIndicator();
  }

  // Fetch running versions from the server pool
  async fetchRunningVersions() {
    if (!this.currentArtifact || !window.electronAPI?.artifacts?.getRunningVersions) {
      return;
    }

    try {
      const result = await window.electronAPI.artifacts.getRunningVersions(
        this.currentArtifact.artifact_id
      );

      if (result.success && result.running_versions) {
        this.runningVersions.clear();
        for (const v of result.running_versions) {
          console.log('[Artifacts] fetchRunningVersions - storing version:', v.version, 'type:', typeof v.version);
          this.runningVersions.set(v.version, {
            host_port: v.host_port,
            isRunning: true,
            isCurrent: v.is_current
          });
        }
        console.log(`[Artifacts] Found ${this.runningVersions.size} running versions, keys:`, [...this.runningVersions.keys()]);
        this.updateVersionIndicators();
      }
    } catch (e) {
      console.error('[Artifacts] Failed to fetch running versions:', e);
    }
  }

  // Start periodic health checks for running servers
  startHealthChecks() {
    this.stopHealthChecks(); // Clear any existing interval

    if (!window.electronAPI?.artifacts?.pingServers) {
      return;
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.isOpen || this.runningVersions.size === 0) {
        return;
      }

      // The active preview is either already loaded live or intentionally
      // showing the materialized workspace fallback, so polling its port
      // only creates noise without affecting the UI.
      const ports = [...new Set(
        [...this.runningVersions.entries()]
          .filter(([version, info]) => (
            version !== this.currentArtifact?.version && Number.isFinite(Number(info?.host_port))
          ))
          .map(([, info]) => Number(info.host_port))
      )];

      if (ports.length === 0) {
        return;
      }

      try {
        const result = await window.electronAPI.artifacts.pingServers(ports);

        if (result.success && result.health) {
          // Update isRunning status based on health check
          let anyChanged = false;
          for (const [version, info] of this.runningVersions.entries()) {
            if (version === this.currentArtifact?.version) {
              continue;
            }
            const health = result.health[info.host_port];
            if (health) {
              const wasRunning = info.isRunning;
              info.isRunning = health.running;
              if (wasRunning !== health.running) {
                console.log(`[Artifacts] Health: v${version} port ${info.host_port} changed: ${wasRunning} -> ${health.running}`);
                anyChanged = true;
              }
            }
          }
          if (anyChanged) {
            this.updateVersionIndicators();
          }
        }
      } catch (e) {
        console.error('[Artifacts] Health check failed:', e);
      }
    }, 5000); // Every 5 seconds

    console.log('[Artifacts] Started health checks');
  }

  // Stop health check polling
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log('[Artifacts] Stopped health checks');
    }
  }

  // Update version dropdown indicators (green for running, gray for stopped)
  updateVersionIndicators() {
    // Re-render the dropdown menu with updated indicators
    this.renderVersionMenu();
    // Also update the trigger button text
    this.updateVersionDisplay();
  }

  // Toggle dropdown visibility
  toggleDropdown() {
    if (this.dropdownOpen) {
      this.closeDropdown();
    } else {
      void this.openDropdown();
    }
  }

  // Open dropdown
  async openDropdown() {
    if (!this.versionDropdown) return;
    await this.presentVersionDropdown();
  }

  // Close dropdown
  closeDropdown(options = {}) {
    this.setDropdownOpenState(false);
    if (this.isOpen) {
      this.queueDividerOverlaySync();
    }
    if (options.hideNative === false) {
      return;
    }

    const hidePromise = window.electronAPI?.artifactVersionMenu?.hide?.({
      notifyOwner: false,
      reason: options.reason || 'dismiss',
    });
    hidePromise?.catch?.(() => {});
  }

  // Handle version selection from dropdown
  selectVersion(version, options = {}) {
    if (options.closeDropdown !== false) {
      this.closeDropdown({ hideNative: options.hideNative });
    }
    if (version !== this.currentArtifact?.version) {
      this.switchVersion(version, { userInitiated: true });
    }
  }

  // Refresh the native version menu if it is visible
  renderVersionMenu() {
    if (this.dropdownOpen) {
      void this.presentVersionDropdown();
    }
  }

  setPublishButtonDisabled(disabled) {
    if (this.publishBtn) {
      this.publishBtn.disabled = Boolean(disabled);
    }
  }

  setPublishStatus(kind, message, url = null, linkText = null) {
    this.publishedUrl = url;
    if (!this.publishStatusEl) return;

    this.publishStatusEl.classList.remove('hidden', 'success', 'error');
    if (kind) {
      this.publishStatusEl.classList.add(kind);
    }
    this.publishStatusEl.textContent = '';
    if (url && linkText && message.includes(linkText)) {
      const [beforeLink, afterLink] = message.split(linkText);
      const link = document.createElement('a');
      link.href = url;
      link.textContent = linkText;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.electronAPI?.openExternal?.(url);
      });

      this.publishStatusEl.append(beforeLink, link, afterLink);
    } else {
      this.publishStatusEl.textContent = message;
    }
    this.publishStatusEl.title = url || message;
  }

  clearPublishStatus() {
    this.publishedUrl = null;
    if (this.publishStatusEl) {
      this.publishStatusEl.classList.add('hidden');
      this.publishStatusEl.classList.remove('success', 'error');
      this.publishStatusEl.textContent = '';
      this.publishStatusEl.removeAttribute('title');
    }
    this.setPublishButtonDisabled(false);
  }

  async publish() {
    if (this.isPublishing) return { success: false, error: 'Publish already in progress' };
    if (!this.currentArtifact) return { success: false, error: 'No artifact to publish' };
    if (!window.electronAPI?.artifacts?.publish) {
      this.setPublishStatus('error', 'Publish is not available in this build.');
      return { success: false, error: 'Publish is not available' };
    }

    this.isPublishing = true;
    this.setPublishButtonDisabled(true);
    this.setPublishStatus(null, 'Publishing to Prototypes...');

    try {
      const result = await window.electronAPI.artifacts.publish({
        artifactId: this.currentArtifact.artifact_id,
        chatId: this.currentArtifact.chat_id,
        name: this.currentArtifact.name,
        version: this.currentArtifact.version,
      });

      if (result?.success) {
        const url = result.projectUrl || result.prototypeUrl || null;
        this.setPublishStatus(
          'success',
          'Published to Prototype Hub. Build takes ~5 min.',
          url,
          url ? 'Prototype Hub' : null,
        );
      } else {
        this.setPublishStatus('error', result?.error || 'Failed to publish artifact.');
      }

      return result;
    } catch (error) {
      const message = error?.message || 'Failed to publish artifact.';
      this.setPublishStatus('error', message);
      return { success: false, error: message };
    } finally {
      this.isPublishing = false;
      this.setPublishButtonDisabled(false);
    }
  }

  close() {
    if (!this.panel) return;

    const artifactId = this.currentArtifact?.artifact_id || null;
    const tabKey = this.activeTabKey;

    // Remember which artifact was open for this chat (for auto-restore)
    if (this.currentArtifact?.chat_id && window.artifactIndicator) {
      window.artifactIndicator.rememberArtifactForChat(this.currentArtifact.chat_id, {
        artifact_id: this.currentArtifact.artifact_id,
        version: this.currentArtifact.version,
        name: this.currentArtifact.name
      });
    }

    this.hideActiveChrome({ destroyView: true, clearState: true });
    console.log('[Artifacts] Panel closed');

    // Notify detached windows that panel is now available for re-attach
    if (window.electronAPI?.artifacts?.notifyPanelState) {
      window.electronAPI.artifacts.notifyPanelState(false, null, null);
    }

    this.releaseArtifactView(artifactId, tabKey);

    // Refresh indicator
    this.notifyIndicator();
  }

  async refresh() {
    this.ensureWebview();
    if (this.webview && this.currentArtifact) {
      console.log('[Artifacts] Refreshing runtime, webview, and version list...');

      const artifact = { ...this.currentArtifact };
      this.showLoading('Checking artifact preview...');
      const result = await window.electronAPI?.artifacts?.refreshRuntime?.({
        artifactId: artifact.artifact_id,
        version: artifact.version,
        previewUrl: artifact.preview_url,
        detached: false,
      });

      if (
        !this.isOpen ||
        this.currentArtifact?.artifact_id !== artifact.artifact_id ||
        this.currentArtifact?.version !== artifact.version
      ) {
        return;
      }

      if (result?.success && result.preview_url) {
        this.currentArtifact.preview_url = result.preview_url;
        this.showLoading(result.restarted ? 'Restarting artifact preview...' : 'Refreshing artifact preview...');
        this.safeLoadWebview(result.preview_url, {
          forceLoad: true,
          bypassCache: true,
        });
      } else if (this.webview) {
        console.error('[Artifacts] Artifact runtime refresh failed:', result?.error || result);
        this.hideLoading();
      }

      // Re-fetch version list from backend
      await this.refreshVersionList();
    }
  }

  async refreshVersionList() {
    if (!this.currentArtifact?.chat_id) return;

    try {
      const list = await window.electronAPI.artifacts.getList(this.currentArtifact.chat_id);
      if (list && list.artifacts) {
        const artifact = list.artifacts.find(a => a.artifact_id === this.currentArtifact.artifact_id);
        if (artifact && artifact.versions) {
          console.log(`[Artifacts] Found ${artifact.versions.length} versions`);
          this.loadVersions(artifact.versions);
        }
      }
    } catch (e) {
      console.error('[Artifacts] Failed to refresh version list:', e);
    }
  }

  async detach() {
    if (!this.currentArtifact) return { success: false, error: 'No artifact' };

    console.log('[Artifacts] Detaching artifact to separate window:', this.currentArtifact.artifact_id);

    // Call IPC to create detached window
    if (window.electronAPI && window.electronAPI.artifacts) {
      const result = await window.electronAPI.artifacts.detach(
        this.currentArtifact.artifact_id,
        this.currentArtifact.preview_url,
        this.currentArtifact.name,
        this.currentArtifact.chat_id,
        this.currentArtifact.version,  // Current version for detached window
        this.currentArtifact.version  // Preferred version for this session
      );

      if (result.success) {
        console.log('[Artifacts] Detached to window:', result.windowId);
        // Close the panel since it's now in a separate window
        this.close();
      } else {
        console.error('[Artifacts] Failed to detach:', result.error);
      }

      return result;
    }

    return { success: false, error: 'No electronAPI' };
  }

  openDetached(data) {
    // For detached mode, just call the IPC directly without opening panel
    if (window.electronAPI && window.electronAPI.artifacts) {
      const preferredVersion = window.artifactIndicator?.getSessionPreferredVersion?.(data.artifact_id);
      window.electronAPI.artifacts.detach(
        data.artifact_id,
        data.preview_url,
        data.name,
        data.chat_id,
        data.version,
        Number.isInteger(preferredVersion) ? preferredVersion : null
      );
    }
  }

  // Safely set webview src, handling cases where webview isn't fully initialized
  safeLoadWebview(url, options = {}) {
    if (!this.webview || !url) return;
    this.activePreviewUrl = url;
    this.usingFallbackPreview = url === this.getFallbackPreviewUrl();
    const state = this.getAttachedState();
    if (state) {
      state.activePreviewUrl = url;
      state.usingFallbackPreview = this.usingFallbackPreview;
      state.hasLoaded = true;
    }

    // Try to stop any current load (may fail if webview not ready - that's OK)
    try {
      if (typeof this.webview.isLoading === 'function' && this.webview.isLoading()) {
        this.webview.stop();
      }
    } catch (e) {
      // Webview not ready for API calls yet - that's fine, we'll set src below
      console.log('[Artifacts] Webview not ready for isLoading check, will set src directly');
    }

    // Always attempt to load the URL
    try {
      if (typeof this.webview.loadURL === 'function') {
        this.webview.loadURL(url, options).catch((e) => {
          if (e?.message && e.message.includes('ERR_ABORTED')) {
            console.log('[Artifacts] Webview load aborted (expected during version switch)');
          } else {
            console.warn('[Artifacts] Webview loadURL failed, falling back to src:', e.message);
            // Fallback to setting src directly
            this.webview.src = url;
          }
        });
      } else {
        this.webview.src = url;
      }
    } catch (e) {
      if (e?.message && e.message.includes('ERR_ABORTED')) {
        console.log('[Artifacts] Webview load aborted (expected during version switch)');
      } else {
        // Last resort: try setting src directly
        console.log('[Artifacts] loadURL threw, falling back to src');
        try {
          this.webview.src = url;
        } catch (srcError) {
          console.error('[Artifacts] Failed to set webview src:', srcError);
        }
      }
    }
  }

  // Show loading overlay (for cold version switches that restore from snapshot)
  showLoading(message = 'Restoring artifact snapshot...') {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.remove('hidden');
      if (this.loadingText) {
        this.loadingText.textContent = message;
      }
      console.log('[Artifacts] Showing loading overlay:', message);
    }
    this.setNativeArtifactViewSuppressed('loading', true);
  }

  // Hide loading overlay
  hideLoading() {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.add('hidden');
    }
    // Reset text to default
    if (this.loadingText) {
      this.loadingText.textContent = 'Restoring artifact snapshot...';
    }
    this.setNativeArtifactViewSuppressed('loading', false);
  }

  // Show preparing state - called BEFORE API call to give immediate feedback
  // This shows the panel with loading overlay while artifact infrastructure is being restored
  showPreparing(artifactName, isDetached = false) {
    console.log('[Artifacts] Showing preparing state for:', artifactName, 'detached:', isDetached);

    this.activeTabKey = this.getActiveTabKey();
    this.chatContainer = getChatContainerForArtifactTab(this.activeTabKey);
    this.moveChromeToActiveWrapper();

    // Set preparing flag
    this.isPreparing = true;

    // Update header with artifact name
    if (this.nameEl) {
      this.nameEl.textContent = artifactName || 'Artifact';
    }

    // Clear version dropdown while preparing
    if (this.versionText) {
      this.versionText.textContent = '...';
    }

    // Show loading with appropriate message
    const message = isDetached
      ? `Opening ${artifactName || 'artifact'} in new window...`
      : `Restoring ${artifactName || 'artifact'}...`;
    this.showLoading(message);

    // Show the panel (so user can see the loading state)
    if (this.panel) {
      this.panel.classList.remove('hidden');
    }

    // Shrink chat container to make room for panel
    if (this.chatContainer && !this.chatContainer.classList.contains('with-artifact-panel')) {
      this.chatContainer.classList.add('with-artifact-panel');
      // Set initial width
      artifactDividerDragState.ratio = 0.5;
      void this.setArtifactLayoutActive(true);
      this.applyActiveTabWidth({ resetToHalf: true });
      window.requestAnimationFrame?.(() => this.applyActiveTabWidth({ resetToHalf: true }));
    }
  }

  // Cancel preparing state (called on error or when detached window opens)
  cancelPreparing() {
    if (!this.isPreparing) return;

    console.log('[Artifacts] Cancelling preparing state');
    this.isPreparing = false;
    this.hideLoading();

    // If we were just preparing (no actual artifact loaded), hide the panel
    if (!this.currentArtifact) {
      if (this.panel) {
        this.panel.classList.add('hidden');
      }
      if (this.chatContainer) {
        this.chatContainer.classList.remove('with-artifact-panel');
        this.chatContainer.style.removeProperty('--artifact-chat-width');
      }
      void this.setArtifactLayoutActive(false);
    }
  }

  async switchVersion(version, options = {}) {
    if (!this.currentArtifact) return;

    // Don't switch if already on this version
    if (this.currentArtifact.version === version) {
      console.log(`[Artifacts] Already on version ${version}`);
      const versionPreviewUrl = this.getVersionPreviewUrl(version);
      if (versionPreviewUrl && this.currentArtifact.preview_url !== versionPreviewUrl) {
        this.currentArtifact.preview_url = versionPreviewUrl;
        this.ensureWebview();
        this.safeLoadWebview(versionPreviewUrl, {
          forceLoad: true,
          bypassCache: true,
        });
        this.saveCurrentTabRuntimeState();
      }
      return;
    }

    console.log(`[Artifacts] Switching to version ${version}...`);

    // Check if version is not currently running - will need cold restore
    const versionInfo = this.runningVersions.get(version);
    const isColdSwitch = !versionInfo || !versionInfo.isRunning;

    // Show loading overlay for cold switches (restoring from snapshot takes time)
    if (isColdSwitch) {
      this.showLoading();
    }

    try {
      // Call backend to switch version (hot or cold)
      const result = await window.electronAPI.artifacts.switchVersion(
        this.currentArtifact.artifact_id,
        version
      );

      if (result.success) {
        // Log whether this was a hot or cold switch
        if (result.from_pool) {
          console.log(`[Artifacts] HOT switch to version ${version} (already running)`);
          // Hide loading immediately for hot switches (content available right away)
          this.hideLoading();
        } else {
          console.log(`[Artifacts] COLD switch to version ${version} (restored from snapshot)`);
          if (result.evicted_version) {
            console.log(`[Artifacts] Evicted version ${result.evicted_version} from pool`);
          }
          // Loading overlay stays visible until webview fires did-finish-load
        }

        this.currentArtifact.version = version;

        // Update dropdown display immediately
        this.renderVersionMenu();
        this.updateVersionDisplay();

        this.ensureWebview();
        // Load explicit version switches from immutable snapshot-backed preview URLs.
        const versionLoadOptions = { forceLoad: true, bypassCache: true };
        const versionPreviewUrl = this.getVersionPreviewUrl(version);
        const livePreviewUrl = result.preview_url || (result.host_port ? `http://localhost:${result.host_port}` : null);
        const nextPreviewUrl = versionPreviewUrl || livePreviewUrl;
        if (nextPreviewUrl) {
          this.currentArtifact.preview_url = nextPreviewUrl;
          this.safeLoadWebview(nextPreviewUrl, versionLoadOptions);
        }

        if (options.userInitiated && window.artifactIndicator?.setSessionPreferredVersion) {
          window.artifactIndicator.setSessionPreferredVersion(
            this.currentArtifact.artifact_id,
            version
          );
        }

        // Refresh running versions after switch
        await this.fetchRunningVersions();
        this.saveCurrentTabRuntimeState();
      } else {
        console.error('[Artifacts] Failed to switch version:', result.error);
        // Hide loading on error
        this.hideLoading();
      }
    } catch (e) {
      console.error('[Artifacts] Error switching version:', e);
      // Hide loading on error
      this.hideLoading();
    }
  }

  async updateVersion(version, previewUrl, hostPort = null) {
    if (!this.currentArtifact) return;

    this.currentArtifact.version = version;

    const versionPreviewUrl = this.getVersionPreviewUrl(version);
    if (versionPreviewUrl) {
      this.currentArtifact.preview_url = versionPreviewUrl;
    } else if (previewUrl) {
      this.currentArtifact.preview_url = previewUrl;
    } else if (hostPort) {
      this.currentArtifact.preview_url = `http://localhost:${hostPort}`;
    }

    // Reload webview with new URL
    if (this.currentArtifact.preview_url) {
      this.ensureWebview();
      this.safeLoadWebview(this.currentArtifact.preview_url, {
        forceLoad: true,
        bypassCache: true,
      });
    }

    // Refresh version list to get proper version notes from backend
    // This replaces manual option adding and ensures version_note is displayed
    await this.refreshVersionList();

    // Refresh running versions to update indicators
    await this.fetchRunningVersions();
    this.saveCurrentTabRuntimeState();
  }

  // Load versions from artifact data
  loadVersions(versions) {
    if (!versions) return;

    // Sort versions descending (newest first)
    this.versions = [...versions].sort((a, b) => b.version - a.version);

    // Render the dropdown menu
    this.renderVersionMenu();

    // Update the trigger button text to show current version
    this.updateVersionDisplay();
  }

  // Update the version dropdown trigger (indicator + text)
  updateVersionDisplay() {
    if (!this.currentArtifact) return;

    const currentVersion = this.versions.find(v => v.version === this.currentArtifact.version);
    const info = this.runningVersions.get(this.currentArtifact.version);

    // The current version is ALWAYS running since we're displaying it in the webview
    // Health check failures for pool versions shouldn't affect the currently displayed version
    const isCurrentRunning = true;  // If we're showing this version, it's running
    console.log('[Artifacts] updateVersionDisplay - currentArtifact.version:', this.currentArtifact.version,
      'type:', typeof this.currentArtifact.version,
      'info:', info,
      'isCurrentRunning:', isCurrentRunning,
      'runningVersions keys:', [...this.runningVersions.keys()]);

    // Update the indicator element (styled separately from text)
    if (this.versionTriggerIndicator) {
      this.versionTriggerIndicator.classList.toggle('running', isCurrentRunning);
    }

    // Update the text (without indicator - it's in a separate element now)
    if (this.versionText) {
      if (currentVersion) {
        const fullVersionLabel = currentVersion.version_note
          ? `v${currentVersion.version} - ${currentVersion.version_note}`
          : `v${currentVersion.version}`;
        this.versionText.textContent = `v${currentVersion.version}`;
        this.versionTrigger?.setAttribute('aria-label', `Select version: ${fullVersionLabel}`);
        this.versionTrigger?.setAttribute('title', fullVersionLabel);
      } else {
        this.versionText.textContent = `v${this.currentArtifact.version}`;
        this.versionTrigger?.setAttribute(
          'aria-label',
          `Select version: v${this.currentArtifact.version}`,
        );
        this.versionTrigger?.setAttribute('title', `v${this.currentArtifact.version}`);
      }
    }
  }

  // Get version label with indicator
  getVersionLabel(version, versionNote = null) {
    const info = this.runningVersions.get(version);
    const indicator = info?.isRunning ? '\u25CF ' : '';  // Filled circle for running, nothing for stopped

    if (versionNote) {
      return `${indicator}v${version} - ${versionNote}`;
    }
    return `${indicator}v${version}`;
  }
}

// Initialize when DOM is ready
let artifactPanel = null;

function initArtifactPanel() {
  if (!artifactPanel) {
    artifactPanel = new ArtifactPanel();
    window.artifactPanel = artifactPanel;
    console.log('[Artifacts] Panel initialized');
  }
  return artifactPanel;
}

// Auto-init after short delay to ensure DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initArtifactPanel, 200);
});

window.initArtifactPanel = initArtifactPanel;
