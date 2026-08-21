/**
 * Find-in-Page Controller
 *
 * PORTICO PATCH: Browser-style shell-owned controller for quick text search
 * within the current conversation using Chromium's native findInPage, while
 * the visible overlay lives in a dedicated native child window above OWUI.
 *
 * Architecture layers: Electron Shell, IPC/Communication, Chat UI
 */

const FIND_BAR_DEFAULT_WIDTH = 408;
const FIND_BAR_MIN_WIDTH = 252;
const FIND_BAR_HEIGHT = 52;
const FIND_BAR_MARGIN = 12;
const FIND_BAR_GAP = 10;
const OWUI_LOCAL_FIND_ACTIVE_DATASET_KEY = 'porticoLocalFindActive';
const OWUI_LOCAL_FIND_VISIBILITY_EVENT = 'portico-local-find-visibility-changed';
const OWUI_LOCAL_FIND_HISTORY_REQUEST_EVENT = 'portico-local-find-history-request';
const OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT = 'portico-local-find-history-response';
const FIND_BAR_FOCUS_SUPPRESSION_REASON = 'find-bar';

class FindBar {
  constructor() {
    this.sessions = new Map();
    this.currentViewKey = null;
    this.visible = false;
    this.query = '';
    this.caseSensitive = false;
    this.activeMatch = 0;
    this.totalMatches = 0;
    this.retainFocus = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.debounceTimer = null;
    this.layoutFrame = null;
    this.layoutRequestId = 0;
    this.historyRequestSequence = 0;
    this.overlayBounds = null;
    this.overlayRevision = 0;

    this._boundOnFindResult = this._onFindResult.bind(this);
    this._boundOnFindInPageOpen = () => {
      this._syncToActiveView({ reapplyFind: false });
      this.showFresh();
    };
    this._boundOnFindInPageNext = () => {
      if (!this.visible) {
        return;
      }
      this._syncToActiveView({ reapplyFind: false });
      if (this.query) {
        void this.findNext();
      }
    };
    this._boundOnFindInPagePrev = () => {
      if (!this.visible) {
        return;
      }
      this._syncToActiveView({ reapplyFind: false });
      if (this.query) {
        void this.findPrev();
      }
    };
    this._boundOnResize = () => this._scheduleLayout();
    this._boundOnThemeChanged = () => {
      if (this.visible) {
        void this._syncOverlayWindow();
      }
    };
    this._boundOnWindowFocus = () => {
      if (this.visible && this.retainFocus) {
        void this._syncOverlayWindow();
      }
    };
    this._boundOnOwnerPointerDown = () => {
      if (!this.visible) {
        return;
      }
      // Browser contract: any click outside the find surface dismisses it.
      this.hide('outside-pointerdown');
    };
    this._boundOnOverlayEvent = (payload) => this._handleOverlayEvent(payload);

    this._init();
  }

  _init() {
    this._bindEvents();
    this._wrapSwitchTab();
    this._syncToActiveView();
  }

  _bindEvents() {
    if (window.electronAPI?.onFindInPageResult) {
      window.electronAPI.onFindInPageResult(this._boundOnFindResult);
    }

    if (window.electronAPI?.onFindInPageOpen) {
      window.electronAPI.onFindInPageOpen(this._boundOnFindInPageOpen);
    }

    if (window.electronAPI?.onFindInPageNext) {
      window.electronAPI.onFindInPageNext(this._boundOnFindInPageNext);
    }

    if (window.electronAPI?.onFindInPagePrev) {
      window.electronAPI.onFindInPagePrev(this._boundOnFindInPagePrev);
    }

    if (window.electronAPI?.localFindOverlay?.onEvent) {
      window.electronAPI.localFindOverlay.onEvent(this._boundOnOverlayEvent);
    }

    if (window.electronAPI?.onThemeChanged) {
      window.electronAPI.onThemeChanged(this._boundOnThemeChanged);
    }

    window.addEventListener('resize', this._boundOnResize);
    window.visualViewport?.addEventListener('resize', this._boundOnResize);
    window.addEventListener('focus', this._boundOnWindowFocus);
    document.addEventListener('pointerdown', this._boundOnOwnerPointerDown, true);
  }

  _createEmptySession() {
    return {
      visible: false,
      activeMatch: 0,
      totalMatches: 0,
      retainFocus: false,
    };
  }

