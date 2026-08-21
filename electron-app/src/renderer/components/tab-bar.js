/**
 * Browser-style Tab Bar
 *
 * PORTICO PATCH: Manages the tab strip in the main window header. Handles tab
 * creation/removal, scroll overflow, drag-to-reorder, right-click context
 * menu, inline rename, and middle-click close.
 *
 * Architecture layers: Electron Shell, Chat UI
 */

(function () {
  'use strict';

  const PERMANENT_TABS = new Set(['chat']);
  const RENAMEABLE_PERMANENT_TABS = new Set(['chat']);
  const MAX_VISIBLE_TABS = 5;
  const NEW_TAB_TITLE = 'New chat (⌘N)';
  const TAB_LIMIT_MESSAGE = 'Maximum tabs reached.';
  const SCROLL_STEP = 200;
  const TAB_BUSY_BLOCK_DURATION_MS = 1050;
  const TAB_RAIL_CHROME_GAP_PX = 8;
  const TAB_RAIL_MIN_WIDTH_PX = 64;
  const COMPACT_TAB_WIDTH_PX = 34;
  const TAB_STRIP_GAP_PX = 2;
  const COMPACT_CLOSE_REPLACE_THRESHOLD_PX = 64;

  const CHAT_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  const SUBAGENT_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"></rect><path d="M12 7V4"></path><circle cx="9" cy="13" r="1"></circle><circle cx="15" cy="13" r="1"></circle><path d="M9 17h6"></path></svg>`;
  const TAB_BUSY_BLOCKS_HTML = `<span class="tab-busy-blocks" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;
  const CLOSE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  // Model-logo tab icons: the last responding model's brand mark replaces the
  // generic chat bubble (agent chats stack the PORTICO logo over the base-model
  // logo). Mirrors chat-native-notifications.js resolveModelIconKey.
  const TAB_MODEL_ICON_ASSETS = {
    sol: '../assets/sol.png',
    terra: '../assets/terra.png',
    luna: '../assets/luna.png',
    claude: '../assets/claude.png',
    gemini: '../assets/gemini.png',
    gpt: '../assets/gpt.png',
  };
  const TAB_portico_ICON_SRC = '../assets/icon_raw.png';

  function normalizeTabModelRoute(value) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/:latest$/i, '');
    const routedId = normalized.split('/').filter(Boolean).at(-1) || '';
    return routedId.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  }

  function resolveTabModelIconKey(modelIdentity) {
    const identity = modelIdentity && typeof modelIdentity === 'object' ? modelIdentity : null;
    if (!identity) return null;
    const hasBaseModel = Boolean(identity.baseModelId);
    const values = (hasBaseModel
      ? [identity.baseModelId, identity.baseModelName, identity.baseModelOwnedBy]
      : [identity.id, identity.name, identity.ownedBy]
    ).filter(Boolean).map((v) => String(v));
    const haystack = values.join(' ').toLowerCase();
    if (!haystack) return null;
    if (/(?:^|[\s/_-])(local|ollama|lm[\s_-]?studio)(?:$|[\s/_-])/.test(haystack)) return null;
    const routes = values.map(normalizeTabModelRoute);
    if (routes.includes('gpt-5.6-sol') || routes.includes('gpt-5.6-sol-pro')) return 'sol';
    if (routes.includes('gpt-5.6-terra')) return 'terra';
    if (routes.includes('gpt-5.6-luna')) return 'luna';
    if (/\b(?:claude|anthropic)\b/.test(haystack)) return 'claude';
    if (/\b(?:gemini|google|vertex(?:[\s_-]?ai)?)\b/.test(haystack)) return 'gemini';
    if (
      /\b(?:openai|chatgpt|gpt)[\w.-]*\b/.test(haystack) ||
      /(?:^|[\s/_-])o[134](?:$|[\s/_-])/.test(haystack)
    ) {
      return 'gpt';
    }
    return null;
  }

  // The icon fragment for a tab: model logo, PORTICO+base stacked pair for agent
  // chats, or the generic chat/subagent SVG when no model is known.
  function tabIconMarkup(modelIdentity, type) {
    const isAgentChat = Boolean(modelIdentity?.baseModelId);
    const key = resolveTabModelIconKey(modelIdentity);
    // gpt.png is a white glyph on transparency — every other surface badges it
    // on a dark chip in light mode (modelBranding.ts parity); so do we.
    const badged = key === 'gpt' ? ' tab-model-logo--badged' : '';
    if (isAgentChat) {
      const baseSrc = key ? TAB_MODEL_ICON_ASSETS[key] : null;
      if (baseSrc) {
        return `<span class="tab-icon-stack"><img class="tab-icon-stack-base${badged}" src="${baseSrc}" alt="" draggable="false"/><img class="tab-icon-stack-front" src="${TAB_portico_ICON_SRC}" alt="" draggable="false"/></span>`;
      }
      return `<img class="tab-model-logo" src="${TAB_portico_ICON_SRC}" alt="" draggable="false"/>`;
    }
    if (key) {
      return `<img class="tab-model-logo${badged}" src="${TAB_MODEL_ICON_ASSETS[key]}" alt="" draggable="false"/>`;
    }
    return type === 'subagent' ? SUBAGENT_ICON_SVG : CHAT_ICON_SVG;
  }

  let strip = null;
  let newTabBtn = null;
  let scrollLeftBtn = null;
  let scrollRightBtn = null;
  let dragSourceId = null;
  let dragDropHandled = false;
  let dragDetachCandidate = false;
  let dragLastPointer = null;
  let dropIndicator = null;
  let tabRailResizeObserver = null;
  let tabRailMutationObserver = null;
  let tabRailLayoutFrame = 0;
  let tabRailMaxWidth = 0;
  let suppressTabRailMutationSync = false;
  const TAB_RENAME_FOCUS_SUPPRESSION_REASON = 'tab-rename';
  const TAB_RENAME_ACTIVE_CLASS = 'tab-rename-active';

  function init() {
    strip = document.getElementById('tab-strip');
    if (!strip) return;

    scrollLeftBtn = document.querySelector('.tab-scroll-left');
    scrollRightBtn = document.querySelector('.tab-scroll-right');

    newTabBtn = document.getElementById('new-tab-btn');
    if (newTabBtn) {
      newTabBtn.addEventListener('click', () => {
        if (newTabBtn.getAttribute('aria-disabled') === 'true') {
          return;
        }
        if (window.openNewChatTab) window.openNewChatTab();
      });
    }

    if (scrollLeftBtn) {
      scrollLeftBtn.addEventListener('click', () => {
        strip.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' });
      });
    }
    if (scrollRightBtn) {
      scrollRightBtn.addEventListener('click', () => {
        strip.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' });
      });
    }

    strip.addEventListener('scroll', syncScrollButtons);
    new ResizeObserver(syncScrollButtons).observe(strip);
    setupTabRailLayoutSync();

    strip.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        return;
      }

      if (strip.scrollWidth <= strip.clientWidth + 1) {
        return;
      }

      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      if (absX < 0.01 && absY < 0.01) {
        return;
      }

      // Let native horizontal touchpad inertia drive tab scrolling.
      if (absX > absY) {
        return;
      }

      // Map vertical wheel gestures to horizontal tab-strip movement.
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });

    createDropIndicator();

    strip.addEventListener('dragover', onStripDragOver);
    strip.addEventListener('drop', onStripDrop);
    strip.addEventListener('dragend', onDragEnd);

    document.addEventListener('dragover', onDocumentDragOver);
    document.addEventListener('pointerdown', commitActiveRenameInputFromOutsidePointer, true);
    document.addEventListener('mousedown', commitActiveRenameInputFromOutsidePointer, true);
    document.addEventListener('focus', commitActiveRenameInputFromOwuiFocus, true);

    if (window.electronAPI?.onTabContextMenuCommand) {
      window.electronAPI.onTabContextMenuCommand((payload) => {
        handleContextMenuAction(payload?.action, payload?.fullTabId);
      });
    }

    for (const btn of strip.querySelectorAll('.tab-btn')) {
      ensureStatusIndicator(btn);
      syncTabTitleAttributes(btn);
      attachTabButtonListeners(btn, btn.dataset.tab);
    }

    syncNewTabButtonState();
    requestTabRailLayoutSync();
  }

  function setupTabRailLayoutSync() {
    const rail = strip?.closest('.tab-bar-container');
    const header = document.querySelector('.header');
    const headerContent = document.querySelector('.header-content');
    const headerLeft = document.querySelector('.header-left');
    const headerActions = document.querySelector('.header-actions');

    if (!rail || !header || !headerContent) {
      return;
    }

    tabRailResizeObserver?.disconnect?.();
    tabRailMutationObserver?.disconnect?.();

    if (typeof ResizeObserver === 'function') {
      tabRailResizeObserver = new ResizeObserver(requestTabRailLayoutSync);
      for (const element of [header, headerContent, headerLeft, headerActions, rail, strip]) {
        if (element) {
          tabRailResizeObserver.observe(element);
        }
      }
    }

    if (typeof MutationObserver === 'function') {
      tabRailMutationObserver = new MutationObserver(() => {
        if (!suppressTabRailMutationSync) {
          requestTabRailLayoutSync();
        }
      });
      tabRailMutationObserver.observe(strip, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'title', 'aria-label'],
      });
      if (document.body) {
        tabRailMutationObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }
    }

    window.addEventListener('resize', requestTabRailLayoutSync);
    window.visualViewport?.addEventListener('resize', requestTabRailLayoutSync);
    requestTabRailLayoutSync();
  }

  function requestTabRailLayoutSync() {
    if (tabRailLayoutFrame) {
      return;
    }

    const sync = () => {
      tabRailLayoutFrame = 0;
      syncTabRailLayout();
    };
    tabRailLayoutFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(sync)
      : window.setTimeout(sync, 0);
  }

  function syncTabRailLayout() {
    const rail = strip?.closest('.tab-bar-container');
    const header = document.querySelector('.header');
    const headerContent = document.querySelector('.header-content');
    const headerLeft = document.querySelector('.header-left');
    const headerActions = document.querySelector('.header-actions');

    if (!rail || !header || !headerContent) {
      return;
    }

    const headerRect = header.getBoundingClientRect();
    const headerContentRect = headerContent.getBoundingClientRect();
    const headerLeftRect = headerLeft?.getBoundingClientRect();
    const headerActionsRect = headerActions?.getBoundingClientRect();
    const headerContentStyle = window.getComputedStyle?.(headerContent);
    const headerContentPaddingLeft = Number.parseFloat(headerContentStyle?.paddingLeft || '0') || 0;

    if (!headerRect.width || !headerContentRect.width) {
      return;
    }

    const headerCenterX = headerRect.left + (headerRect.width / 2);
    const leftChromeEdge = headerLeftRect
      ? Math.max(headerRect.left, headerLeftRect.right)
      : headerRect.left;
    const rightChromeEdge = headerActionsRect
      ? Math.min(headerRect.right, headerActionsRect.left)
      : headerRect.right;
    const leftAvailable = Math.max(
      0,
      headerCenterX - leftChromeEdge - TAB_RAIL_CHROME_GAP_PX
    );
    const rightAvailable = Math.max(
      0,
      rightChromeEdge - headerCenterX - TAB_RAIL_CHROME_GAP_PX
    );
    const maxWidth = Math.max(
      TAB_RAIL_MIN_WIDTH_PX,
      Math.floor(Math.min(leftAvailable, rightAvailable) * 2)
    );

    header.style.setProperty(
      '--tab-rail-center-x',
      `${Math.round(headerCenterX - headerContentRect.left - headerContentPaddingLeft)}px`
    );
    header.style.setProperty('--tab-rail-max-width', `${maxWidth}px`);
    tabRailMaxWidth = maxWidth;
    const compactModeChanged = withScrollButtonsTemporarilyHidden(syncCompactCloseModes);
    syncScrollButtons();
    if (compactModeChanged) {
      syncScrollButtons();
    }
  }

  function releaseTabRailMutationSuppressionSoon() {
    window.setTimeout(() => {
      suppressTabRailMutationSync = false;
    }, 0);
  }

  function withScrollButtonsTemporarilyHidden(callback) {
    if (!scrollLeftBtn || !scrollRightBtn) {
      return callback();
    }

    const leftWasHidden = scrollLeftBtn.classList.contains('hidden');
    const rightWasHidden = scrollRightBtn.classList.contains('hidden');
    suppressTabRailMutationSync = true;
    scrollLeftBtn.classList.add('hidden');
    scrollRightBtn.classList.add('hidden');
    try {
      return callback();
    } finally {
      scrollLeftBtn.classList.toggle('hidden', leftWasHidden);
      scrollRightBtn.classList.toggle('hidden', rightWasHidden);
      releaseTabRailMutationSuppressionSoon();
    }
  }

  function syncCompactCloseModes() {
    if (!strip) {
      return false;
    }

    const tabButtons = Array.from(strip.querySelectorAll('.tab-btn'));
    const conversationTabs = tabButtons.filter(btn => btn.classList.contains('conversation-tab'));
    const previousCompactCloseState = new Map();
    const previousCompactTabState = new Map();
    suppressTabRailMutationSync = true;
    try {
      for (const btn of tabButtons) {
        const wasCompact = btn.classList.contains('compact-close-mode');
        const wasForcedCompact = btn.classList.contains('compact-tab-mode');
        previousCompactCloseState.set(btn, wasCompact);
        previousCompactTabState.set(btn, wasForcedCompact);
        if (wasCompact || wasForcedCompact) {
          btn.classList.remove('compact-close-mode', 'compact-tab-mode');
        }
      }

      const normalTabFootprint = getVisibleTabFootprint(tabButtons);
      const normalLayoutOverflows =
        normalTabFootprint > getCompactVisibleTabAvailableWidth() + 1 ||
        strip.scrollWidth > strip.clientWidth + 1;
      const compactVisibleTabsFit = shouldForceCompactFit(tabButtons);

      let changed = false;
      if (normalLayoutOverflows && compactVisibleTabsFit) {
        applyCompactFitMode(tabButtons);
        changed = tabButtons.some((btn) => (
          previousCompactTabState.get(btn) !== true ||
          (btn.classList.contains('conversation-tab') && previousCompactCloseState.get(btn) !== true)
        ));
        if (strip.scrollLeft !== 0) {
          strip.scrollLeft = 0;
        }
        return changed;
      }

      for (const btn of conversationTabs) {
        const rect = btn.getBoundingClientRect();
        const shouldUseCompactCloseMode =
          rect.width > 0 && rect.width < COMPACT_CLOSE_REPLACE_THRESHOLD_PX;
        if (btn.classList.contains('compact-close-mode') !== shouldUseCompactCloseMode) {
          btn.classList.toggle('compact-close-mode', shouldUseCompactCloseMode);
        }
      }

      for (const btn of tabButtons) {
        const isConversationTab = btn.classList.contains('conversation-tab');
        const expectedCompactClose = isConversationTab && btn.classList.contains('compact-close-mode');
        const previousCompactClose = previousCompactCloseState.get(btn) === true;
        if (
          previousCompactTabState.get(btn) === true ||
          previousCompactClose !== expectedCompactClose
        ) {
          changed = true;
        }
      }

      return changed;
    } finally {
      releaseTabRailMutationSuppressionSoon();
    }
  }

  function getCompactVisibleTabFootprint(tabButtons) {
    const tabCount = tabButtons?.length || 0;
    if (tabCount <= 0) {
      return 0;
    }
    return (tabCount * COMPACT_TAB_WIDTH_PX) + ((tabCount - 1) * TAB_STRIP_GAP_PX);
  }

  function getVisibleTabFootprint(tabButtons) {
    const tabCount = tabButtons?.length || 0;
    if (tabCount <= 0) {
      return 0;
    }
    const tabWidth = tabButtons.reduce(
      (total, btn) => total + (btn.getBoundingClientRect().width || 0),
      0
    );
    return tabWidth + ((tabCount - 1) * TAB_STRIP_GAP_PX);
  }

  function compactVisibleTabsFitAvailable(tabButtons) {
    return (
      tabButtons.length > 0 &&
      tabButtons.length <= MAX_VISIBLE_TABS &&
      getCompactVisibleTabFootprint(tabButtons) <= getCompactVisibleTabAvailableWidth() + 1
    );
  }

  function shouldForceCompactFit(tabButtons) {
    return compactVisibleTabsFitAvailable(tabButtons) || tabButtons.length === MAX_VISIBLE_TABS;
  }

  function getCompactVisibleTabAvailableWidth() {
    const header = document.querySelector('.header');
    const headerLeft = document.querySelector('.header-left');
    const headerActions = document.querySelector('.header-actions');
    const rail = strip?.closest('.tab-bar-container');
    const headerRect = header?.getBoundingClientRect();
    const headerLeftRect = headerLeft?.getBoundingClientRect();
    const headerActionsRect = headerActions?.getBoundingClientRect();
    let measuredRailMaxWidth = 0;

    if (headerRect?.width) {
      const headerCenterX = headerRect.left + (headerRect.width / 2);
      const leftChromeEdge = headerLeftRect
        ? Math.max(headerRect.left, headerLeftRect.right)
        : headerRect.left;
      const rightChromeEdge = headerActionsRect
        ? Math.min(headerRect.right, headerActionsRect.left)
        : headerRect.right;
      measuredRailMaxWidth = Math.max(
        TAB_RAIL_MIN_WIDTH_PX,
        Math.floor(Math.min(
          Math.max(0, headerCenterX - leftChromeEdge - TAB_RAIL_CHROME_GAP_PX),
          Math.max(0, rightChromeEdge - headerCenterX - TAB_RAIL_CHROME_GAP_PX)
        ) * 2)
      );
    }

    const fallbackWidth = Math.max(strip?.clientWidth || 0, rail?.clientWidth || 0);
    const availableRailWidth = Math.max(tabRailMaxWidth || 0, measuredRailMaxWidth, fallbackWidth);
    const newTabWidth = newTabBtn?.classList.contains('hidden')
      ? 0
      : (newTabBtn?.getBoundingClientRect().width || 0);
    return Math.max(0, availableRailWidth - newTabWidth);
  }

  function applyCompactFitMode(tabButtons) {
    for (const btn of tabButtons) {
      btn.classList.add('compact-tab-mode');
      if (btn.classList.contains('conversation-tab')) {
        btn.classList.add('compact-close-mode');
      }
    }
  }

  function syncScrollButtons() {
    if (!strip || !scrollLeftBtn || !scrollRightBtn) return;
    const overflows = withScrollButtonsTemporarilyHidden(() => {
      const tabButtons = Array.from(strip.querySelectorAll('.tab-btn'));
      const forcedCompactFitActive =
        tabButtons.length > 0 &&
        tabButtons.every(btn => btn.classList.contains('compact-tab-mode'));
      const compactFitPossible = shouldForceCompactFit(tabButtons);
      if (compactFitPossible && (forcedCompactFitActive || strip.scrollWidth > strip.clientWidth + 1)) {
        if (!forcedCompactFitActive) {
          applyCompactFitMode(tabButtons);
        }
        return false;
      }
      return strip.scrollWidth > strip.clientWidth + 1;
    });
    if (!overflows) {
      if (strip.scrollLeft !== 0) {
        strip.scrollLeft = 0;
      }
      scrollLeftBtn.classList.add('hidden');
      scrollRightBtn.classList.add('hidden');
      return;
    }

    scrollLeftBtn.classList.toggle('hidden', !overflows || strip.scrollLeft < 2);
    scrollRightBtn.classList.toggle('hidden', !overflows || strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 2);
  }

  function syncNewTabButtonState() {
    if (!newTabBtn) return;
    const atLimit = getVisibleTabOrder().length >= MAX_VISIBLE_TABS;
    newTabBtn.classList.toggle('at-limit', atLimit);
    newTabBtn.setAttribute('aria-disabled', String(atLimit));
    newTabBtn.title = atLimit ? TAB_LIMIT_MESSAGE : NEW_TAB_TITLE;
    newTabBtn.setAttribute('aria-label', atLimit ? TAB_LIMIT_MESSAGE : 'New tab');
  }

  // --- Tab CRUD ---

  function addTab(tabId, options = {}) {
    const state = window.appState;
    if (!state || !strip) return;

    const existing = strip.querySelector(`.tab-btn[data-tab="conversation-${tabId}"]`);
    if (existing) {
      setActive(`conversation-${tabId}`);
      syncNewTabButtonState();
      return true;
    }

    if (getVisibleTabOrder().length >= MAX_VISIBLE_TABS) {
      console.warn('[TabBar] Maximum tab limit reached (%d)', MAX_VISIBLE_TABS);
      if (window.showNotification) {
        window.showNotification(TAB_LIMIT_MESSAGE, 'warning');
      }
      syncNewTabButtonState();
      return false;
    }

    const fullTabId = `conversation-${tabId}`;
    const title = options.title || 'New Chat';
    const type = options.type || 'chat';
    // Restored tabs render their persisted model logo immediately.
    const persistedIdentity =
      options.modelIdentity || state.tabMeta[tabId]?.modelIdentity || null;
    const icon = tabIconMarkup(persistedIdentity, type);

    const btn = document.createElement('button');
    btn.className = 'tab-btn conversation-tab';
    btn.dataset.tab = fullTabId;
    btn.draggable = true;

    btn.innerHTML = `
      <span class="tab-icon">${icon}${TAB_BUSY_BLOCKS_HTML}</span>
      <span class="tab-label" title="${escapeAttr(title)}">${escapeHtml(title)}</span>
      <span class="tab-status-indicator hidden" aria-hidden="true"></span>
      <span class="tab-close-btn" data-conversation-id="${escapeAttr(tabId)}" title="Close tab" role="button" aria-label="Close tab">${CLOSE_SVG}</span>
    `;

    syncTabTitleAttributes(btn, title);
    strip.appendChild(btn);
    attachTabButtonListeners(btn, fullTabId);

    if (!state.tabOrder.includes(tabId)) {
      state.tabOrder.push(tabId);
    }
    if (!state.tabMeta[tabId]) {
      state.tabMeta[tabId] = {
        title,
        autoTitle: null,
        customTitle: null,
        conversationId: tabId,
        type,
        url: options.url || '',
        unread: options.unread === true,
        attentionRequired: options.attentionRequired === true,
        busy: false,
        busyPhase: 'idle',
      };
    }

    setUnread(tabId, state.tabMeta[tabId]?.unread === true);
    setAttentionRequired(tabId, state.tabMeta[tabId]?.attentionRequired === true);

    syncScrollButtons();
    syncNewTabButtonState();
    scrollTabIntoView(btn);

    if (options.skipSwitch !== true) {
      setActive(fullTabId);
    }

    window.persistTabState?.();
    return true;
  }

  function removeTab(tabId) {
    const state = window.appState;
    if (!state || !strip) return;
    if (PERMANENT_TABS.has(tabId)) return;

    const fullTabId = `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (btn) btn.remove();

    const idx = state.tabOrder.indexOf(tabId);
    if (idx !== -1) state.tabOrder.splice(idx, 1);
    delete state.tabMeta[tabId];

    syncScrollButtons();
    syncNewTabButtonState();
    window.persistTabState?.();
  }

  function setActive(fullTabId) {
    if (!strip) return;
    for (const btn of strip.querySelectorAll('.tab-btn')) {
      btn.classList.toggle('active', btn.dataset.tab === fullTabId);
    }
  }

  function updateTitle(tabId, title) {
    const state = window.appState;
    if (!strip || !state) return;
    const fullTabId = PERMANENT_TABS.has(tabId) ? tabId : `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (!btn) return;

    const displayTitle = window.getTabDisplayTitle?.(tabId) || title;
    const label = btn.querySelector('.tab-label');
    if (label) {
      label.textContent = displayTitle;
    }
    syncTabTitleAttributes(btn, displayTitle);
  }

  // Swap the tab's icon to the given model identity's logo (stacked pair for
  // agent chats). Falls back to the generic chat icon when unresolvable.
  function setModelIdentity(tabId, modelIdentity) {
    if (!strip) return;
    const fullTabId = PERMANENT_TABS.has(tabId) ? tabId : `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (!btn) return;
    const iconEl = btn.querySelector('.tab-icon');
    if (!iconEl) return;
    const type = window.appState?.tabMeta?.[tabId]?.type || 'chat';
    const markup = tabIconMarkup(modelIdentity, type);
    const next = `${markup}${TAB_BUSY_BLOCKS_HTML}`;
    if (iconEl.innerHTML !== next) {
      iconEl.innerHTML = next;
    }
  }

  function setActivity(tabId, activity = {}) {
    if (!strip) return;

    const fullTabId = PERMANENT_TABS.has(tabId) ? tabId : `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (!btn) return;

    const busy = activity.busy === true;
    const phase = typeof activity.phase === 'string' ? activity.phase : 'idle';
    const wasBusy = btn.classList.contains('busy');
    ensureStatusIndicator(btn);
    if (busy && !wasBusy) {
      syncBusyBlockAnimation(btn);
    }
    btn.classList.toggle('busy', busy);
    if (busy) {
      btn.dataset.activityPhase = phase;
    } else {
      delete btn.dataset.activityPhase;
      btn.style.removeProperty('--tab-busy-animation-delay');
    }
    syncStatusIndicatorVisibility(btn);
  }

  function setUnread(tabId, unread) {
    if (!strip) return;

    const fullTabId = PERMANENT_TABS.has(tabId) ? tabId : `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (!btn) return;

    ensureStatusIndicator(btn);
    btn.classList.toggle('unread', unread === true);
    syncStatusIndicatorVisibility(btn);
  }

  function setAttentionRequired(tabId, required) {
    if (!strip) return;

    const fullTabId = PERMANENT_TABS.has(tabId) ? tabId : `conversation-${tabId}`;
    const btn = strip.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
    if (!btn) return;

    ensureStatusIndicator(btn);
    btn.classList.toggle('attention-required', required === true);
    syncStatusIndicatorVisibility(btn);
  }

  function getTabOrder() {
    return getVisibleTabOrder();
  }

  function getVisibleTabOrder() {
    return (window.appState?.tabOrder || []).filter(id => id !== 'control');
  }

  function getTabAtIndex(n) {
    const order = getVisibleTabOrder();
    if (!order || n < 0 || n >= order.length) return null;
    const id = order[n];
    return PERMANENT_TABS.has(id) ? id : `conversation-${id}`;
  }

  function getNextTab(currentFullId) {
    const order = getVisibleTabOrder();
    if (!order.length) return null;
    const currentId = currentFullId.replace('conversation-', '');
    const idx = order.indexOf(currentId);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % order.length;
    const nextId = order[nextIdx];
    return PERMANENT_TABS.has(nextId) ? nextId : `conversation-${nextId}`;
  }

  function getPrevTab(currentFullId) {
    const order = getVisibleTabOrder();
    if (!order.length) return null;
    const currentId = currentFullId.replace('conversation-', '');
    const idx = order.indexOf(currentId);
    const prevIdx = idx === -1 ? order.length - 1 : (idx - 1 + order.length) % order.length;
    const prevId = order[prevIdx];
    return PERMANENT_TABS.has(prevId) ? prevId : `conversation-${prevId}`;
  }

  // --- Tab button event wiring ---

  function attachTabButtonListeners(btn, fullTabId) {
    const isPermanent = btn.dataset.permanent === 'true';
    const tabId = fullTabId.replace('conversation-', '');
    const canRename = !isPermanent || RENAMEABLE_PERMANENT_TABS.has(tabId);

    btn.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close-btn')) return;
      if (window.switchTab) window.switchTab(fullTabId);
    });

    const closeBtn = btn.querySelector('.tab-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cid = closeBtn.dataset.conversationId;
        if (cid && window.closeConversationTab) {
          window.closeConversationTab(cid);
        }
      });
    }

    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !isPermanent) {
        e.preventDefault();
        const cid = fullTabId.replace('conversation-', '');
        if (window.closeConversationTab) window.closeConversationTab(cid);
      }
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, fullTabId, isPermanent);
    });

    if (canRename) {
      btn.addEventListener('dblclick', (e) => {
        if (e.target.closest('.tab-close-btn')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const currentLabel = btn.querySelector('.tab-label');
        if (currentLabel) {
          startInlineRename(fullTabId, currentLabel);
        }
      });
    }

    if (!isPermanent) {
      btn.addEventListener('dragstart', onDragStart);
      btn.addEventListener('dragenter', onDragEnter);
    }
  }

  // --- Inline Rename ---

  function focusRenameInputWithRetry(input) {
    if (!input) {
      return () => {};
    }

    let attempts = 0;
    let timer = null;
    const focusInput = () => {
      window.electronAPI?.focusRenderer?.();
      input.focus();
      input.select();
    };
    const retry = () => {
      if (!input.isConnected || attempts >= 5) {
        return;
      }
      if (document.activeElement !== input) {
        focusInput();
      }
      attempts += 1;
      timer = window.setTimeout(retry, 50);
    };

    focusInput();
    timer = window.setTimeout(retry, 30);
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }

  function startInlineRename(fullTabId, labelEl) {
    const tabId = fullTabId.replace('conversation-', '');
    const currentText = labelEl.textContent;
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.value = currentText;
    input.maxLength = 40;
    labelEl.replaceWith(input);
    document.body?.classList.add(TAB_RENAME_ACTIVE_CLASS);
    window.setOwuiFocusSuppressed?.(TAB_RENAME_FOCUS_SUPPRESSION_REASON, true);
    const stopFocusRetry = focusRenameInputWithRetry(input);

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      try {
        stopFocusRetry();
        delete input.__commitTabRename;
        const newName = input.value.trim() || currentText;
        const newLabel = document.createElement('span');
        newLabel.className = 'tab-label';
        newLabel.textContent = newName;
        input.replaceWith(newLabel);
        syncTabTitleAttributes(newLabel.closest('.tab-btn'), newName);

        newLabel.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          startInlineRename(fullTabId, newLabel);
        });

        const state = window.appState;
        if (state?.tabMeta[tabId]) {
          state.tabMeta[tabId].customTitle = newName !== (state.tabMeta[tabId].autoTitle || state.tabMeta[tabId].title) ? newName : null;
          window.persistTabState?.();
        }
      } finally {
        document.body?.classList.remove(TAB_RENAME_ACTIVE_CLASS);
        window.setOwuiFocusSuppressed?.(TAB_RENAME_FOCUS_SUPPRESSION_REASON, false);
      }
    }
    input.__commitTabRename = commit;

    input.addEventListener('focus', () => {
      window.setOwuiFocusSuppressed?.(TAB_RENAME_FOCUS_SUPPRESSION_REASON, true);
      window.electronAPI?.focusRenderer?.();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentText; input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function getActiveRenameInput() {
    return document.querySelector('.tab-rename-input');
  }

  function commitRenameInput(input) {
    if (!input) {
      return false;
    }

    if (typeof input.__commitTabRename === 'function') {
      input.__commitTabRename();
    } else {
      input.blur();
    }
    return true;
  }

  function commitActiveRenameInput() {
    return commitRenameInput(getActiveRenameInput());
  }

  function commitActiveRenameInputFromOutsidePointer(event) {
    const input = document.querySelector('.tab-rename-input');
    if (!input || input.contains(event.target)) {
      return;
    }

    commitRenameInput(input);
  }

  function commitActiveRenameInputFromOwuiFocus(event) {
    if (event.target?.dataset?.owuiHost !== 'true') {
      return;
    }

    commitActiveRenameInput();
  }

  // --- Context Menu ---

  function buildContextMenuPayload(fullTabId, isPermanent, x, y) {
    const state = window.appState;
    const tabId = fullTabId.replace('conversation-', '');
    const tabOrder = state?.tabOrder || [];
    const dynamicTabIds = tabOrder.filter((id) => !PERMANENT_TABS.has(id));
    const tabIndex = tabOrder.indexOf(tabId);
    const tabsToRight = tabIndex === -1 ? [] : tabOrder.slice(tabIndex + 1);

    return {
      fullTabId,
      x,
      y,
      canRename: !isPermanent || RENAMEABLE_PERMANENT_TABS.has(tabId),
      canClose: !isPermanent,
      canCloseOthers: isPermanent
        ? dynamicTabIds.length > 0
        : dynamicTabIds.some((id) => id !== tabId),
      canCloseRight: tabsToRight.some((id) => !PERMANENT_TABS.has(id)),
      canDetach: !isPermanent,
    };
  }

  function showContextMenu(x, y, fullTabId, isPermanent) {
    const payload = buildContextMenuPayload(fullTabId, isPermanent, x, y);
    void window.electronAPI?.showTabContextMenu?.(payload).catch((error) => {
      console.warn('[TabBar] Failed to show native tab context menu:', error);
    });
  }

  function handleContextMenuAction(action, fullTabId) {
    if (!action || !fullTabId) {
      return;
    }

    const tabId = fullTabId.replace('conversation-', '');

    switch (action) {
      case 'rename': {
        const btn = strip?.querySelector(`.tab-btn[data-tab="${fullTabId}"]`);
        const label = btn?.querySelector('.tab-label');
        if (label) {
          startInlineRename(fullTabId, label);
        }
        break;
      }
      case 'close':
        if (window.closeConversationTab) window.closeConversationTab(tabId);
        break;
      case 'close-others':
        if (window.closeOtherTabs) window.closeOtherTabs(tabId);
        break;
      case 'close-right':
        if (window.closeTabsToRight) window.closeTabsToRight(tabId);
        break;
      case 'detach':
        if (window.detachConversationTab) window.detachConversationTab(tabId);
        break;
    }
  }

  // --- Drag-to-Reorder ---

  function createDropIndicator() {
    dropIndicator = document.createElement('div');
    dropIndicator.className = 'tab-drop-indicator hidden';
    document.body.appendChild(dropIndicator);
  }

  function onDragStart(e) {
    const btn = e.currentTarget;
    if (btn.dataset.permanent === 'true') {
      e.preventDefault();
      return;
    }
    dragSourceId = btn.dataset.tab;
    dragDropHandled = false;
    dragDetachCandidate = false;
    dragLastPointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/tab-id', dragSourceId);
    btn.classList.add('dragging');
    setTimeout(() => syncScrollButtons(), 0);
  }

  function onDragEnter(e) {
    e.preventDefault();
  }

  function updateDragPointer(e) {
    dragLastPointer = {
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    };
  }

  function shouldDetachFromPointer(clientX, clientY) {
    if (!strip || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return dragDetachCandidate;
    }

    const detachBoundsSource = strip.closest('.tab-bar-container') || strip;
    const rect = detachBoundsSource.getBoundingClientRect();
    const outsideHorizontal =
      clientX < rect.left ||
      clientX > rect.right;
    const outsideVertical =
      clientY < rect.top ||
      clientY > rect.bottom;
    return outsideHorizontal || outsideVertical;
  }

  function onDocumentDragOver(e) {
    if (!dragSourceId) {
      return;
    }

    updateDragPointer(e);
    dragDetachCandidate = shouldDetachFromPointer(e.clientX, e.clientY);
    if (dragDetachCandidate && dropIndicator) {
      dropIndicator.classList.add('hidden');
    }
  }

  function onStripDragOver(e) {
    if (!dragSourceId) return;
    e.preventDefault();
    updateDragPointer(e);
    dragDetachCandidate = shouldDetachFromPointer(e.clientX, e.clientY);
    if (dragDetachCandidate) {
      if (dropIndicator) {
        dropIndicator.classList.add('hidden');
      }
      return;
    }
    e.dataTransfer.dropEffect = 'move';

    const tabBtns = Array.from(strip.querySelectorAll('.tab-btn:not(.permanent)'));
    let insertBefore = null;
    for (const btn of tabBtns) {
      const rect = btn.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        insertBefore = btn;
        break;
      }
    }

    if (insertBefore) {
      const rect = insertBefore.getBoundingClientRect();
      positionDropIndicator(rect.left, rect.top, rect.height);
    } else if (tabBtns.length > 0) {
      const last = tabBtns[tabBtns.length - 1].getBoundingClientRect();
      positionDropIndicator(last.right, last.top, last.height);
    }
  }

  function positionDropIndicator(x, y, height) {
    if (!dropIndicator) return;
    dropIndicator.classList.remove('hidden');
    dropIndicator.style.left = `${x - 1}px`;
    dropIndicator.style.top = `${y}px`;
    dropIndicator.style.height = `${height}px`;
  }

  function onStripDrop(e) {
    e.preventDefault();
    if (!dragSourceId) return;
    dragDropHandled = true;
    dragDetachCandidate = false;

    const sourceBtn = strip.querySelector(`.tab-btn[data-tab="${dragSourceId}"]`);
    if (!sourceBtn) { onDragEnd(); return; }

    const tabBtns = Array.from(strip.querySelectorAll('.tab-btn:not(.permanent)'));
    let insertBefore = null;
    for (const btn of tabBtns) {
      if (btn === sourceBtn) continue;
      const rect = btn.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        insertBefore = btn;
        break;
      }
    }

    if (insertBefore) {
      strip.insertBefore(sourceBtn, insertBefore);
    } else {
      strip.appendChild(sourceBtn);
    }

    rebuildTabOrder();
    onDragEnd();
  }

  function onDragEnd() {
    const finishedTabId = dragSourceId;
    const pointer = dragLastPointer;
    const shouldDetach = Boolean(
      finishedTabId &&
      !dragDropHandled &&
      dragDetachCandidate
    );

    if (dragSourceId) {
      const btn = strip.querySelector(`.tab-btn[data-tab="${dragSourceId}"]`);
      if (btn) btn.classList.remove('dragging');
    }
    dragSourceId = null;
    dragDropHandled = false;
    dragDetachCandidate = false;
    dragLastPointer = null;
    if (dropIndicator) dropIndicator.classList.add('hidden');

    if (shouldDetach && window.detachConversationTab) {
      const conversationId = finishedTabId.replace('conversation-', '');
      const screenX = Number.isFinite(pointer?.screenX)
        ? pointer.screenX
        : window.screenX + Math.max(0, pointer?.clientX ?? 0);
      const screenY = Number.isFinite(pointer?.screenY)
        ? pointer.screenY
        : window.screenY + Math.max(0, pointer?.clientY ?? 0);
      window.detachConversationTab(conversationId, {
        source: 'drag-out',
        x: screenX,
        y: screenY,
      });
    }
  }

  function rebuildTabOrder() {
    const state = window.appState;
    if (!state) return;

    const newOrder = ['chat'];
    for (const btn of strip.querySelectorAll('.tab-btn:not(.permanent)')) {
      const tabId = btn.dataset.tab.replace('conversation-', '');
      if (tabId && !PERMANENT_TABS.has(tabId)) {
        newOrder.push(tabId);
      }
    }
    state.tabOrder = newOrder;
    syncNewTabButtonState();
    window.persistTabState?.();
  }

  // --- Helpers ---

  function scrollTabIntoView(btn) {
    if (!btn || !strip) return;
    setTimeout(() => {
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }, 50);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function syncTabTitleAttributes(btn, rawTitle = null) {
    if (!btn) {
      return;
    }

    const tabId = btn.dataset.tab?.replace('conversation-', '');
    const resolvedTitle = String(
      rawTitle || (tabId ? window.getTabDisplayTitle?.(tabId) : '') || btn.querySelector('.tab-label')?.textContent || ''
    ).trim();

    if (!resolvedTitle) {
      btn.removeAttribute('title');
      btn.removeAttribute('aria-label');
      return;
    }

    btn.title = resolvedTitle;
    btn.setAttribute('aria-label', resolvedTitle);

    const label = btn.querySelector('.tab-label');
    if (label) {
      label.title = resolvedTitle;
    }
  }

  function ensureStatusIndicator(btn) {
    if (!btn) {
      return null;
    }

    let indicator = btn.querySelector('.tab-status-indicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.className = 'tab-status-indicator hidden';
      indicator.setAttribute('aria-hidden', 'true');
      const closeBtn = btn.querySelector('.tab-close-btn');
      const label = btn.querySelector('.tab-label');
      if (closeBtn?.parentNode) {
        closeBtn.parentNode.insertBefore(indicator, closeBtn);
      } else if (label?.parentNode) {
        label.parentNode.insertBefore(indicator, label.nextSibling);
      } else {
        btn.appendChild(indicator);
      }
    }

    return indicator;
  }

  function syncStatusIndicatorVisibility(btn) {
    const indicator = ensureStatusIndicator(btn);
    if (!indicator) {
      return;
    }

    const visible =
      btn.classList.contains('unread') ||
      btn.classList.contains('attention-required');
    indicator.classList.toggle('hidden', !visible);
  }

  function getSynchronizedBusyAnimationDelay() {
    const timelineMs =
      Number.isFinite(document.timeline?.currentTime)
        ? document.timeline.currentTime
        : performance.now();
    const offsetMs = timelineMs % TAB_BUSY_BLOCK_DURATION_MS;
    return `-${offsetMs.toFixed(3)}ms`;
  }

  function syncBusyBlockAnimation(btn) {
    btn.style.setProperty('--tab-busy-animation-delay', getSynchronizedBusyAnimationDelay());
  }

  // --- Public API ---

  window.tabBar = {
    init,
    addTab,
    removeTab,
    setActive,
    updateTitle,
    setActivity,
    setModelIdentity,
    setUnread,
    setAttentionRequired,
    getTabOrder,
    getTabAtIndex,
    getNextTab,
    getPrevTab,
    startInlineRename,
    MAX_VISIBLE_TABS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