  _getSession(viewKey) {
    if (!viewKey) {
      return this._createEmptySession();
    }

    if (!this.sessions.has(viewKey)) {
      this.sessions.set(viewKey, this._createEmptySession());
    }

    return this.sessions.get(viewKey);
  }

  _storeStateForView(viewKey) {
    if (!viewKey) {
      return;
    }

    const session = this._getSession(viewKey);
    session.visible = this.visible;
    session.activeMatch = this.activeMatch;
    session.totalMatches = this.totalMatches;
    session.retainFocus = this.retainFocus;
  }

  _loadStateFromSession(viewKey) {
    const session = this._getSession(viewKey);
    this.visible = session.visible === true;
    this.activeMatch = Math.max(0, Number(session.activeMatch) || 0);
    this.totalMatches = Math.max(0, Number(session.totalMatches) || 0);
    this.retainFocus = session.retainFocus === true;
  }

  _clearSession(viewKey) {
    if (!viewKey) {
      return;
    }

    const session = this._getSession(viewKey);
    session.visible = false;
    session.activeMatch = 0;
    session.totalMatches = 0;
    session.retainFocus = false;
  }

  _wrapSwitchTab() {
    if (typeof window.switchTab !== 'function' || window.switchTab.__findBarWrapped === true) {
      return;
    }

    const originalSwitchTab = window.switchTab;
    const wrappedSwitchTab = (...args) => {
      if (this.visible) {
        // Browser-like contract: leaving the active tab should dismiss local find.
        this.hide('tab-switch');
      } else {
        const previousViewKey = this.currentViewKey || this._resolveActiveViewKey();
        if (previousViewKey) {
          void this._publishVisibilityToView(previousViewKey, false);
        }
      }

      const result = originalSwitchTab.apply(window, args);
      this._syncToActiveView();
      return result;
    };

    wrappedSwitchTab.__findBarWrapped = true;
    window.switchTab = wrappedSwitchTab;
  }

  _resolveAnchorHost() {
    return (
      document.querySelector('.tab-content.active .chat-container') ||
      document.getElementById('conversation-chat-container') ||
      document.getElementById('chat-container') ||
      document.body
    );
  }

  _resolveActiveWebviewHost() {
    const activeContainer = document.querySelector('.tab-content.active');
    if (activeContainer) {
      const activeHost = activeContainer.querySelector('.chat-webview[data-owui-host="true"]');
      if (activeHost) {
        return activeHost;
      }
    }

    return (
      document.querySelector('#conversation-chat-container .chat-webview[data-owui-host="true"]') ||
      document.querySelector('#chat-container .chat-webview[data-owui-host="true"]') ||
      document.querySelector('.chat-webview[data-owui-host="true"]')
    );
  }

  _resolveActiveViewKey() {
    return this._resolveActiveWebviewHost()?.dataset?.owuiViewKey || null;
  }

  _syncToActiveView(options = {}) {
    const { reapplyFind = true } = options;
    const nextViewKey = this._resolveActiveViewKey();
    if (!nextViewKey) {
      if (this.visible) {
        this.hide('no-active-view');
      }
      this.currentViewKey = null;
      this.visible = false;
      this.retainFocus = false;
      this.overlayBounds = null;
      this._syncOwuiFocusSuppression();
      void this._syncOverlayWindow({ reason: 'no-active-view' });
      return false;
    }

    if (this.visible && this.currentViewKey && this.currentViewKey !== nextViewKey) {
      this.hide('view-switch');
    }

    if (this.currentViewKey !== nextViewKey) {
      this.currentViewKey = nextViewKey;
      this._loadStateFromSession(nextViewKey);
    }

    this._syncOwuiFocusSuppression();

    if (this.visible) {
      void this._publishVisibilityToView(nextViewKey, true);
      this._scheduleLayout();
      if (this.query && reapplyFind && window.electronAPI?.owuiFindInPage) {
        void window.electronAPI.owuiFindInPage(this.query, {
          matchCase: this.caseSensitive,
          findNext: true,
        });
      }
    } else {
      void this._syncOverlayWindow({ reason: 'hidden' });
    }

    return true;
  }

  _syncOwuiFocusSuppression() {
    window.setOwuiFocusSuppressed?.(
      FIND_BAR_FOCUS_SUPPRESSION_REASON,
      this.visible && this.retainFocus,
    );
  }

  _setRetainFocus(nextValue) {
    this.retainFocus = nextValue === true;
    this._updateCurrentSession();
    this._syncOwuiFocusSuppression();
  }

  _updateCurrentSession() {
    this._storeStateForView(this.currentViewKey);
  }

  _rememberSelection(selectionStart = null, selectionEnd = null) {
    const valueLength = this.query.length;
    const nextStart = Number.isFinite(Number(selectionStart))
      ? Math.max(0, Math.min(valueLength, Number(selectionStart)))
      : valueLength;
    const nextEnd = Number.isFinite(Number(selectionEnd))
      ? Math.max(nextStart, Math.min(valueLength, Number(selectionEnd)))
      : nextStart;

    this.selectionStart = nextStart;
    this.selectionEnd = nextEnd;
    this._updateCurrentSession();
  }

  _handleOverlayEvent(payload = {}) {
    const type = payload?.type;
    const handledInMain = payload?.handledInMain === true;
    if (!type) {
      return;
    }

    switch (type) {
      case 'query-change':
        this.query = typeof payload.query === 'string' ? payload.query : '';
        this.activeMatch = 0;
        this.totalMatches = 0;
        this._rememberSelection(payload.selectionStart, payload.selectionEnd);
        this._setRetainFocus(true);
        if (!handledInMain) {
          this._debouncedFind();
        }
        break;
      case 'selection-change':
        this._rememberSelection(payload.selectionStart, payload.selectionEnd);
        break;
      case 'focus':
        this._setRetainFocus(true);
        break;
      case 'release-focus':
        this._setRetainFocus(false);
        break;
      case 'toggle-case':
        this.caseSensitive = !this.caseSensitive;
        this.activeMatch = 0;
        this.totalMatches = 0;
        this._setRetainFocus(true);
        if (!handledInMain) {
          this._executeFind();
        }
        break;
      case 'next':
        this._setRetainFocus(true);
        if (!handledInMain) {
          void this.findNext();
        }
        break;
      case 'prev':
        this._setRetainFocus(true);
        if (!handledInMain) {
          void this.findPrev();
        }
        break;
      case 'close':
        this.hide(payload.reason || 'dismiss');
        break;
    }
  }

  _debouncedFind() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this._executeFind();
    }, 150);
  }

  async _executeFind() {
    if (!this._syncToActiveView({ reapplyFind: false })) {
      return;
    }

    if (!this.query) {
      this._stopFind();
      return;
    }

    await this._requestHiddenHistoryExpansion('forward');

    if (window.electronAPI?.owuiFindInPage) {
      void window.electronAPI.owuiFindInPage(this.query, {
        matchCase: this.caseSensitive,
        findNext: true,
      });
    }
  }

  _stopFind(action = 'clearSelection') {
    this.activeMatch = 0;
    this.totalMatches = 0;
    this._updateCurrentSession();

    if (window.electronAPI?.owuiStopFindInPage) {
      void window.electronAPI.owuiStopFindInPage(action);
    }
  }

  _issueMatchNavigation(forward) {
    if (!this.query || !window.electronAPI?.owuiFindInPage) {
      return Promise.resolve();
    }

    return window.electronAPI.owuiFindInPage(this.query, {
      matchCase: this.caseSensitive,
      forward,
      findNext: false,
    });
  }

  async findNext() {
    if (!this.query) {
      return;
    }

    this._setRetainFocus(true);
    await this._requestHiddenHistoryExpansion('forward');
    await this._issueMatchNavigation(true);
  }

  async findPrev() {
    if (!this.query) {
      return;
    }

    this._setRetainFocus(true);
    await this._requestHiddenHistoryExpansion('backward');
    await this._issueMatchNavigation(false);
  }

  async _executeInView(viewKey, script) {
    if (!viewKey || !window.electronAPI?.owui?.executeJavaScript) {
      return null;
    }

    try {
      return await window.electronAPI.owui.executeJavaScript(viewKey, script);
    } catch (_error) {
      return null;
    }
  }

  _publishVisibilityToView(viewKey, active) {
    const script = `(() => {
      const root = document.documentElement;
      if (root?.dataset) {
        if (${active ? 'true' : 'false'}) {
          root.dataset[${JSON.stringify(OWUI_LOCAL_FIND_ACTIVE_DATASET_KEY)}] = 'true';
        } else {
          delete root.dataset[${JSON.stringify(OWUI_LOCAL_FIND_ACTIVE_DATASET_KEY)}];
        }
      }

      window.dispatchEvent(
        new CustomEvent(${JSON.stringify(OWUI_LOCAL_FIND_VISIBILITY_EVENT)}, {
          detail: { active: ${active ? 'true' : 'false'} },
        }),
      );

      return true;
    })()`;

    return this._executeInView(viewKey, script);
  }

  async _requestHiddenHistoryExpansion(direction) {
    if (!this.query || !this.currentViewKey) {
      return false;
    }

    this.historyRequestSequence += 1;
    const detail = {
      requestId: `shell-find-${Date.now()}-${this.historyRequestSequence}`,
      query: this.query,
      caseSensitive: this.caseSensitive,
      direction,
    };

    const script = `(() => new Promise((resolve) => {
      const detail = ${JSON.stringify(detail)};
      let settled = false;
      let safetyTimer = null;

      const cleanup = () => {
        if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
        window.removeEventListener(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT)}, onResponse);
      };

      const onResponse = (event) => {
        if ((event?.detail?.requestId || '') !== detail.requestId) {
          return;
        }
        settled = true;
        cleanup();
        resolve(Boolean(event?.detail?.expanded));
      };

      window.addEventListener(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_RESPONSE_EVENT)}, onResponse);
      window.dispatchEvent(
        new CustomEvent(${JSON.stringify(OWUI_LOCAL_FIND_HISTORY_REQUEST_EVENT)}, {
          detail,
        }),
      );

      if (!settled) {
        safetyTimer = setTimeout(() => {
          safetyTimer = null;
          if (settled) {
            return;
          }
          cleanup();
          resolve(false);
        }, 5000);
      }
    }))()`;

    const expanded = await this._executeInView(this.currentViewKey, script);
    return expanded === true;
  }

  _scheduleLayout() {
    if (!this.visible) {
      return;
    }

    if (this.layoutFrame) {
      window.cancelAnimationFrame(this.layoutFrame);
    }

    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = null;
      void this._applyLayout();
    });
  }

  async _fetchLayoutMetrics(viewKey) {
    const script = `(() => {
      const toRect = (rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });

      const isVisibleElement = (element) => {
        if (!element || !element.isConnected) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const toolbar = document.querySelector('nav.drag-region');
      const anchorRects = [
        document.getElementById('temporary-chat-button'),
        document.getElementById('save-temporary-chat-button'),
        document.getElementById('chat-context-menu-button'),
      ]
        .filter((element) => isVisibleElement(element))
        .map((element) => toRect(element.getBoundingClientRect()))
        .sort((a, b) => a.left - b.left);

      return {
        viewportWidth: Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0),
        viewportHeight: Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0),
        toolbarRect: isVisibleElement(toolbar) ? toRect(toolbar.getBoundingClientRect()) : null,
        anchorRects,
      };
    })()`;

    return this._executeInView(viewKey, script);
  }

  _buildOverlayState(bounds = this.overlayBounds, override = {}) {
    this.overlayRevision += 1;
    return {
      revision: this.overlayRevision,
      visible: this.visible,
      query: this.query,
      caseSensitive: this.caseSensitive,
      activeMatch: this.activeMatch,
      totalMatches: this.totalMatches,
      retainFocus: this.visible && this.retainFocus,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
      theme: document.documentElement?.getAttribute('data-theme') || 'dark',
      bounds,
      ...override,
    };
  }

  async _syncOverlayWindow(override = {}) {
    if (!window.electronAPI?.localFindOverlay?.sync) {
      return null;
    }

    const nextBounds = override.bounds ?? this.overlayBounds;
    if (this.visible && !nextBounds) {
      return null;
    }

    const payload = this.visible
      ? this._buildOverlayState(nextBounds, override)
      : {
          visible: false,
          retainFocus: false,
          reason: override.reason || 'hidden',
        };

    try {
      return await window.electronAPI.localFindOverlay.sync(payload);
    } catch (_error) {
      return null;
    }
  }

  async _applyLayout() {
    if (!this.visible) {
      return;
    }

    const viewKey = this.currentViewKey || this._resolveActiveViewKey();
    if (!viewKey) {
      return;
    }

    const anchorHost = this._resolveAnchorHost();
    if (!anchorHost) {
      return;
    }

    const requestId = ++this.layoutRequestId;
    const metrics = await this._fetchLayoutMetrics(viewKey);
    if (requestId !== this.layoutRequestId || !this.visible) {
      return;
    }

    const hostRect = anchorHost.getBoundingClientRect();
    const viewportWidth = Math.max(0, Math.round(hostRect.width || 0));
    const viewportHeight = Math.max(0, Math.round(hostRect.height || 0));
    const anchorRects = Array.isArray(metrics?.anchorRects) ? metrics.anchorRects : [];
    const toolbarRect = metrics?.toolbarRect || null;
    const barHeight = FIND_BAR_HEIGHT;

    let width = Math.min(
      FIND_BAR_DEFAULT_WIDTH,
      Math.max(220, viewportWidth - FIND_BAR_MARGIN * 2),
    );
    let left = Math.max(FIND_BAR_MARGIN, viewportWidth - width - FIND_BAR_MARGIN);
    let top = toolbarRect
      ? Math.max(FIND_BAR_MARGIN, Math.round(toolbarRect.top + 8))
      : FIND_BAR_MARGIN;

    if (anchorRects.length > 0) {
      const leftmostRect = anchorRects[0];
      const availableLeftWidth = Math.max(
        0,
        Math.floor(leftmostRect.left - FIND_BAR_MARGIN - FIND_BAR_GAP),
      );

      if (availableLeftWidth >= FIND_BAR_MIN_WIDTH) {
        width = Math.min(FIND_BAR_DEFAULT_WIDTH, availableLeftWidth);
        left = Math.max(
          FIND_BAR_MARGIN,
          Math.round(leftmostRect.left - width - FIND_BAR_GAP),
        );
        top = Math.max(
          FIND_BAR_MARGIN,
          Math.round(leftmostRect.top + (leftmostRect.height - barHeight) / 2),
        );
      } else {
        width = Math.min(
          FIND_BAR_DEFAULT_WIDTH,
          Math.max(220, viewportWidth - FIND_BAR_MARGIN * 2),
        );
        left = Math.max(FIND_BAR_MARGIN, viewportWidth - width - FIND_BAR_MARGIN);
        top = Math.max(top, Math.round(leftmostRect.bottom + 8));
      }
    }

    top = Math.min(
      top,
      Math.max(FIND_BAR_MARGIN, viewportHeight - barHeight - FIND_BAR_MARGIN),
    );

    this.overlayBounds = {
      x: Math.max(0, Math.round(hostRect.left + left)),
      y: Math.max(
        Math.round((document.querySelector('.tab-bar-container')?.getBoundingClientRect().bottom || 0) + 6),
        Math.round(hostRect.top + top),
      ),
      width: Math.round(width),
      height: FIND_BAR_HEIGHT,
    };

    await this._syncOverlayWindow({ bounds: this.overlayBounds });
  }

  _onFindResult(result) {
    if (!result) {
      return;
    }

    this.activeMatch = Math.max(0, Number(result.activeMatchOrdinal) || 0);
    this.totalMatches = Math.max(0, Number(result.matches) || 0);
    this._updateCurrentSession();

    if (this.visible) {
      void this._syncOverlayWindow();
    }
  }

  showFresh() {
    if (!this._syncToActiveView()) {
      return;
    }

    this.visible = true;
    this.activeMatch = 0;
    this.totalMatches = 0;
    this.selectionStart = 0;
    this.selectionEnd = this.query.length;
    this.overlayBounds = null;
    this._setRetainFocus(true);
    this._updateCurrentSession();
    void this._publishVisibilityToView(this.currentViewKey, true);
    if (this.query) {
      this._executeFind();
    } else {
      this._stopFind();
    }
    this._scheduleLayout();
  }

  hide(reason = 'dismiss') {
    const closingViewKey = this.currentViewKey || this._resolveActiveViewKey();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.layoutFrame) {
      window.cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = null;
    }

    this._stopFind();
    this._clearSession(closingViewKey);
    this.visible = false;
    this.activeMatch = 0;
    this.totalMatches = 0;
    this.retainFocus = false;
    this.overlayBounds = null;
    this._syncOwuiFocusSuppression();
    void this._publishVisibilityToView(closingViewKey, false);
    void this._syncOverlayWindow({ reason });
  }
}

if (typeof window !== 'undefined') {
  window.__findBar = new FindBar();
}
