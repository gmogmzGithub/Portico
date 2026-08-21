const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function loadTabBarInteractionHarness() {
  const handlers = new Map();
  const classNames = new Set();
  const attributes = new Map();
  const makeElement = () => ({
    classList: {
      add: (...names) => names.forEach((name) => classNames.add(name)),
      remove: (...names) => names.forEach((name) => classNames.delete(name)),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classNames.has(name) : force;
        if (shouldAdd) classNames.add(name);
        else classNames.delete(name);
        return shouldAdd;
      },
      contains: (name) => classNames.has(name),
    },
    addEventListener: (type, callback) => {
      handlers.set(type, callback);
    },
    appendChild: () => {},
    closest: () => null,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    style: { setProperty: () => {} },
  });

  const strip = makeElement();
  const newTabButton = makeElement();
  const body = makeElement();
  const document = {
    body,
    readyState: 'complete',
    addEventListener: () => {},
    createElement: makeElement,
    getElementById: (id) => {
      if (id === 'tab-strip') return strip;
      if (id === 'new-tab-btn') return newTabButton;
      return null;
    },
    querySelector: () => null,
    timeline: { currentTime: 0 },
  };

  let newChatCalls = 0;
  const context = {
    document,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      appState: { tabOrder: [] },
      addEventListener: () => {},
      setTimeout,
      clearTimeout,
      openNewChatTab: (...args) => {
        newChatCalls += 1;
        context.lastNewChatArguments = args;
      },
    },
  };

  vm.runInNewContext(
    readRepoFile('electron-app', 'src', 'renderer', 'components', 'tab-bar.js'),
    context,
  );

  return {
    clickNewTab: () => handlers.get('click')?.({}),
    get newChatCalls() {
      return newChatCalls;
    },
    get lastNewChatArguments() {
      return context.lastNewChatArguments;
    },
  };
}

test('local find is owned by the shell overlay instead of the OWUI preload', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const indexHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'index.html',
  );
  const detachedWindowHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'conversation-window.html',
  );
  const findBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'find-bar.js',
  );
  const preloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'preload.js',
  );
  const overlayWindowPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'local-find-overlay-preload.js',
  );
  const overlayWindowHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'local-find-overlay.html',
  );
  const windowsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'windows.js',
  );
  const ipcSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'ipc.js',
  );
  const chatPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  assert.equal(
    chatTabSource.includes('window.setOwuiFocusSuppressed = setOwuiFocusSuppressed;'),
    true,
    'chat tab shell should still expose shared OWUI focus suppression for non-find shell editors like inline tab rename',
  );
  assert.equal(
    chatTabSource.includes('if (window.isOwuiFocusSuppressed?.()) {'),
    true,
    'chat shell should still skip native OWUI refocus while a shell-owned editor is active',
  );
  assert.equal(
    indexHtmlSource.includes('renderer/components/find-bar.js'),
    true,
    'the main shell window should load the browser-style shell find bar script',
  );
  assert.equal(
    detachedWindowHtmlSource.includes('renderer/components/find-bar.js'),
    true,
    'detached chat windows should also load the browser-style shell find bar script',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI?.owui?.executeJavaScript'),
    true,
    'the shell-owned find bar should bridge into the active OWUI view on demand for placement, visibility, and hidden-history expansion',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI?.localFindOverlay?.sync'),
    true,
    'the shell-owned local find controller should sync state into a native overlay surface instead of rendering the visible chrome inline',
  );
  assert.equal(
    findBarSource.includes('window.switchTab = wrappedSwitchTab;'),
    true,
    'the main window shell overlay should remount or restore the correct per-view local-find session when chat tabs change',
  );
  assert.equal(
    preloadSource.includes('localFindOverlay: {'),
    true,
    'the shell preload should expose a dedicated local-find overlay bridge for attached and detached chat windows',
  );
  assert.equal(
    overlayWindowPreloadSource.includes("ipcRenderer.send(OWNER_EVENT_CHANNEL, {"),
    true,
    'the native overlay preload should forward UI events back to the owning shell renderer',
  );
  assert.equal(
    overlayWindowHtmlSource.includes("id=\"local-find-input\""),
    true,
    'the visible local-find chrome should live in a dedicated overlay window renderer with its own native input field',
  );
  assert.equal(
    windowsSource.includes("local-find-overlay-preload.js"),
    true,
    'window lifecycle management should create a dedicated preload for the native local-find overlay surface',
  );
  assert.equal(
    windowsSource.includes("local-find-overlay.html"),
    true,
    'window lifecycle management should load the dedicated native local-find overlay renderer',
  );
  assert.equal(
    windowsSource.includes('hasShadow: true'),
    true,
    'the native local-find overlay window should keep native shadow chrome so opening CMD+G preserves visual depth in mac windowing',
  );
  assert.equal(
    windowsSource.includes('windowRef.invalidateShadow()'),
    true,
    'mac local-find lifecycle should invalidate owner window shadow so opening CMD+G does not drop native shadow rendering',
  );
  assert.equal(
    windowsSource.includes('focusable: false'),
    true,
    'the native local-find overlay should avoid taking native key-window focus so CMD+G does not drop owner-window shadow on macOS',
  );
  assert.equal(
    ipcSource.includes("ipcMain.handle('local-find-overlay-sync'"),
    true,
    'main-process IPC should let shell renderers sync overlay state into the native local-find surface',
  );
  assert.equal(
    windowsSource.includes('destroy: true'),
    true,
    'closing local find should destroy the native overlay window instance so stale hidden overlay layers cannot trap tab interactions',
  );
  assert.equal(
    windowsSource.includes('entry.window.setIgnoreMouseEvents(false);'),
    true,
    'showing local find should explicitly restore overlay hit-testing so the surface never reopens in click-through mode',
  );
  assert.equal(
    ipcSource.includes("const { safeWebContentsSend } = require('./webcontents-safe');"),
    true,
    'main-process overlay event forwarding should import the guarded window-send helper before proxying native overlay actions back to the owning shell renderer',
  );
  assert.equal(
    ipcSource.includes('overlayWindow.destroy();'),
    true,
    'orphaned local-find overlay windows should be destroyed immediately instead of left hidden',
  );
  assert.equal(
    ipcSource.includes('destroy: true,'),
    true,
    'main-process close fallback should destroy the native overlay window so stale hidden instances cannot trap interactions',
  );
  assert.equal(
    ipcSource.includes('function handleLocalFindOverlayFallbackEvent(ownerWindow, payload = {}) {'),
    true,
    'main-process local-find overlay handling should include a fallback path that executes search actions directly when owner-renderer delivery is unavailable',
  );
  assert.equal(
    ipcSource.includes('const handledInMain ='),
    true,
    'local-find overlay events should identify actionable event types that can run in main-process fallback mode',
  );
  assert.equal(
    ipcSource.includes("type === 'release-focus'"),
    true,
    'overlay blur events should be actionable in main-process fallback mode so outside-click dismissal never depends on renderer delivery',
  );
  assert.equal(
    ipcSource.includes('handledInMain ? { ...forwardedPayload, handledInMain: true } : payload'),
    true,
    'local-find overlay events should tag owner-renderer payloads when main-process fallback already executed actionable commands (including blur-to-close normalization)',
  );
  assert.equal(
    ipcSource.includes('if (!delivered && !handledInMain) {'),
    true,
    'local-find overlay events should use delivery-failure fallback only for non-actionable sync events because actionable ones already run in main process',
  );
  assert.equal(
    ipcSource.includes('findNext: true'),
    true,
    'main-process local-find fallback should also start a fresh Electron find session when the query or case-sensitivity changes',
  );
  assert.equal(
    ipcSource.includes('findNext: false'),
    true,
    'main-process local-find fallback should keep next/previous navigation in the existing Electron find session to preserve wrap-around behavior',
  );
  assert.equal(
    chatPreloadSource.includes("({ LocalFindSession } = require('./local-find-session'));"),
    false,
    'the OWUI preload should stop loading the retired in-page local-find session helper',
  );
  assert.equal(
    chatPreloadSource.includes('const localFindBar = new OwuiLocalFindBar();'),
    false,
    'the OWUI preload should no longer instantiate the retired in-page local-find overlay',
  );
  assert.equal(
    chatPreloadSource.includes('class OwuiLocalFindBar {'),
    false,
    'the OWUI preload should no longer carry the retired in-page local-find UI class at all',
  );
  assert.equal(
    chatPreloadSource.includes('pendingSelfMatchSkip'),
    false,
    'the OWUI preload should drop the retired self-hit normalization workaround once the shell overlay owns CMD+G',
  );
  assert.equal(
    chatPreloadSource.includes("ipcRenderer.on('find-in-page-next'"),
    false,
    'the OWUI preload should stop subscribing to shell-local-find triggers once the shell renderer owns the visible overlay',
  );
  assert.equal(
    chatPreloadSource.includes("ipcRenderer.on('found-in-page-result'"),
    false,
    'the OWUI preload should stop consuming native local-find results once the shell renderer owns the counter and focus contract',
  );
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'electron-app', 'src', 'services', 'local-find-session.js'),
    ),
    false,
    'the retired local-find session helper should be removed once the shell overlay takes over',
  );
});

test('shell find bar keeps browser-style focus and transcript-only bridges in the shell renderer', () => {
  const findBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'find-bar.js',
  );

  assert.equal(
    findBarSource.includes('window.electronAPI?.onFindInPageOpen'),
    true,
    'the shell-owned local find overlay should receive CMD+F find-in-page-open triggers in the shell renderer',
  );
  assert.equal(
    findBarSource.includes('this.showFresh();'),
    true,
    'CMD+F should invoke showFresh to open the bar with the previous query selected for easy replacement',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPageNext(this._boundOnFindInPageNext);'),
    true,
    'the shell-owned local find overlay should receive CMD+G triggers in the shell renderer',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPagePrev(this._boundOnFindInPagePrev);'),
    true,
    'the shell-owned local find overlay should receive Shift+CMD+G triggers in the shell renderer',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPageResult(this._boundOnFindResult);'),
    true,
    'the shell-owned local find overlay should update its counter from native find results in the shell renderer',
  );
  assert.equal(
    findBarSource.includes("window.electronAPI?.localFindOverlay?.onEvent"),
    true,
    'the shell-owned local find controller should receive button and input events back from the native overlay surface',
  );
  assert.equal(
    findBarSource.includes('_syncToActiveView({ reapplyFind: false })'),
    true,
    'the shell-owned local find controller should bypass recursive reapply logic when shortcut handlers or direct executions refresh the active view',
  );
  assert.equal(
    findBarSource.includes('if (this.query && reapplyFind && window.electronAPI?.owuiFindInPage)'),
    true,
    'the shell-owned local find controller should reapply an existing query only from explicit active-view sync paths instead of recursively re-entering _executeFind',
  );
  assert.equal(
    findBarSource.includes("case 'query-change':"),
    true,
    'the shell-owned local find controller should react to query edits from the native overlay input',
  );
  assert.equal(
    findBarSource.includes("case 'release-focus':"),
    true,
    'the shell-owned local find controller should release focus ownership explicitly when the native overlay blurs',
  );
  assert.equal(
    findBarSource.includes("case 'toggle-case':"),
    true,
    'the shell-owned local find controller should keep case-sensitivity owned by the shell state machine',
  );
  assert.equal(
    findBarSource.includes('findNext: true'),
    true,
    'initial shell-owned local-find requests should start a fresh Electron find session so wrap-around navigation does not drift into a phantom ordinal state',
  );
  assert.equal(
    findBarSource.includes('findNext: false'),
    true,
    'follow-up shell-owned local-find navigation should stay within the active Electron find session instead of restarting it on every next/previous action',
  );
  assert.equal(
    findBarSource.includes('this.visible && this.retainFocus'),
    true,
    'the shell-owned local find overlay should suppress shell-driven OWUI refocus only while its input still owns focus',
  );
  assert.equal(
    findBarSource.includes("window.addEventListener('focus', this._boundOnWindowFocus);"),
    true,
    'the shell-owned local find controller should re-sync the native overlay when the owning shell window regains focus',
  );
  assert.equal(
    findBarSource.includes('window.setOwuiViewportInset'),
    false,
    'the shell-owned local find overlay should stay floating and avoid reintroducing a reserved viewport row',
  );
  assert.equal(
    findBarSource.includes("document.addEventListener('focusin', this._boundOnDocumentFocusIn, true);"),
    false,
    'focus retention should move out of shell DOM listeners once the visible chrome lives in the native overlay window',
  );
  assert.equal(
    findBarSource.includes("document.addEventListener('pointerdown', this._boundOnOwnerPointerDown, true);"),
    true,
    'the shell find controller should dismiss local-find when the owning shell window receives an outside click',
  );
  assert.equal(
    findBarSource.includes('_focusInputWithRetry'),
    false,
    'the shell controller should stop trying to focus an inline DOM input once the visible chrome lives in the native overlay window',
  );
});

test('found-in-page result forwarding is bound per OWUI view', () => {
  const owuiViewsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-views.js',
  );
  const setupForwardingBlock = owuiViewsSource.slice(
    owuiViewsSource.indexOf('function setupFindInPageForwarding('),
    owuiViewsSource.indexOf('function getOpenConversationTabs('),
  );

  assert.equal(
    owuiViewsSource.includes('contents.on("found-in-page", (_event, result) => {'),
    true,
    'OWUI webcontents should forward native find results when each view is created',
  );
  assert.equal(
    owuiViewsSource.includes('const hostWindow = getOwuiHostWindow(entry);'),
    true,
    'find results should resolve the current host window at event time',
  );
  assert.equal(
    owuiViewsSource.includes('hostWindow.webContents.send("found-in-page-result", payload);'),
    true,
    'find results should be emitted back to the shell renderer that owns the active view',
  );
  assert.equal(
    owuiViewsSource.includes('contents.send("found-in-page-result", payload);'),
    false,
    'find results should stop rebroadcasting into the active OWUI view once the shell overlay owns the local-find counter',
  );
  assert.equal(
    setupForwardingBlock.includes('bindWebContentsEvents(entry);'),
    true,
    'legacy setupFindInPageForwarding calls should reuse the per-view binding path',
  );
});

test('native find state stays window-aware across attached and detached chats', () => {
  const owuiViewsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-views.js',
  );
  const ipcSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'ipc.js',
  );

  assert.equal(
    owuiViewsSource.includes('const _findInPageSessions = new Map();'),
    true,
    'native find tracking should keep independent sessions per shell window so detached chats do not share one global find state',
  );
  assert.equal(
    owuiViewsSource.includes('function stopFindInPage(action = "clearSelection", windowId) {'),
    true,
    'stopping native find should accept the owning window id so detached chats do not clear the wrong view',
  );
  assert.equal(
    owuiViewsSource.includes('const sessionKey = getFindInPageSessionKey(normalizedWindowId);'),
    true,
    'native find routing should resolve the find session from the sender window id instead of a shared global slot',
  );
  assert.equal(
    owuiViewsSource.includes('if (!Number.isFinite(normalizedWindowId)) {'),
    true,
    'window-aware native find should fail closed when the sender window cannot be resolved instead of falling back to a global active view',
  );
  assert.equal(
    owuiViewsSource.includes('if (!isEligibleActiveViewEntry(entry, normalizedWindowId)) {'),
    true,
    'active-view routing should verify that the resolved view still belongs to the requesting window before using it',
  );
  assert.equal(
    ipcSource.includes('owuiViews.stopFindInPage(action, windowId);'),
    true,
    'the main-process stop-find bridge should pass the sender window id through to OWUI view routing',
  );
});

test('tab rename keeps the selected tab id and supports double-click inline rename, including the main Chat tab', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );

  assert.equal(
    tabBarSource.includes('handleContextMenuAction(payload?.action, payload?.fullTabId);'),
    true,
    'native context-menu actions should preserve the target tab id when routing rename commands back to the renderer',
  );
  assert.equal(
    tabBarSource.includes('startInlineRename(fullTabId, label);'),
    true,
    'context-menu rename should use the preserved full tab id when entering inline rename',
  );
  assert.equal(
    tabBarSource.includes("const RENAMEABLE_PERMANENT_TABS = new Set(['chat']);"),
    true,
    'the permanent Chat tab should be explicitly carve-out renameable without weakening other permanent-tab rules',
  );
  assert.equal(
    tabBarSource.includes('const canRename = !isPermanent || RENAMEABLE_PERMANENT_TABS.has(tabId);'),
    true,
    'inline rename should allow the permanent Chat tab while keeping other permanent tabs fixed',
  );
  assert.equal(
    tabBarSource.includes("btn.addEventListener('dblclick', (e) => {"),
    true,
    'renameable tabs should allow double-click inline rename directly from the tab button',
  );
});

test('tab inline rename suppresses OWUI refocus so the cursor stays in the rename field', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );

  assert.equal(
    tabBarSource.includes("const TAB_RENAME_FOCUS_SUPPRESSION_REASON = 'tab-rename';"),
    true,
    'tab rename should use its own OWUI focus suppression token',
  );
  assert.equal(
    tabBarSource.includes("window.setOwuiFocusSuppressed?.(TAB_RENAME_FOCUS_SUPPRESSION_REASON, true);"),
    true,
    'tab rename should suppress OWUI refocus before focusing the inline rename input',
  );
  assert.equal(
    tabBarSource.includes("window.setOwuiFocusSuppressed?.(TAB_RENAME_FOCUS_SUPPRESSION_REASON, false);"),
    true,
    'tab rename should release OWUI refocus suppression after inline editing completes',
  );
  assert.equal(
    tabBarSource.includes('focusRenameInputWithRetry(input);'),
    true,
    'tab rename should retry shell focus so keystrokes stay in the inline rename input',
  );
  assert.equal(
    tabBarSource.includes('window.electronAPI?.focusRenderer?.();'),
    true,
    'tab rename should explicitly focus the shell renderer before editing text',
  );
});

test('tab strip wheel handling supports touchpad horizontal scrolling', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const indexHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'index.html',
  );
  const stylesSource = readRepoFile('electron-app', 'src', 'styles.css');

  assert.equal(
    tabBarSource.includes('if (absX > absY) {'),
    true,
    'tab strip wheel handling should preserve native horizontal touchpad inertia instead of overriding horizontal wheel gestures',
  );
  assert.equal(
    tabBarSource.includes('if (strip.scrollWidth <= strip.clientWidth + 1) {'),
    true,
    'tab strip wheel handling should avoid consuming wheel gestures when tabs do not overflow',
  );
  assert.equal(
    tabBarSource.includes('if (e.ctrlKey) {'),
    true,
    'tab strip wheel handling should avoid consuming pinch-to-zoom wheel gestures',
  );
  assert.equal(
    tabBarSource.includes('strip.scrollLeft += e.deltaY;'),
    true,
    'tab strip wheel handling should still map vertical wheel gestures into horizontal tab navigation',
  );
  assert.equal(
    stylesSource.includes('overflow-x: auto;'),
    true,
    'tab strip styles should allow native horizontal scrolling so touchpad gestures stay smooth',
  );
  assert.equal(
    stylesSource.includes('flex: 0 1 auto;'),
    true,
    'tab strip styles should keep visible chat tabs content-sized instead of growing to fill wide windows',
  );
  assert.match(
    stylesSource,
    /\.tab-strip\s*\{[^}]*overflow-x:\s*auto;[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*\}/s,
    'the scrollable tab strip should shrink to its intrinsic tab content instead of filling the whole rail and pushing the new-tab button away',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-strip\s*\{[^}]*flex:\s*1;[^}]*\}/s,
    'the tab strip should not grow across the full header rail',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*40px;[^}]*max-width:\s*220px;[^}]*overflow:\s*hidden;[^}]*gap:\s*0\.2rem;[^}]*padding:\s*0 0\.5rem;[^}]*\}/s,
    'closable conversation tabs should stay intrinsically sized, cap at the old maximum, and shrink to an icon-sized footprint',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.permanent\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*40px;[^}]*max-width:\s*220px;[^}]*overflow:\s*hidden;[^}]*\}/s,
    'permanent tabs should keep the smaller icon-capable floor because they do not expose a real close button',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab \.tab-close-btn\s*\{[^}]*opacity:\s*1;[^}]*flex:\s*0 0 18px;[^}]*min-width:\s*18px;[^}]*\}/s,
    'conversation tab close buttons should stay visible and keep a non-collapsible hit target',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode\s*\{[^}]*justify-content:\s*center;[^}]*gap:\s*0;[^}]*\}/s,
    'compact conversation tabs should center the single visible icon-slot affordance',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.compact-tab-mode\s*\{[^}]*flex:\s*0 0 34px;[^}]*width:\s*34px;[^}]*min-width:\s*34px;[^}]*padding:\s*0;[^}]*justify-content:\s*center;[^}]*gap:\s*0;[^}]*\}/s,
    'forced compact-fit tabs should occupy deterministic 34px slots instead of passively shrinking',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.compact-tab-mode \.tab-label,\s*\.tab-btn\.compact-tab-mode \.tab-close-spacer\s*\{\s*display:\s*none;/s,
    'forced compact-fit mode should hide labels and the permanent-tab close spacer',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode \.tab-label\s*\{\s*display:\s*none;/s,
    'compact conversation tabs should hide the label before hiding the chat icon',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab \.tab-status-indicator:not\(\.hidden\),\s*\.tab-btn\.compact-tab-mode \.tab-status-indicator:not\(\.hidden\)\s*\{[^}]*position:\s*absolute;[^}]*top:\s*5px;[^}]*right:\s*2px;[^}]*display:\s*block;[^}]*\}/s,
    'conversation and compact tabs should keep unread and attention status dots visible as an overlaid badge',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode \.tab-icon\s*\{\s*display:\s*flex;\s*\}/s,
    'compact conversation tabs should show the chat icon by default',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode \.tab-close-btn\s*\{[^}]*display:\s*none;[^}]*flex:\s*0 0 18px;[^}]*min-width:\s*18px;[^}]*opacity:\s*1;[^}]*\}/s,
    'compact conversation tabs should keep the close affordance sized but hidden until the tab is hovered or focused',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode:hover \.tab-icon,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-visible \.tab-icon,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-within \.tab-icon\s*\{\s*display:\s*none;\s*\}/s,
    'compact conversation tabs should hide the chat icon when hover or focus exposes the close button',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.conversation-tab\.compact-close-mode:hover \.tab-close-btn,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-visible \.tab-close-btn,\s*\.tab-btn\.conversation-tab\.compact-close-mode:focus-within \.tab-close-btn\s*\{\s*display:\s*inline-flex;\s*\}/s,
    'compact conversation tabs should swap in the close button only on hover or focus',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.conversation-tab \.tab-close-btn\s*\{[^}]*opacity:\s*0;/s,
    'conversation tab close buttons should not be hidden until hover or active state',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.conversation-tab,\s*\.tab-btn\.permanent\s*\{[^}]*flex:\s*1 1 156px;/s,
    'visible chat tabs should not use equal-width growth that makes tabs too wide in stretched windows',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.conversation-tab(?:,\s*\.tab-btn\.permanent)?\s*\{[^}]*min-width:\s*(?:58|64|92)px;/s,
    'visible chat tabs should not keep wider minimums that prevent icon-first shrinking',
  );
  assert.equal(
    /<div class="tab-strip" id="tab-strip">[\s\S]*<\/div>\s*<button class="tab-scroll-btn tab-scroll-right hidden"[\s\S]*<\/button>\s*<button class="tab-new-btn" id="new-tab-btn"/.test(indexHtmlSource),
    true,
    'the new-tab button should remain inside the centered tab rail immediately after the scrollable strip and its right scroll control',
  );
  assert.equal(
    tabBarSource.includes('function syncTabRailLayout()'),
    true,
    'the tab bar should measure the header chrome and keep the compact rail centered on the window',
  );
  assert.equal(
    tabBarSource.includes('headerCenterX - headerContentRect.left - headerContentPaddingLeft'),
    true,
    'the centered rail should target the true window center instead of being shifted by header-content padding',
  );
  assert.equal(
    tabBarSource.includes('Math.min(leftAvailable, rightAvailable) * 2'),
    true,
    'the centered rail should shrink symmetrically around the window center when side chrome constrains it',
  );
  assert.equal(
    tabBarSource.includes("'--tab-rail-max-width'"),
    true,
    'the tab rail measurement helper should clamp centered tabs with a CSS max-width variable',
  );
  assert.equal(
    tabBarSource.includes('const COMPACT_CLOSE_REPLACE_THRESHOLD_PX = 64;'),
    true,
    'the tab bar should define the width threshold where compact hover-to-close behavior begins',
  );
  assert.equal(
    tabBarSource.includes('const COMPACT_TAB_WIDTH_PX = 34;') &&
      tabBarSource.includes('const TAB_STRIP_GAP_PX = 2;'),
    true,
    'the tab bar should define the exact compact footprint used to fit all visible tabs before scrolling',
  );
  assert.match(
    tabBarSource,
    /function syncCompactCloseModes\(\)[\s\S]*querySelectorAll\('\.tab-btn'\)[\s\S]*const normalTabFootprint = getVisibleTabFootprint\(tabButtons\);[\s\S]*normalTabFootprint > getCompactVisibleTabAvailableWidth\(\) \+ 1[\s\S]*const compactVisibleTabsFit = shouldForceCompactFit\(tabButtons\);[\s\S]*applyCompactFitMode\(tabButtons\);/s,
    'the tab bar should force all visible tabs into compact 34px slots when that footprint fits before showing scroll arrows',
  );
  assert.match(
    tabBarSource,
    /function getCompactVisibleTabFootprint\(tabButtons\)[\s\S]*return \(tabCount \* COMPACT_TAB_WIDTH_PX\) \+ \(\(tabCount - 1\) \* TAB_STRIP_GAP_PX\);/s,
    'the compact-fit footprint should count all visible tabs and their tab-strip gaps',
  );
  assert.match(
    tabBarSource,
    /function getVisibleTabFootprint\(tabButtons\)[\s\S]*btn\.getBoundingClientRect\(\)\.width[\s\S]*return tabWidth \+ \(\(tabCount - 1\) \* TAB_STRIP_GAP_PX\);/s,
    'the normal fit check should measure the natural rendered footprint directly instead of relying only on scrollWidth/clientWidth',
  );
  assert.match(
    tabBarSource,
    /let tabRailMaxWidth = 0;[\s\S]*tabRailMaxWidth = maxWidth;[\s\S]*function compactVisibleTabsFitAvailable\(tabButtons\)[\s\S]*tabButtons\.length <= MAX_VISIBLE_TABS[\s\S]*getCompactVisibleTabFootprint\(tabButtons\) <= getCompactVisibleTabAvailableWidth\(\) \+ 1/s,
    'compact-fit checks should compare the exact five-tab footprint against the measured available tab rail width',
  );
  assert.match(
    tabBarSource,
    /function shouldForceCompactFit\(tabButtons\)[\s\S]*return compactVisibleTabsFitAvailable\(tabButtons\) \|\| tabButtons\.length === MAX_VISIBLE_TABS;/s,
    'the five-tab hard cap should force compact mode before tab scrolling appears at the minimum window width',
  );
  assert.match(
    tabBarSource,
    /function getCompactVisibleTabAvailableWidth\(\)[\s\S]*const header = document\.querySelector\('\.header'\);[\s\S]*const availableRailWidth = Math\.max\(tabRailMaxWidth \|\| 0, measuredRailMaxWidth, fallbackWidth\);[\s\S]*return Math\.max\(0, availableRailWidth - newTabWidth\);/s,
    'compact-fit available width should use the centered rail max width and ignore scroll buttons because the compact fit decides whether they are needed',
  );
  assert.match(
    tabBarSource,
    /const conversationTabs = tabButtons\.filter\(btn => btn\.classList\.contains\('conversation-tab'\)\);[\s\S]*for \(const btn of conversationTabs\)[\s\S]*getBoundingClientRect\(\)[\s\S]*rect\.width < COMPACT_CLOSE_REPLACE_THRESHOLD_PX[\s\S]*classList\.toggle\('compact-close-mode', shouldUseCompactCloseMode\)/s,
    'the tab bar should measure rendered conversation tab width and toggle compact close mode below the threshold',
  );
  assert.match(
    tabBarSource,
    /const previousCompactCloseState = new Map\(\);[\s\S]*const previousCompactTabState = new Map\(\);[\s\S]*btn\.classList\.remove\('compact-close-mode', 'compact-tab-mode'\);[\s\S]*getBoundingClientRect\(\)[\s\S]*previousCompactTabState\.get\(btn\) === true/s,
    'compact mode measurement should clear stale forced compact classes first so tabs can return to their normal width after the window expands',
  );
  assert.match(
    tabBarSource,
    /if \(strip\.scrollLeft !== 0\) \{[\s\S]*strip\.scrollLeft = 0;[\s\S]*\}/s,
    'forced compact-fit mode should reset tab-strip scroll so all five compact tabs are visible from the left edge',
  );
  assert.match(
    tabBarSource,
    /let suppressTabRailMutationSync = false;[\s\S]*new MutationObserver\(\(\) => \{[\s\S]*if \(!suppressTabRailMutationSync\) \{[\s\S]*requestTabRailLayoutSync\(\);[\s\S]*function releaseTabRailMutationSuppressionSoon\(\)[\s\S]*suppressTabRailMutationSync = false;[\s\S]*suppressTabRailMutationSync = true;[\s\S]*finally \{[\s\S]*releaseTabRailMutationSuppressionSoon\(\);/s,
    'internal compact measurement class churn should not feed back into the tab rail mutation observer',
  );
  assert.match(
    tabBarSource,
    /function withScrollButtonsTemporarilyHidden\(callback\)[\s\S]*scrollLeftBtn\.classList\.add\('hidden'\);[\s\S]*scrollRightBtn\.classList\.add\('hidden'\);[\s\S]*scrollLeftBtn\.classList\.toggle\('hidden', leftWasHidden\);[\s\S]*scrollRightBtn\.classList\.toggle\('hidden', rightWasHidden\);/s,
    'tab rail measurements should temporarily hide scroll buttons so their own width does not create avoidable overflow',
  );
  assert.match(
    tabBarSource,
    /const compactModeChanged = withScrollButtonsTemporarilyHidden\(syncCompactCloseModes\);[\s\S]*syncScrollButtons\(\);[\s\S]*if \(compactModeChanged\) \{[\s\S]*syncScrollButtons\(\);[\s\S]*\}/s,
    'scroll button visibility should be recomputed after compact close mode changes remove overflow',
  );
  assert.match(
    tabBarSource,
    /const overflows = withScrollButtonsTemporarilyHidden\(\(\) => \{[\s\S]*const forcedCompactFitActive =[\s\S]*tabButtons\.every\(btn => btn\.classList\.contains\('compact-tab-mode'\)\);[\s\S]*const compactFitPossible = shouldForceCompactFit\(tabButtons\);[\s\S]*if \(compactFitPossible && \(forcedCompactFitActive \|\| strip\.scrollWidth > strip\.clientWidth \+ 1\)\) \{[\s\S]*applyCompactFitMode\(tabButtons\);[\s\S]*return false;[\s\S]*return strip\.scrollWidth > strip\.clientWidth \+ 1;[\s\S]*if \(!overflows\) \{[\s\S]*scrollLeftBtn\.classList\.add\('hidden'\);[\s\S]*scrollRightBtn\.classList\.add\('hidden'\);[\s\S]*return;[\s\S]*\}/s,
    'scroll buttons should stay hidden when forced compact tabs fit once the scroll-button slots are removed',
  );
  assert.match(
    tabBarSource,
    /new MutationObserver\(\(\) => \{[\s\S]*requestTabRailLayoutSync\(\);[\s\S]*tabRailMutationObserver\.observe\(strip,[\s\S]*tabRailMutationObserver\.observe\(document\.body,/s,
    'tab rail layout should be refreshed when tabs or fullscreen/body classes mutate',
  );
  assert.equal(
    tabBarSource.includes("window.visualViewport?.addEventListener('resize', requestTabRailLayoutSync);"),
    true,
    'tab rail layout should react to viewport resize in addition to header element resize',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.permanent\s*\{[^}]*min-width:\s*118px;/s,
    'the main Chat tab should not keep the old larger permanent-tab minimum width',
  );
  assert.equal(
    tabBarSource.includes("const PERMANENT_TABS = new Set(['chat']);"),
    true,
    'the tab strip should only treat visible shell tabs as permanent tabs',
  );
  assert.equal(
    tabBarSource.includes("const newOrder = ['chat'];"),
    true,
    'tab strip rebuilds should keep Control Plane out of the visible tab order',
  );
  assert.equal(
    tabBarSource.includes("return (window.appState?.tabOrder || []).filter(id => id !== 'control');"),
    true,
    'keyboard tab cycling should use the visible tab order and skip Control Plane',
  );
});

test('main chat tab cap keeps the new-tab affordance visible and explains the five-tab limit', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const indexSource = readRepoFile('electron-app', 'src', 'renderer', 'views', 'index.js');
  const stylesSource = readRepoFile('electron-app', 'src', 'styles.css');

  assert.equal(
    tabBarSource.includes('const MAX_VISIBLE_TABS = 5;'),
    true,
    'the shell tab cap should allow at most five visible tabs including the permanent Chat tab',
  );
  assert.equal(
    tabBarSource.includes("const TAB_LIMIT_MESSAGE = 'Maximum tabs reached.';"),
    true,
    'the capped new-tab affordance should use a concise hover message',
  );
  assert.equal(
    tabBarSource.includes('const atLimit = getVisibleTabOrder().length >= MAX_VISIBLE_TABS;') &&
      tabBarSource.includes("newTabBtn.classList.toggle('at-limit', atLimit);") &&
      tabBarSource.includes("newTabBtn.setAttribute('aria-disabled', String(atLimit));") &&
      tabBarSource.includes('newTabBtn.title = atLimit ? TAB_LIMIT_MESSAGE : NEW_TAB_TITLE;') &&
      tabBarSource.includes("newTabBtn.setAttribute('aria-label', atLimit ? TAB_LIMIT_MESSAGE : 'New tab');"),
    true,
    'the plus button should remain visible while exposing the limit through visual and accessible state',
  );
  assert.equal(
    tabBarSource.includes("if (newTabBtn.getAttribute('aria-disabled') === 'true') {\n          return;\n        }"),
    true,
    'clicking the plus button at the limit should be a silent no-op',
  );
  assert.match(
    stylesSource,
    /\.tab-new-btn\.at-limit\s*\{[^}]*cursor:\s*default;[^}]*opacity:\s*0\.55;/s,
    'the plus button should look unavailable without showing a prohibited cursor or disappearing',
  );
  assert.doesNotMatch(
    tabBarSource,
    /newTabBtn\.classList\.toggle\('hidden'/,
    'the tab limit should never hide the plus button',
  );
  assert.equal(
    tabBarSource.includes('if (getVisibleTabOrder().length >= MAX_VISIBLE_TABS) {'),
    true,
    'new conversation tabs should be blocked once the visible tab order reaches the cap',
  );
  assert.match(
    tabBarSource,
    /const existing = strip\.querySelector\(`\.tab-btn\[data-tab="conversation-\$\{tabId\}"\]`\);[\s\S]*if \(existing\) \{[\s\S]*setActive\(`conversation-\$\{tabId\}`\);[\s\S]*return true;[\s\S]*if \(getVisibleTabOrder\(\)\.length >= MAX_VISIBLE_TABS\) \{/s,
    'opening a conversation that already has a tab should still switch to it before enforcing the cap',
  );
  assert.equal(
    tabBarSource.includes("return (window.appState?.tabOrder || []).filter(id => id !== 'control');"),
    true,
    'the cap should use the visible tab order and continue excluding Control Plane header chrome',
  );
  assert.equal(
    tabBarSource.includes('MAX_VISIBLE_TABS,'),
    true,
    'restore code should be able to read the tab cap from the tab-bar public API',
  );
  assert.equal(
    chatTabSource.includes('if (added === false) return false;') &&
      chatTabSource.includes('return openConversationTab(buildNewChatUrl(options), conversationId, {') &&
      chatTabSource.includes('return true;'),
    true,
    'conversation tab creation should report false only when tab-bar creation is blocked',
  );
  assert.equal(
    chatTabSource.includes('const opened = openConversationTab(url, conversationId, {') &&
      chatTabSource.includes("return { success: false, error: 'Maximum of 5 tabs reached. Close some tabs first.' };"),
    true,
    'detached-window reattach should report failure when the tab cap blocks reattachment',
  );
  assert.equal(
    indexSource.includes('const maxVisibleTabs = window.tabBar?.MAX_VISIBLE_TABS || 5;') &&
      indexSource.includes('let restoredVisibleTabCount = 1;') &&
      indexSource.includes('if (restoredVisibleTabCount >= maxVisibleTabs) break;') &&
      indexSource.includes('restoredVisibleTabCount += 1;') &&
      indexSource.includes('restoredTabIds.add(tabId);'),
    true,
    'persisted restore should only materialize the first five visible tabs',
  );
  assert.equal(
    indexSource.includes("const restoredChatTitle = savedChatMeta.customTitle || savedChatMeta.autoTitle || savedChatMeta.title || 'Chat';") &&
      indexSource.includes('state.tabMeta.chat.customTitle = savedChatMeta.customTitle || null;') &&
      indexSource.includes('state.tabMeta.chat.autoTitle = savedChatMeta.autoTitle || null;') &&
      indexSource.includes("window.tabBar?.updateTitle('chat', restoredChatTitle);"),
    true,
    'persisted restore should also hydrate the permanent chat tab display title from saved auto-title metadata',
  );
  assert.equal(
    indexSource.includes("const restoredTitle = meta.customTitle || meta.autoTitle || meta.title || 'Chat';") &&
      indexSource.includes('title: meta.title || restoredTitle,') &&
      indexSource.includes('state.tabMeta[tabId].title = meta.title || state.tabMeta[tabId].title;') &&
      indexSource.includes('state.tabMeta[tabId].autoTitle = meta.autoTitle || null;') &&
      indexSource.includes('window.tabBar?.updateTitle(tabId, restoredTitle);'),
    true,
    'persisted restore should show saved auto-generated conversation titles before any tab is clicked',
  );
  assert.equal(
    indexSource.includes("const restoredTabIds = new Set(['chat']);") &&
      indexSource.includes("const savedActiveTabId = saved.activeTab.replace('conversation-', '');") &&
      indexSource.includes('if (restoredTabIds.has(savedActiveTabId)) {'),
    true,
    'persisted restore should not switch to an over-limit tab that was skipped',
  );
});

test('prompt-aware new chats reuse the shell tab path and acknowledge detached requests', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const agentsSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'agents.js',
  );
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const preloadSource = readRepoFile('electron-app', 'src', 'services', 'preload.js');
  const ipcSource = readRepoFile('electron-app', 'src', 'services', 'ipc.js');
  const indexSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'index.js',
  );

  assert.match(
    chatTabSource,
    /function buildNewChatUrl\(options = \{\}\)[\s\S]*new URL\(OPEN_WEBUI_HOME_URL\)[\s\S]*searchParams\.set\('models', modelId\)[\s\S]*searchParams\.set\('q', prompt\)[\s\S]*searchParams\.set\('submit', 'true'\)/,
  );
  assert.match(
    chatTabSource,
    /const SHELL_ONLY_OWUI_URL_PARAMS = new Set\(\[[\s\S]*'q',[\s\S]*'submit',[\s\S]*\]\);/,
    'one-shot prompt parameters must not survive tab persistence or restoration',
  );
  assert.match(
    chatTabSource,
    /function openNewChatTab\(options = \{\}\)[\s\S]*openConversationTab\(buildNewChatUrl\(options\), conversationId, \{[\s\S]*title,[\s\S]*type: 'chat'/,
  );
  assert.match(
    agentsSource,
    /function openAgentChatTab\(agentId, agentName, prompt = ""\)[\s\S]*window\.openNewChatTab\(\{[\s\S]*modelId: agentId,[\s\S]*prompt,[\s\S]*title:/,
    'Agents Chat must use the same optional-prompt helper while retaining model selection',
  );
  const tabBar = loadTabBarInteractionHarness();
  tabBar.clickNewTab();
  assert.equal(tabBar.newChatCalls, 1);
  assert.deepEqual(
    tabBar.lastNewChatArguments,
    [],
    'the plus-menu action must preserve its existing prompt-free new-chat behavior',
  );
  assert.match(
    preloadSource,
    /requestOpenNewChatTab:\s*\(options = \{\}\)\s*=>\s*ipcRenderer\.invoke\('request-open-new-chat-tab', options\)/,
  );
  assert.match(
    preloadSource,
    /onOpenNewChatTab:[\s\S]*ipcRenderer\.on\('open-new-chat-tab', \(_event, payload\) => callback\(payload\)\)/,
  );
  assert.match(
    ipcSource,
    /ipcMain\.handle\("request-open-new-chat-tab"[\s\S]*safeWebContentsSend\([\s\S]*"open-new-chat-tab"[\s\S]*requestId[\s\S]*options: normalizedOptions/s,
  );
  assert.match(
    ipcSource,
    /ipcMain\.on\("complete-open-new-chat-tab-request"[\s\S]*event\.sender\.id !== mainWindow\.webContents\.id[\s\S]*settleNewChatTabRequest/s,
  );
  assert.match(
    indexSource,
    /onOpenNewChatTab\(\(payload = \{\}\)[\s\S]*window\.openNewChatTab\?\.\(options\)[\s\S]*completeOpenNewChatTabRequest\?\.\(\{/s,
  );
});

test('new-chat URLs encode prompt and model options without persisting one-shot submission state', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const homeUrlDeclaration = chatTabSource.match(
    /const OPEN_WEBUI_HOME_URL = [^;]+;/,
  )?.[0];
  const helperSource = chatTabSource.match(
    /function buildNewChatUrl\(options = \{\}\) \{[\s\S]*?\n\}/,
  )?.[0];
  const normalizeSource = chatTabSource.match(
    /const SHELL_ONLY_OWUI_URL_PARAMS = new Set\([\s\S]*?\);[\s\S]*?function normalizeOwuiShellUrl\(rawUrl, fallbackUrl = 'http:\/\/localhost:3789'\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(homeUrlDeclaration && helperSource && normalizeSource);

  const context = { URL };
  context.window = { location: { origin: 'http://localhost:3789' } };
  vm.runInNewContext(
    `${homeUrlDeclaration}\n${helperSource}\n${normalizeSource}\n` +
      'this.buildNewChatUrl = buildNewChatUrl; this.normalizeOwuiShellUrl = normalizeOwuiShellUrl;',
    context,
  );

  const promptOnly = new URL(context.buildNewChatUrl({
    prompt: 'Help me set up Snowflake',
  }));
  assert.equal(promptOnly.searchParams.get('q'), 'Help me set up Snowflake');
  assert.equal(promptOnly.searchParams.get('submit'), 'true');
  assert.equal(promptOnly.searchParams.has('models'), false);

  const modelOnly = new URL(context.buildNewChatUrl({ modelId: 'agent/id + 1' }));
  assert.equal(modelOnly.searchParams.get('models'), 'agent/id + 1');
  assert.equal(modelOnly.searchParams.has('q'), false);
  assert.equal(modelOnly.searchParams.has('submit'), false);

  const combined = context.buildNewChatUrl({
    modelId: 'snowflake-agent',
    prompt: 'Help me set up Snowflake',
  });
  const combinedUrl = new URL(combined);
  assert.equal(combinedUrl.searchParams.get('models'), 'snowflake-agent');
  assert.equal(combinedUrl.searchParams.get('q'), 'Help me set up Snowflake');
  assert.equal(combinedUrl.searchParams.get('submit'), 'true');

  const persisted = new URL(context.normalizeOwuiShellUrl(combined));
  assert.equal(persisted.searchParams.get('models'), 'snowflake-agent');
  assert.equal(persisted.searchParams.has('q'), false);
  assert.equal(persisted.searchParams.has('submit'), false);
});

test('tab context menu uses a native popup and hides unavailable permanent-tab actions', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const preloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'preload.js',
  );
  const ipcSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'ipc.js',
  );

  assert.equal(
    preloadSource.includes("showTabContextMenu: (payload) => ipcRenderer.invoke('show-tab-context-menu', payload)"),
    true,
    'renderer preload should expose a native tab context menu bridge',
  );
  assert.equal(
    ipcSource.includes('ipcMain.handle("show-tab-context-menu", (event, payload = {}) => {'),
    true,
    'main process should build the native tab context menu on demand',
  );
  assert.equal(
    tabBarSource.includes('function buildContextMenuPayload(fullTabId, isPermanent, x, y) {'),
    true,
    'tab bar should compute per-tab context menu capabilities before opening the native popup',
  );
  assert.equal(
    tabBarSource.includes('canRename: !isPermanent || RENAMEABLE_PERMANENT_TABS.has(tabId),'),
    true,
    'the native context menu should keep rename available for Chat while suppressing it for other permanent tabs',
  );
  assert.equal(
    tabBarSource.includes('canDetach: !isPermanent,'),
    true,
    'permanent tabs should suppress detach actions in the native context menu payload',
  );
});

test('dragging a dynamic tab outside the strip detaches it into a window', () => {
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const windowsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'windows.js',
  );

  assert.equal(
    tabBarSource.includes('const DRAG_DETACH_THRESHOLD_PX = 48;'),
    false,
    'tab tear-off should no longer require an extra drag buffer before a release outside the strip detaches the tab',
  );
  assert.equal(
    tabBarSource.includes("const detachBoundsSource = strip.closest('.tab-bar-container') || strip;"),
    true,
    'tab tear-off should use the visible tab bar bounds when deciding whether the pointer has left the tab area',
  );
  assert.equal(
    tabBarSource.includes("source: 'drag-out'"),
    true,
    'tab tear-off should identify drag-out detaches explicitly',
  );
  assert.equal(
    tabBarSource.includes('window.detachConversationTab(conversationId, {'),
    true,
    'tear-off should route through the existing detachConversationTab flow',
  );
  assert.equal(
    windowsSource.includes('screen.getDisplayNearestPoint(dropPoint)'),
    true,
    'detached conversation windows should place tear-off windows near the drop display',
  );
});

test('search navigation uses the shared safe message reveal helper with top clearance', () => {
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const sidebarSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'Sidebar.svelte',
  );
  const chatSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Chat.svelte',
  );
  const navigationSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'utils',
    'messageNavigation.ts',
  );
  const appCssSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'app.css',
  );

  assert.equal(
    searchModalSource.includes("revealMessageWithRetry(messageId);"),
    true,
    'search modal should delegate message reveal to the shared helper instead of duplicating raw scrollIntoView logic',
  );
  assert.equal(
    sidebarSource.includes("revealMessageWithRetry(messageId);"),
    true,
    'sidebar navigation events should reuse the shared helper for safe message reveal',
  );
  assert.equal(
    searchModalSource.includes('function scrollToMessageWithRetry('),
    false,
    'search modal should stop carrying its own raw scroll-to-message helper now that message reveal is centralized',
  );
  assert.equal(
    sidebarSource.includes('function scrollToMessageWithRetry('),
    false,
    'sidebar navigation should stop carrying its own raw scroll-to-message helper now that message reveal is centralized',
  );
  assert.equal(
    chatSource.includes('revealMessageElement(messageElement as HTMLElement'),
    true,
    'in-chat message reveal paths should share the same safe scrolling helper for consistent geometry',
  );
  assert.equal(
    navigationSource.includes('container.scrollTo({'),
    true,
    'shared message navigation should scroll the messages container directly so sticky-header clearance is predictable',
  );
  assert.equal(
    appCssSource.includes('--message-navigation-clearance'),
    true,
    'chat styles should expose a shared top-clearance variable for safe message reveal',
  );
  assert.equal(
    appCssSource.includes('scroll-padding-top: var(--message-navigation-clearance);'),
    true,
    'messages container should reserve top padding for navigation jumps under the sticky header',
  );
});

test('local/global search shortcuts and the new-window shortcut are routed through the shell and active OWUI views', () => {
  const mainSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'main.js',
  );
  const bootstrapSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'bootstrap.js',
  );
  const windowsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'windows.js',
  );
  const chatPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  const shellPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'preload.js',
  );
  const findBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'find-bar.js',
  );
  const chatSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Chat.svelte',
  );
  const messageInputSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'MessageInput.svelte',
  );
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const navbarSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Navbar.svelte',
  );
  const conversationWindowSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'conversation-window.js',
  );
  const messagesSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Messages.svelte',
  );
  const searchConversationsMenuSource = bootstrapSource.slice(
    bootstrapSource.indexOf("label: 'Search Conversations\\u2026'"),
    bootstrapSource.indexOf("label: 'Find in Current Chat'"),
  );
  const findInCurrentChatMenuSource = bootstrapSource.slice(
    bootstrapSource.indexOf("label: 'Find in Current Chat'"),
    bootstrapSource.indexOf("label: 'Find Next in Current Chat'"),
  );
  const findNextMenuSource = bootstrapSource.slice(
    bootstrapSource.indexOf("label: 'Find Next in Current Chat'"),
    bootstrapSource.indexOf("label: 'Find Previous in Current Chat'"),
  );

  assert.equal(
    mainSource.includes('function isLocalSearchShortcut(input) {'),
    true,
    'main shortcut routing should define the local in-chat search accelerator separately',
  );
  assert.equal(
    mainSource.includes('function isFindNextShortcut(input) {'),
    true,
    'main shortcut routing should define the forward find-next accelerator separately',
  );
  assert.equal(
    mainSource.includes('function isGlobalSearchShortcut(input) {'),
    true,
    'main shortcut routing should define the global cross-chat search accelerator separately',
  );
  assert.equal(
    mainSource.includes('function isFindPrevShortcut(input) {'),
    true,
    'main shortcut routing should define the reverse find-prev accelerator separately',
  );
  assert.equal(
    mainSource.includes('function isNewChatWindowShortcut(input) {'),
    true,
    'main shortcut routing should define a dedicated new chat window accelerator',
  );
  assert.equal(
    mainSource.includes('function getShortcutOwnerWindow() {'),
    true,
    'main shortcut routing should normalize focused native local-find overlays back to their owning chat windows',
  );
  assert.equal(
    mainSource.includes('return isKeyDown(input, "f") && !input.shift && !input.alt && isCmdOrCtrl(input);'),
    true,
    'Cmd/Ctrl+F should be the browser-like local-find accelerator in the shell layer',
  );
  assert.equal(
    mainSource.includes('return isKeyDown(input, "g") && input.shift === true && !input.alt && isCmdOrCtrl(input);'),
    true,
    'Shift+Cmd/Ctrl+G should stay available for reverse local-find navigation',
  );
  assert.equal(
    mainSource.includes('return isKeyDown(input, "g") && !input.shift && !input.alt && isCmdOrCtrl(input);'),
    true,
    'Cmd/Ctrl+G should be the forward local-find navigation accelerator',
  );
  assert.equal(
    mainSource.includes('return isKeyDown(input, "f") && input.shift === true && !input.alt && isCmdOrCtrl(input);'),
    true,
    'Shift+Cmd/Ctrl+F should be the global conversation-search accelerator',
  );
  assert.equal(
    mainSource.includes('openNewChatWindow();'),
    true,
    'Cmd/Ctrl+Shift+N should open a new chat window from the shell layer',
  );
  assert.equal(
    mainSource.includes('const targetWin = getShortcutOwnerWindow();'),
    true,
    'local and global search shortcuts should resolve through the owning chat window when a native find overlay has focus',
  );
  assert.equal(
    mainSource.includes('targetWin.webContents.send("find-in-page-open");'),
    true,
    'Cmd/Ctrl+F should send find-in-page-open to open or restore the local find overlay without advancing',
  );
  assert.equal(
    mainSource.includes('targetWin.webContents.send("find-in-page-next");'),
    true,
    'Cmd/Ctrl+G should send find-in-page-next to advance to the next local find match',
  );
  assert.equal(
    mainSource.includes('targetWin.webContents.send("find-in-page-prev");'),
    true,
    'reverse local find should also trigger the shell-owned overlay in the owning window renderer',
  );
  assert.equal(
    bootstrapSource.includes("accelerator: 'CmdOrCtrl+Shift+N'"),
    true,
    'the application menu should expose the new chat window shortcut',
  );
  assert.equal(
    bootstrapSource.includes("label: 'Search Conversations\\u2026'"),
    true,
    'the Edit menu should keep a dedicated global cross-chat search entry',
  );
  assert.equal(
    searchConversationsMenuSource.includes("accelerator: 'Shift+CmdOrCtrl+F'"),
    true,
    'the Edit menu should bind global conversation search to Shift+Cmd/Ctrl+F',
  );
  assert.equal(
    mainSource.includes('const activeViewKey = owuiViews.getActiveViewKeyForWindow(targetWin.id);'),
    true,
    'the shell shortcut path should resolve the active OWUI view key before restoring focus for global search',
  );
  assert.equal(
    mainSource.includes('void owuiViews.focusView(activeViewKey).catch(() => {});'),
    true,
    'the shell shortcut path should hand focus back to the active OWUI view when Shift+CMD+F opens cross-chat search',
  );
  assert.equal(
    bootstrapSource.includes("const activeViewKey = owuiViews.getActiveViewKeyForWindow(targetWin.id);"),
    true,
    'the Edit menu global-search entry should also resolve the active OWUI view before restoring focus',
  );
  assert.equal(
    bootstrapSource.includes("void owuiViews.focusView(activeViewKey).catch(() => {});"),
    true,
    'the Edit menu global-search entry should also hand focus back to the active OWUI view',
  );
  assert.equal(
    bootstrapSource.includes("label: 'Find in Current Chat'"),
    true,
    'the Edit menu should advertise local in-chat search explicitly',
  );
  assert.equal(
    findInCurrentChatMenuSource.includes("accelerator: 'CmdOrCtrl+F'"),
    true,
    'the Edit menu should bind local in-chat search to Cmd/Ctrl+F',
  );
  assert.equal(
    bootstrapSource.includes("label: 'Find Next in Current Chat'"),
    true,
    'the Edit menu should expose forward local-find navigation explicitly',
  );
  assert.equal(
    findNextMenuSource.includes("accelerator: 'CmdOrCtrl+G'"),
    true,
    'the Edit menu should bind forward local find to Cmd/Ctrl+G',
  );
  assert.equal(
    bootstrapSource.includes("label: 'Find Previous in Current Chat'"),
    true,
    'the Edit menu should also expose reverse local-find navigation explicitly',
  );
  assert.equal(
    bootstrapSource.includes("accelerator: 'Shift+CmdOrCtrl+G'"),
    true,
    'the Edit menu should bind reverse local find to Shift+Cmd/Ctrl+G',
  );
  assert.equal(
    bootstrapSource.includes("const { resolveLocalFindOwnerWindow } = require('./windows');"),
    true,
    'the Edit menu should resolve a focused native local-find overlay back to the owning chat window',
  );
  assert.equal(
    bootstrapSource.includes("targetWin.webContents.send('find-in-page-open');"),
    true,
    'the Edit menu Find in Current Chat should send find-in-page-open to open or restore without advancing',
  );
  assert.equal(
    bootstrapSource.includes("targetWin.webContents.send('find-in-page-next');"),
    true,
    'the Edit menu Find Next should send find-in-page-next to advance the match',
  );
  assert.equal(
    bootstrapSource.includes("targetWin.webContents.send('find-in-page-prev');"),
    true,
    'the Edit menu should route reverse local find through the owning shell renderer as well',
  );
  assert.equal(
    shellPreloadSource.includes("ipcRenderer.on('find-in-page-open',"),
    true,
    'the shell preload should bridge the find-in-page-open IPC event for CMD+F restore behavior',
  );
  assert.equal(
    chatPreloadSource.includes("ipcRenderer.on('trigger-local-search', () => {"),
    false,
    'the OWUI preload should no longer carry the retired local-search bridge',
  );
  assert.equal(
    chatSource.includes('<LocalChatSearch />'),
    false,
    'the in-chat search surface should no longer add a separate overlay row inside Chat.svelte',
  );
  assert.equal(
    navbarSource.includes('LocalChatSearch'),
    false,
    'the chat navbar should stop mounting the retired OWUI local-search overlay',
  );
  assert.equal(
    chatPreloadSource.includes('const localFindBar = new OwuiLocalFindBar();'),
    false,
    'the OWUI preload should no longer instantiate the retired in-page local-find overlay',
  );
  assert.equal(
    chatPreloadSource.includes('class OwuiLocalFindBar {'),
    false,
    'the OWUI preload should fully drop the retired in-page local-find UI implementation',
  );
  assert.equal(
    chatPreloadSource.includes('pendingSelfMatchSkip'),
    false,
    'the OWUI preload should drop the retired self-hit normalization state entirely',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPageNext(this._boundOnFindInPageNext);'),
    true,
    'the shell-owned local find overlay should receive CMD+G triggers in the shell renderer',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPagePrev(this._boundOnFindInPagePrev);'),
    true,
    'the shell-owned local find overlay should receive Shift+CMD+G triggers in the shell renderer',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI.onFindInPageResult(this._boundOnFindResult);'),
    true,
    'the shell-owned local find overlay should update its counter from native find results in the shell renderer',
  );
  assert.equal(
    findBarSource.includes("document.getElementById('temporary-chat-button')"),
    true,
    'the shell-owned local find overlay should still anchor off the temporary-chat action region when present',
  );
  assert.equal(
    findBarSource.includes("document.getElementById('chat-context-menu-button')"),
    true,
    'the shell-owned local find overlay should still avoid overlapping the chat menu action region',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI?.localFindOverlay?.sync'),
    true,
    'the shell-owned local find controller should sync a separate native overlay instead of rendering visible chrome inline',
  );
  assert.equal(
    findBarSource.includes("case 'query-change':"),
    true,
    'the shell-owned local find controller should accept text input updates from the native overlay window',
  );
  assert.equal(
    findBarSource.includes("window.addEventListener('focus', this._boundOnWindowFocus);"),
    true,
    'the shell-owned local find controller should re-sync the overlay when the shell window regains focus',
  );
  assert.equal(
    findBarSource.includes("case 'next':"),
    true,
    'the shell-owned local find controller should still expose next-match navigation through the native overlay actions',
  );
  assert.equal(
    findBarSource.includes("case 'prev':"),
    true,
    'the shell-owned local find controller should still expose previous-match navigation through the native overlay actions',
  );
  assert.equal(
    findBarSource.includes('window.electronAPI?.owui?.executeJavaScript'),
    true,
    'the shell-owned local find overlay should query the active OWUI view on demand for placement and hidden-history expansion',
  );
  assert.equal(
    findBarSource.includes('this.visible && this.retainFocus'),
    true,
    'the shell-owned local find overlay should suppress shell-driven OWUI refocus only while its input still owns focus',
  );
  assert.equal(
    findBarSource.includes("case 'release-focus':"),
    true,
    'the shell-owned local find controller should release focus ownership when the native overlay blurs',
  );
  assert.equal(
    findBarSource.includes("const OWUI_LOCAL_FIND_HISTORY_REQUEST_EVENT = 'portico-local-find-history-request';"),
    true,
    'the shell-owned local find overlay should continue using the one-shot hidden-history expansion bridge',
  );
  assert.equal(
    findBarSource.includes('window.setOwuiViewportInset'),
    false,
    'the shell-owned local find overlay should not reintroduce the old viewport-inset row reservation',
  );
  assert.equal(
    findBarSource.includes("root.dataset["),
    true,
    'the shell-owned local find overlay should publish local-find visibility back into the active OWUI view so other search surfaces can yield focus',
  );
  assert.equal(
    windowsSource.includes('function resolveLocalFindOwnerWindow(windowRef) {'),
    true,
    'window lifecycle management should expose an owner-window resolver for focused native local-find overlays',
  );
  assert.equal(
    windowsSource.includes('const activeViewKey = owuiViews.getActiveViewKeyForWindow(ownerWindow.id);'),
    true,
    'closing the native local-find overlay should look up the owning window active OWUI view before restoring keyboard focus',
  );
  assert.equal(
    windowsSource.includes('void owuiViews.focusView(activeViewKey).catch(() => {'),
    true,
    'closing the native local-find overlay should hand focus back to the active OWUI chat view so CMD+F modals stay interactive',
  );
  assert.equal(
    findBarSource.includes('window.switchTab = wrappedSwitchTab;'),
    true,
    'the shell-owned local find overlay should restore the correct per-view search session when main-window chat tabs change',
  );
  assert.equal(
    findBarSource.includes("this.hide('tab-switch');"),
    true,
    'switching tabs while local find is visible should close the CMD+G overlay immediately',
  );
  assert.equal(
    findBarSource.includes("document.querySelector('.tab-bar-container')?.getBoundingClientRect().bottom"),
    true,
    'local-find overlay placement should remain below the tab strip so the overlay cannot block tab-switch hit targets',
  );
  assert.equal(
    findBarSource.includes('_focusInputWithRetry'),
    false,
    'the shell-owned local find controller should no longer focus an inline DOM input now that the visible chrome lives in a native overlay window',
  );
  assert.equal(
    messagesSource.includes("const LOCAL_FIND_HISTORY_REQUEST_EVENT = 'portico-local-find-history-request';"),
    true,
    'the transcript should still listen for local-find history expansion requests from the shell-owned overlay bridge',
  );
  assert.equal(
    messagesSource.includes('const getLocalFindHistoryExpansionCount = ('),
    true,
    'the transcript should calculate how much older history to reveal for forward and backward local-find navigation',
  );
  assert.equal(
    messagesSource.includes("window.addEventListener(LOCAL_FIND_HISTORY_REQUEST_EVENT, requestListener as EventListener);"),
    true,
    'the transcript should install a local-find-only history expansion listener',
  );
  assert.equal(
    messageInputSource.includes("document.documentElement?.dataset?.porticoLocalFindActive === 'true'"),
    true,
    'the standard chat composer should skip its normal window-focus autofocus while local find is open',
  );
  assert.equal(
    searchModalSource.includes("new CustomEvent('portico-global-search-visibility-changed', { detail: { active: show } })"),
    true,
    'global search should continue broadcasting its visibility for search-surface coordination',
  );
  assert.equal(
    searchModalSource.includes("'portico-local-find-visibility-changed'"),
    true,
    'global search should listen for local-find visibility changes from the shell-owned overlay bridge',
  );
  assert.equal(
    searchModalSource.includes("document.documentElement?.dataset?.porticoLocalFindActive === 'true'"),
    true,
    'global search should honor the shared local-find active flag before focusing its own input',
  );
  assert.equal(
    conversationWindowSource.includes('window.electronAPI.setupFindInPageForwarding().catch(() => {});'),
    true,
    'detached chat windows should set up native find result forwarding for their adopted OWUI view',
  );
});

test('active OWUI view registration waits until the visible chat view has attached', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const conversationWindowSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'conversation-window.js',
  );

  assert.equal(
    chatTabSource.includes(
      'async function attachOwuiViewAndSyncActiveKey(webview, tabName, conversationId = null) {',
    ),
    true,
    'chat tabs should wait for the OWUI host facade to finish attaching before publishing the active view key',
  );
  assert.equal(
    chatTabSource.includes('attachedState = await webview.attachOwuiView();'),
    true,
    'main and conversation tabs should explicitly await OWUI host attachment before syncing active-view ownership',
  );
  assert.equal(
    chatTabSource.includes('window.appState?.activeTab === tabName'),
    true,
    'late OWUI attachment should only claim the active-view slot if that tab is still the visible tab',
  );
  assert.equal(
    chatTabSource.includes("void attachOwuiViewAndSyncActiveKey(webview, 'chat');"),
    true,
    'the main chat should retry active-view registration after its OWUI host attaches so search shortcuts work on first load',
  );
  assert.equal(
    chatTabSource.includes('`conversation-${conversationId}`'),
    true,
    'conversation tabs should reuse the late-attachment active-view sync path with their own per-tab view key',
  );
  assert.equal(
    conversationWindowSource.includes('const attachedState = await activeWebview.attachOwuiView();'),
    true,
    'detached chat windows should also await view attachment before they sync active-view ownership',
  );
  assert.equal(
    conversationWindowSource.includes('syncDetachedWindowActiveView();'),
    true,
    'detached chat windows should republish their active view after the OWUI host has actually attached',
  );
});

test('dynamic chat tabs keep the New Chat placeholder until a real title arrives', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );

  assert.equal(
    chatTabSource.includes("const GENERIC_TAB_TITLES = new Set(['open webui', 'Portico', 'chat']);"),
    true,
    'chat tabs should treat generic shell titles as placeholders rather than real conversation titles',
  );
  assert.equal(
    chatTabSource.includes('const title = normalizeConversationTabTitle(e.detail?.title || e.title);'),
    true,
    'page-title updates should normalize shell titles before overwriting tab labels',
  );
});

test('chat search keeps structured assistant output opt-in and message updates resync search index', () => {
  const searchSource = readRepoFile(
    'src',
    'patches',
    'backend',
    'open_webui',
    'utils',
    'chat_search.py',
  );
  const chatsRouterSource = readRepoFile(
    'src',
    'patches',
    'backend',
    'open_webui',
    'routers',
    'chats.py',
  );

  assert.equal(
    searchSource.includes('def _build_message_search_content(msg: dict) -> str:'),
    false,
    'search indexing should no longer flatten visible and structured message content into one blob',
  );
  assert.equal(
    searchSource.includes('def _build_message_search_content(msg: dict) -> tuple[str, str]:'),
    true,
    'search indexing should split visible and structured message content into separate searchable columns',
  );
  assert.equal(
    searchSource.includes('content_blocks = msg.get("contentBlocks") or []'),
    true,
    'search indexing should inspect persisted contentBlocks for structured assistant output',
  );
  assert.equal(
    searchSource.includes('if has_content_blocks:'),
    true,
    'search indexing should skip the raw content string when contentBlocks are present so HTML-rendered tool calls stay out of body_content',
  );
  assert.equal(
    searchSource.includes('_SEARCH_VERSION = "11"'),
    true,
    'schema changes should force a versioned reindex of existing chats',
  );
  assert.equal(
    searchSource.includes('CREATE TABLE IF NOT EXISTS chat_search_conversations') &&
      searchSource.includes('user_content') &&
      searchSource.includes('assistant_content'),
    true,
    'search indexing should maintain one conversation-level row per chat with B-tree indexes',
  );
  assert.equal(
    searchSource.includes('instr(lower('),
    true,
    'default search queries should use instr() substring matching for case-insensitive search',
  );
  assert.equal(
    searchSource.includes('def _prepare_display_text(content: str) -> str:'),
    true,
    'snippet rendering should normalize encoded entities before building highlighted previews',
  );
  assert.equal(
    searchSource.includes('html.escape(preview, quote=False)'),
    true,
    'snippet rendering should avoid surfacing escaped quote entities in visible search results',
  );
  assert.equal(
    searchSource.includes('def _coerce_chat_payload(raw_chat, chat_id: str) -> Optional[dict]:'),
    true,
    'search population should sanitize raw persisted chat payloads before indexing',
  );
  assert.equal(
    searchSource.includes('def _get_next_index_batch(') &&
      searchSource.includes('ORDER BY {order_clause}') &&
      searchSource.includes('chat_search_progress'),
    true,
    'search population should incrementally track progress and select source chats newest-first',
  );
  assert.equal(
    searchSource.includes('start_background_indexing_if_needed()'),
    true,
    'message search requests should start background indexing without awaiting a full-corpus rebuild',
  );
  assert.equal(
    searchSource.includes('message_count = _write_chat_index_rows') &&
      searchSource.includes('INSERT_SEARCH_CONVERSATION_SQL') &&
      searchSource.includes('_record_chat_progress('),
    true,
    'committed indexed chats should record both message and conversation rows while indexing continues',
  );
  assert.equal(
    searchSource.includes('def _search_text(') &&
      searchSource.includes('instr(') &&
      searchSource.includes('chat_search_conversations'),
    true,
    'literal message search should use instr() substring matching against conversation-level rows',
  );
  assert.equal(
    searchSource.includes('def _search_regex('),
    true,
    'regex search should use a bounded candidate scan instead of an unbounded fetchall',
  );
  assert.equal(
    chatsRouterSource.includes('sync_chat_to_search(id, user.id, chat.chat if isinstance(chat.chat, dict) else {})'),
    true,
    'message-level updates should resync the owning chat into the search index',
  );
  assert.equal(
    chatsRouterSource.includes('def sync_imported_chats_to_search(chats: list[Any], fallback_user_id: str) -> None:'),
    true,
    'chat router should define a shared search sync helper for imported chats',
  );
  assert.equal(
    (chatsRouterSource.match(/sync_imported_chats_to_search\(chats, user\.id\)/g) || []).length,
    3,
    'imports and both clone flows should resync newly created chats into the search index',
  );
  assert.equal(
    chatsRouterSource.includes('status.HTTP_503_SERVICE_UNAVAILABLE'),
    true,
    'backend search failures should surface a retryable HTTP status instead of pretending the result set is empty',
  );
  assert.equal(
    chatsRouterSource.includes('include_agent_traces'),
    false,
    'the chat search router should not expose include_agent_traces since it is not used in the UI',
  );
  assert.equal(
    chatsRouterSource.includes('title_html: str = ""') &&
      chatsRouterSource.includes('title_matched: bool = False') &&
      chatsRouterSource.includes('next_cursor: Optional[str] = None') &&
      chatsRouterSource.includes('regex_budget_exhausted: bool = False'),
    true,
    'the search endpoint should return server-side title highlighting and cursor pagination',
  );
  assert.equal(
    chatsRouterSource.includes('class MessageSearchIndexStatus(BaseModel):') &&
      chatsRouterSource.includes('index_status: MessageSearchIndexStatus'),
    true,
    'message search responses should expose index progress separately from backend failure state',
  );
});

test('search modal supports grouped results, preview clicks, and explicit double-click navigation', () => {
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const apiSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'apis',
    'chatSearch.ts',
  );
  const appCssSource = readRepoFile('src', 'patches', 'frontend', 'src', 'app.css');
  const messagesSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Messages.svelte',
  );
  const messageSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Messages',
    'Message.svelte',
  );
  const userMessageSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Messages',
    'UserMessage.svelte',
  );
  const defaultModeSource = searchModalSource.slice(
    searchModalSource.indexOf('<!-- Default mode: show recent chats -->'),
    searchModalSource.indexOf('<!-- Search results mode -->'),
  );

  assert.equal(
    searchModalSource.includes('chatTitle: result.chatTitle'),
    true,
    'grouped result snippets should carry their target conversation title into direct navigation',
  );
  assert.equal(
    searchModalSource.includes('Search chats and messages...'),
    true,
    'search modal should advertise title and message search from the primary input',
  );
  assert.equal(
    searchModalSource.includes("import SearchInput from './Sidebar/SearchInput.svelte';"),
    false,
    'search modal should own its input instead of delegating to the older dual-surface SearchInput path',
  );
  assert.equal(
    searchModalSource.includes('const SEARCH_OPTION_HINTS = ['),
    false,
    'search modal should remove the static Search Tips widget entirely',
  );
  assert.equal(
    searchModalSource.includes('Search Tips'),
    false,
    'search modal should not render a Search Tips section above recent chats',
  );
  assert.equal(
    searchModalSource.includes('showSuggestionsPanel ='),
    true,
    'search modal should still derive recent-search visibility from state',
  );
  assert.equal(
    searchModalSource.includes('searchInputFocused && !hasActiveQuery && searchHistory.length > 0;'),
    true,
    'empty-query suggestions should render only when stored search history exists',
  );
  assert.equal(
    searchModalSource.includes('search-suggestions-panel'),
    true,
    'search modal should keep the stored Recent Searches panel under the search field',
  );
  assert.equal(
    searchModalSource.includes('function commitCurrentSearchToHistory()'),
    true,
    'search modal should have an explicit completed-search history commit path',
  );
  assert.equal(
    searchModalSource.includes('saveSearchHistory(requestedQuery);'),
    false,
    'debounced live search should not save partial in-progress queries as recent searches',
  );
  assert.match(
    searchModalSource,
    /const loadChatPreview = async \(chatId: string \| null(?:, messageId\?: string)?\) => \{[\s\S]*?if \(hasActiveQuery\) \{\n\s*commitCurrentSearchToHistory\(\);\n\s*\}/,
    'single-clicking a left-side search result should commit the completed search before loading preview',
  );
  assert.match(
    searchModalSource,
    /async function navigateToMessage\([\s\S]*?\) \{\n\s*commitCurrentSearchToHistory\(\);/,
    'opening a matched message should commit the completed search to recent searches',
  );
  assert.match(
    searchModalSource,
    /async function navigateToChat\([\s\S]*?\) \{\n\s*commitCurrentSearchToHistory\(\);/,
    'opening a matched chat should commit the completed search to recent searches',
  );
  assert.match(
    searchModalSource,
    /else if \(inputFocused && hasActiveQuery && searchDebounceTimeout\) \{[\s\S]*?commitCurrentSearchToHistory\(\);[\s\S]*?searchHandler\(\{ immediate: true \}\);/,
    'pressing Enter in the focused input with an active pending search should commit the completed query before forcing search',
  );
  assert.equal(
    searchModalSource.includes('Start a new conversation'),
    false,
    'search modal should no longer render the unused new-conversation action',
  );
  assert.equal(
    searchModalSource.includes("{$i18n.t('Actions')}"),
    false,
    'search modal should no longer reserve an Actions section above recent chats',
  );
  assert.doesNotMatch(
    searchModalSource,
    /\.search-suggestions-panel\s*{[^}]*position:\s*absolute/s,
    'recent search suggestions should stay inline so they push recent chat sections down instead of overlaying them',
  );
  assert.equal(
    searchModalSource.includes("import Tooltip from '../common/Tooltip.svelte';"),
    true,
    'search option toggles should use real Tooltip chrome instead of native title-only hints',
  );
  assert.equal(
    searchModalSource.includes("<Tooltip content={$i18n.t('Match capitalization exactly')} placement=\"bottom\">") &&
      searchModalSource.includes("aria-label={$i18n.t('Match capitalization exactly')}"),
    true,
    'the Aa toggle should explain its case-sensitive behavior through tooltip and aria-label text',
  );
  assert.equal(
    searchModalSource.includes("<Tooltip content={$i18n.t('Use regular expression syntax')} placement=\"bottom\">") &&
      searchModalSource.includes("aria-label={$i18n.t('Use regular expression syntax')}"),
    true,
    'the regex toggle should explain its pattern-search behavior through tooltip and aria-label text',
  );
  assert.equal(
    searchModalSource.includes('title="Case sensitive"') ||
      searchModalSource.includes('title="Regular expression"'),
    false,
    'search option toggles should not rely on bare native title attributes',
  );
  assert.equal(
    defaultModeSource.includes('void loadChatPreview(chat.id);'),
    true,
    'single-clicking a recent chat should load that chat into the preview pane',
  );
  assert.equal(
    defaultModeSource.includes('on:dblclick={() => {') &&
      defaultModeSource.includes('navigateToChat(chat.id, {'),
    true,
    'double-clicking a recent chat should open the target conversation',
  );
  assert.equal(
    defaultModeSource.includes('on:mouseenter'),
    false,
    'hovering recent chats should not mutate selection or trigger preview loading',
  );
  assert.equal(
    searchModalSource.includes('hideUserMessageCopy={true}'),
    true,
    'search preview should opt into hiding user-message copy actions while preserving response copy',
  );
  assert.equal(
    searchModalSource.includes('topPadding={true}'),
    true,
    'search preview should pass topPadding just like the real chat transcript',
  );
  assert.match(
    searchModalSource,
    /id="chat-preview"[\s\S]*class="[^"]*@container[^"]*"/,
    'search preview should be a container-query root so response model logos render like the real chat',
  );
  assert.equal(
    searchModalSource.includes('normalizeSelectedModelIds('),
    true,
    'search preview should normalize selectedModels to the same array shape used by Chat.svelte',
  );
  assert.equal(
    appCssSource.includes(':is(#messages-container, #chat-preview) .prose') &&
      appCssSource.includes(':is(#messages-container, #chat-preview) .markdown-prose') &&
      appCssSource.includes(':is(#messages-container, #chat-preview) :is(.message-tool-block, .message-thought-block)'),
    true,
    'chat transcript typography and tool/thought spacing rules should also apply inside the search preview',
  );
  assert.equal(
    messagesSource.includes('export let hideUserMessageCopy = false;') &&
      messagesSource.includes('{hideUserMessageCopy}'),
    true,
    'Messages should expose a defaulted preview-only user copy suppression prop',
  );
  assert.equal(
    messageSource.includes('export let hideUserMessageCopy = false;') &&
      messageSource.includes('hideCopyAction={hideUserMessageCopy}'),
    true,
    'Message should pass preview-only user copy suppression down only to UserMessage',
  );
  assert.equal(
    userMessageSource.includes('export let hideCopyAction = false;') &&
      userMessageSource.includes('{#if message?.content && !hideCopyAction}'),
    true,
    'UserMessage should hide only its copy action when the search preview opts in',
  );
  assert.equal(
    apiSource.includes('include_agent_traces'),
    false,
    'chat search API client should not expose include_agent_traces since it is not used in the UI',
  );
  assert.equal(
    apiSource.includes('export interface ChatSearchIndexStatus {') &&
      apiSource.includes("state: 'ready' | 'building' | 'stale' | 'error';") &&
      apiSource.includes('index_status: ChatSearchIndexStatus;'),
    true,
    'chat search API client should type backend index progress separately from result data',
  );
  assert.equal(
    apiSource.includes('next_cursor: string | null;') &&
      apiSource.includes('regex_budget_exhausted: boolean;') &&
      apiSource.includes("cursor?: string;"),
    true,
    'chat search API client should support cursor-based pagination and search response fields',
  );
  assert.equal(
    searchModalSource.includes('const SEARCH_TYPING_DEBOUNCE_MS = 120;') &&
      searchModalSource.includes('let searchRequestSeq = 0;') &&
      searchModalSource.includes('isCurrentSearchRequest(requestId, requestedQuery)'),
    true,
    'search modal should use a short debounce and ignore stale async search responses',
  );
  assert.equal(
    searchModalSource.includes('const res = await searchChatMessages(localStorage.token') &&
      searchModalSource.includes('let nextCursor: string | null = null;') &&
      searchModalSource.includes('let regexBudgetExhausted = false;'),
    true,
    'search modal should use search with cursor-based pagination',
  );
  assert.equal(
    searchModalSource.includes('let searchResults: SearchResult[] = [];'),
    true,
    'search modal should build a conversation-level result list from search response',
  );
  assert.equal(
    searchModalSource.includes('Include Agent Traces'),
    false,
    'search modal should not expose the structured agent trace search option as a user-facing filter',
  );
  assert.equal(
    searchModalSource.includes('include_agent_traces:'),
    false,
    'search modal should leave backend structured-output search support default-off by not sending the option',
  );
  assert.equal(
    searchModalSource.includes(
      'function getSearchSummaryText(results: SearchResult[])',
    ),
    true,
    'search modal summary should use search results only',
  );
  assert.equal(
    searchModalSource.includes('&#8984;F Find in chat') &&
      searchModalSource.includes('&#8679;&#8984;F Search') &&
      searchModalSource.includes('title="CMD+F: Find in current chat"') &&
      searchModalSource.includes('title="Shift+CMD+F: Search conversations"'),
    true,
    'search modal shortcut hints should reflect Cmd+F local find and Shift+Cmd+F global search',
  );
  assert.equal(
    searchModalSource.includes('class="search-filter-row px-4 flex items-center gap-1.5 flex-wrap"') &&
      searchModalSource.includes('.search-filter-row {') &&
      searchModalSource.includes('padding-bottom: 0.75rem;') &&
      searchModalSource.includes('.search-index-status {\n\t\tmargin: 0 0 0.75rem;'),
    true,
    'filter pills should have breathing room and partial-index status should align to the same left edge',
  );
  assert.equal(
    searchModalSource.includes('{#if !hasActiveQuery}\n\t\t\t\t\t<!-- Default mode: show recent chats -->') &&
      !searchModalSource.includes('{#if !hasActiveQuery}\n\t\t\t\t<div\n\t\t\t\t\tid="chat-preview"'),
    true,
    'the preview pane should remain available while active search results are showing',
  );
  assert.equal(
    searchModalSource.includes('void loadChatPreview(result.chatId);') &&
      searchModalSource.includes('navigateToChat(result.chatId, {') &&
      searchModalSource.includes('navigateToMessage(result.chatId, match.message_id, {'),
    true,
    'single-clicking search results should preview while double-click handlers perform navigation',
  );
  assert.equal(
    searchModalSource.includes('let messageSearchIndexStatus: ChatSearchIndexStatus | null = null;') &&
      searchModalSource.includes('search-index-status') &&
      searchModalSource.includes('Indexing conversations... {{indexed}}/{{total}} indexed. Results may be partial.'),
    true,
    'search modal should surface partial indexing status without treating it as a request failure',
  );
  assert.equal(
    searchModalSource.includes('schedulePartialIndexRefresh(query.trim());') &&
      searchModalSource.includes('refreshPartialMessageResults(expectedQuery)'),
    true,
    'search modal should quietly refresh current message results while background indexing is still partial',
  );
  assert.equal(
    searchModalSource.includes('Searching messages...') &&
      searchModalSource.includes('messageSearchError && searchResults.length === 0') &&
      searchModalSource.includes('searchHandler({ immediate: true });'),
    true,
    'search modal should keep visible results during refreshes and reserve the large retry state for empty failures',
  );
  assert.match(
    searchModalSource,
    /else if \(e\.code === 'Enter'\) \{\s+e\.preventDefault\(\);\s+e\.stopPropagation\(\);/m,
    'the Enter path should prevent default behavior and stop bubbling before handling history, pending searches, or selections',
  );
});

test('search surfaces and active tabs share the same accent token family', () => {
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const appCssSource = readRepoFile('src', 'patches', 'frontend', 'src', 'app.css');
  const preloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  const findBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'find-bar.js',
  );
  const overlayWindowHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'local-find-overlay.html',
  );
  const stylesSource = readRepoFile('electron-app', 'src', 'styles.css');

  assert.equal(
    appCssSource.includes('--portico-accent-text: #003a9b;'),
    true,
    'OWUI search styling should declare the shared light-mode accent tokens',
  );
  assert.equal(
    appCssSource.includes('--portico-accent-text: #4f94ff;'),
    true,
    'OWUI search styling should declare the shared dark-mode accent tokens',
  );
  assert.equal(
    searchModalSource.includes('var(--portico-accent-fill'),
    true,
    'global search UI should consume the shared accent token family instead of hardcoded blue variants',
  );
  assert.equal(
    overlayWindowHtmlSource.includes('var(--portico-accent-fill'),
    true,
    'local in-chat find should consume the same accent token family as global search',
  );
  assert.equal(
    findBarSource.includes('var(--portico-accent-fill'),
    false,
    'the shell controller should no longer carry visual accent styling once the visible chrome moves into the native overlay renderer',
  );
  assert.equal(
    preloadSource.includes('var(--portico-accent-fill'),
    false,
    'the retired preload-owned local-find surface should no longer carry shell accent styling',
  );
  assert.equal(
    stylesSource.includes('--portico-search-surface: rgba(255, 255, 255, 0.96);'),
    true,
    'the shell light-theme search surface should match the global search palette',
  );
  assert.equal(
    stylesSource.includes('--portico-search-surface: rgba(23, 23, 23, 0.96);'),
    true,
    'the shell dark-theme search surface should match the global search palette',
  );
  assert.equal(
    stylesSource.includes('--header-active-tab-bg: var(--portico-accent-fill);'),
    true,
    'the active shell tab should use the same shared accent fill token as the search surfaces',
  );
});

test('search modal surfaces backend failures instead of silently returning an empty result set', () => {
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const apiSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'apis',
    'chatSearch.ts',
  );

  assert.equal(
    apiSource.includes('export class ChatSearchRequestError extends Error {'),
    true,
    'the chat search client should raise a dedicated error when the backend rejects a search request',
  );
  assert.equal(
    apiSource.includes('throw new ChatSearchRequestError(message, { status: res.status });'),
    true,
    'the chat search client should throw instead of silently mapping backend failures to empty results',
  );
  assert.equal(
    searchModalSource.includes('let messageSearchError: string | null = null;'),
    true,
    'the search modal should track backend search failures separately from empty result sets',
  );
  assert.equal(
    searchModalSource.includes('Retry search'),
    true,
    'the search modal should expose a retry affordance when the backend search request fails',
  );
});

test('search modal places infinite-scroll after the layout branch', () => {
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );

  assert.equal(
    searchModalSource.includes('{#each searchResults as result, idx}'),
    true,
    'pagination loader should continue to sit below the result list so conversation cards can infinite-scroll message matches',
  );
});

test('tab busy state is driven by OWUI activity events without polling', () => {
  const preloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  const ipcSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'ipc.js',
  );
  const hostSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'owui-host.js',
  );
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );
  const stylesSource = readRepoFile('electron-app', 'src', 'styles.css');
  const indexHtmlSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'views',
    'index.html',
  );
  const chatSvelteSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Chat.svelte',
  );

  assert.equal(
    preloadSource.includes('function reportTabActivity(payload = {}) {'),
    true,
    'OWUI preload should expose a reportTabActivity bridge',
  );
  assert.equal(
    ipcSource.includes('ipcMain.on("owui-tab-activity", (event, payload = {}) => {'),
    true,
    'main process should translate OWUI busy-state reports into owner-window events',
  );
  assert.equal(
    hostSource.includes('case "tab-activity-changed":'),
    true,
    'OWUI host should forward tab activity changes as DOM events on the host element',
  );
  assert.equal(
    chatTabSource.includes("function setTabBusyState(tabId, busy, phase = 'idle', currentChatId = null) {"),
    true,
    'chat shell should maintain per-tab busy state from activity events',
  );
  assert.equal(
    tabBarSource.includes('const TAB_BUSY_BLOCK_DURATION_MS = 1050;'),
    true,
    'tab busy block synchronization should use the same duration as the CSS animation',
  );
  assert.equal(
    tabBarSource.includes("btn.style.setProperty('--tab-busy-animation-delay', getSynchronizedBusyAnimationDelay());"),
    true,
    'newly busy tabs should join the shared building-block animation phase',
  );
  assert.equal(
    tabBarSource.includes("btn.style.removeProperty('--tab-busy-animation-delay');"),
    true,
    'tabs should clear the synchronized building-block offset when no longer busy',
  );
  assert.equal(
    chatTabSource.includes('function setTabUnreadState(tabId, unread) {'),
    true,
    'chat shell should maintain unread state for background tabs without adding polling',
  );
  assert.equal(
    chatTabSource.includes('function setTabAttentionRequiredState(tabId, required, _details = {}) {') &&
      chatTabSource.includes('window.setChatTabAttentionRequired = setTabAttentionRequiredState;'),
    true,
    'chat shell should expose attention-required state through the same tab-bar status path',
  );
  assert.equal(
    chatTabSource.includes('setTabUnreadState(tabId, true);'),
    true,
    'background tabs should flip into an unread state when work completes off-screen',
  );
  assert.equal(
    chatTabSource.includes('window.backendModalAttention?.drainForTab?.(tabId);'),
    true,
    'switching tabs should drain pending agentic modals for the newly active chat tab',
  );
  assert.equal(
    chatTabSource.includes(
      'window.McpOperationOverlayController?.handleActiveTabChange?.(tabName);',
    ),
    true,
    'switching tabs should re-evaluate MCP operation modal visibility for the newly active tab',
  );
  assert.equal(
    chatSvelteSource.includes('window.webviewHost?.reportTabActivity?.({') &&
      chatSvelteSource.includes('chatId: normalizedChatId,') &&
      chatSvelteSource.includes('title: normalizedTitle'),
    true,
    'chat UI should report busy/idle transitions, the canonical chat ID, and its title through the preload bridge',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.busy \.tab-busy-blocks\s*\{[^}]*display:\s*grid;[^}]*\}/s,
    'busy tabs should render the building-block loader in the existing tab icon slot',
  );
  assert.match(
    stylesSource,
    /\.tab-busy-blocks > span\s*\{[^}]*animation:\s*mcp-operation-block-pulse 1\.05s ease-in-out infinite;[^}]*\}/s,
    'tab activity should reuse the MCP modal building-block animation',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.busy \.tab-icon::after/,
    'busy tabs should no longer draw the legacy circular spinner',
  );
  assert.match(
    stylesSource,
    /\.conversation-window-action-btn\.is-busy svg\s*\{[^}]*animation:\s*conversation-window-action-spin 2\.4s linear infinite;[^}]*\}/s,
    'detached conversation header action spinner should match the slower tab spinner cadence',
  );
  assert.equal(
    stylesSource.includes('animation-delay: var(--tab-busy-animation-delay, 0ms);'),
    true,
    'busy tab blocks should align to the synchronized per-tab animation offset',
  );
  assert.doesNotMatch(
    stylesSource,
    /\.tab-btn\.busy \.tab-status-indicator\s*\{/,
    'busy tabs should not render a separate trailing status spinner',
  );
  assert.equal(
    stylesSource.includes('.tab-status-indicator {'),
    true,
    'tabs should render a dedicated status badge that can also show unread dots',
  );
  assert.match(
    tabBarSource,
    /const visible =\s*btn\.classList\.contains\('unread'\)\s*\|\|\s*btn\.classList\.contains\('attention-required'\);[\s\S]*indicator\.classList\.toggle\('hidden', !visible\);/s,
    'the trailing status indicator should be visible for unread or attention-required state, not busy state',
  );
  assert.equal(
    tabBarSource.includes('function setAttentionRequired(tabId, required) {') &&
      tabBarSource.includes("btn.classList.toggle('attention-required', required === true);") &&
      tabBarSource.includes('setAttentionRequired,'),
    true,
    'tab-bar should extend the existing unread indicator API with an attention-required state',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.attention-required:not\(\.active\)\s*\{[^}]*animation:\s*tab-attention-pulse 1\.8s ease-in-out infinite;[^}]*\}/s,
    'background tabs needing user action should pulse subtly instead of adding a new badge surface',
  );
  assert.match(
    stylesSource,
    /\.tab-btn\.attention-required \.tab-status-indicator\s*\{[^}]*background:\s*#f97316;/s,
    'attention-required tabs should reuse the existing status indicator lane as an orange dot',
  );
  assert.equal(
    tabBarSource.includes('<span class="tab-icon">${icon}${TAB_BUSY_BLOCKS_HTML}</span>') &&
      indexHtmlSource.includes('<span class="tab-busy-blocks" aria-hidden="true">'),
    true,
    'permanent and dynamic tab markup should include four-block activity loaders',
  );
  assert.equal(
    tabBarSource.includes('<span class="tab-status-indicator hidden" aria-hidden="true"></span>'),
    true,
    'tab markup should retain the trailing unread indicator lane for layout parity',
  );
});

test('conversation tab unloading keeps active, busy, and user-attention tabs mounted', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const indexSource = readRepoFile('electron-app', 'src', 'renderer', 'views', 'index.js');
  const stateSource = readRepoFile('electron-app', 'src', 'renderer', 'state.js');
  const tabBarSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'tab-bar.js',
  );

  assert.equal(
    chatTabSource.includes('const BACKGROUND_TAB_UNLOAD_GRACE_MS = 15 * 60 * 1000;') &&
      chatTabSource.includes('const BACKGROUND_TAB_WARM_CACHE_LIMIT = 1;'),
    true,
    'background tab unloading should use the 15 minute grace period and one warm inactive tab',
  );
  assert.match(
    chatTabSource,
    /function isConversationTabUnloadProtected\(conversationId,[\s\S]*activeFullTabId === `conversation-\$\{conversationId\}`[\s\S]*meta\.busy === true[\s\S]*meta\.attentionRequired === true[\s\S]*getPendingModalCountForTab\(conversationId\) > 0/s,
    'active, busy, attention-required, and pending-modal tabs should be ineligible for unload',
  );
  assert.equal(
    chatTabSource.includes('function ensureConversationWebviewMounted(conversationId, options = {}) {') &&
      chatTabSource.includes('window.ensureConversationWebviewMounted = ensureConversationWebviewMounted;'),
    true,
    'conversation webview mounting should be centralized for tab switch and restore paths',
  );
  assert.equal(
    chatTabSource.includes("artifactWrapper.className = 'chat-and-artifact-wrapper';") &&
      chatTabSource.includes('artifactWrapper.dataset.artifactTabKey = `conversation-${conversationId}`;') &&
      chatTabSource.includes('window.artifactPanel?.activateForCurrentTab?.(tabName);'),
    true,
    'conversation tabs should be artifact-panel capable and activate their own attached artifact slot on switch',
  );
  assert.equal(
    chatTabSource.includes('conversation.webviewElement = null;') &&
      chatTabSource.includes('suspendedTabs.add(conversationId);') &&
      chatTabSource.includes('Unloaded background tab: ${conversationId} (${reason})'),
    true,
    'unloading should destroy the native view while preserving tab metadata for later remount',
  );
  assert.equal(
    chatTabSource.includes('options.deferLoad !== true || options.attentionRequired === true') &&
      chatTabSource.includes('ensureConversationWebviewMounted(conversationId, { navigationUrl });'),
    true,
    'background restored tabs should stay metadata-only unless they need user attention',
  );
  assert.equal(
    chatTabSource.includes('updateConversationTabActiveTimestamps(tabName);') &&
      chatTabSource.includes('maybeUnloadBackgroundTabs(tabName);'),
    true,
    'tab switches should update idle timers and run unload eligibility',
  );
  assert.equal(
    indexSource.includes('deferLoad: meta.attentionRequired !== true,') &&
      indexSource.includes('attentionRequired: meta.attentionRequired === true,'),
    true,
    'persisted restore should defer ordinary background tab loads while preserving attention state',
  );
  assert.equal(
    stateSource.includes('attentionRequired: meta.attentionRequired === true,') &&
      stateSource.includes('unread: meta.unread === true,'),
    true,
    'tab persistence should carry unread and attention state across shell restore',
  );
  assert.equal(
    tabBarSource.includes('unread: options.unread === true,') &&
      tabBarSource.includes('attentionRequired: options.attentionRequired === true,'),
    true,
    'tab creation should apply restored unread and attention flags to tab metadata',
  );
});

test('search result routing reuses an open tab or opens the correct shell tab before reveal', () => {
  const ipcSource = readRepoFile('electron-app', 'src', 'services', 'ipc.js');
  const preloadSource = readRepoFile('electron-app', 'src', 'services', 'preload.js');
  const viewPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const indexSource = readRepoFile('electron-app', 'src', 'renderer', 'views', 'index.js');
  const searchModalSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'SearchModal.svelte',
  );
  const sidebarSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'layout',
    'Sidebar.svelte',
  );

  assert.equal(
    viewPreloadSource.includes("async function navigateToConversation(chatId, messageId, options = {}) {"),
    true,
    'the OWUI preload should forward navigation metadata along with the target chat and message',
  );
  assert.equal(
    searchModalSource.includes('title: options.chatTitle ?? undefined'),
    true,
    'search result navigation should forward the target conversation title into the shell bridge',
  );
  assert.equal(
    ipcSource.includes('targetWindow.webContents.send(\n      "open-conversation-tab",') &&
      ipcSource.includes('targetUrl.toString(),\n      normalizedChatId,'),
    true,
    'the main process should open the correct conversation tab when the target chat is not already open',
  );
  assert.equal(
    ipcSource.includes('targetUrl.searchParams.set("portico-target-message", normalizedMessageId);'),
    true,
    'newly opened result tabs should receive a one-shot target-message hint for in-chat reveal',
  );
  assert.equal(
    preloadSource.includes("ipcRenderer.on('open-conversation-tab', (event, url, conversationId, options) =>"),
    true,
    'the shell preload should preserve open-conversation-tab metadata for the renderer',
  );
  assert.equal(
    indexSource.includes('window.openConversationTabOrReuseActive(url, conversationId, options);'),
    true,
    'the renderer should route shell-opened search results through the tab-cap-aware helper',
  );
  assert.equal(
    chatTabSource.includes('async function openConversationTabOrReuseActive(url, conversationId, options = {})') &&
      chatTabSource.includes('if (canOpenAdditionalConversationTab(conversationId, state))') &&
      chatTabSource.includes('const opened = openConversationTab(url, conversationId, options);') &&
      chatTabSource.includes('return reuseActiveChatTabForConversation(url, conversationId, options);'),
    true,
    'search-result routing should preserve normal open/reuse behavior before falling back to active-tab reuse at the cap',
  );
  assert.equal(
    chatTabSource.includes('if (state?.conversationTabs?.[conversationId])') &&
      chatTabSource.includes('return true;') &&
      chatTabSource.includes('getVisibleTabCountForCapCheck(state) < maxVisibleTabs'),
    true,
    'already-open target chats should be reused before the visible-tab cap blocks new tabs',
  );
  assert.equal(
    chatTabSource.includes("const targetTab = activeTab?.startsWith('conversation-') ? activeTab : 'chat';") &&
      chatTabSource.includes("if (targetTab === 'chat')") &&
      chatTabSource.includes('return reuseMainChatTabForConversation(url, options);') &&
      chatTabSource.includes('return reuseConversationTabForConversation(targetTab, url, options);'),
    true,
    'the tab-cap fallback should reuse the active conversation tab and fall back to the permanent chat tab for non-chat surfaces',
  );
  assert.equal(
    chatTabSource.includes('updateReusedChatTabMetadata(slotId, targetUrl, options);') &&
      chatTabSource.includes("meta.customTitle = null;") &&
      chatTabSource.includes("setTabBusyState(tabId, false, 'idle');") &&
      chatTabSource.includes('setTabUnreadState(tabId, false);') &&
      chatTabSource.includes('setTabAttentionRequiredState(tabId, false);'),
    true,
    'reusing a tab should retitle it from the search result and clear stale activity indicators',
  );
  assert.equal(
    chatTabSource.includes('await webview.loadURL(targetUrl);') &&
      chatTabSource.includes('webview.src = targetUrl;') &&
      chatTabSource.includes('syncConversationUrlState(slotId, targetUrl);'),
    true,
    'fallback tab reuse should load the full target URL, preserving one-shot message reveal parameters while storing normalized tab state',
  );
  assert.equal(
    sidebarSource.includes("url.searchParams.delete('portico-target-message');"),
    true,
    'the target chat should consume and clear the one-shot message reveal marker after navigation',
  );
});

test('detach flows reuse the live OWUI view identity and current conversation URL', () => {
  const chatTabSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'chat-tab.js',
  );
  const hostSource = readRepoFile(
    'electron-app',
    'src',
    'renderer',
    'components',
    'owui-host.js',
  );

  assert.equal(
    chatTabSource.includes("const liveUrl = getLiveOwuiUrl(ensuredWebview, conversation.url || 'http://localhost:3789');"),
    true,
    'conversation-tab detach should use the live OWUI URL instead of the stale stored tab URL',
  );
  assert.equal(
    chatTabSource.includes("viewKey: liveViewKey,"),
    true,
    'main-chat detach should move the live view key into the detached window instead of synthesizing a fresh identity',
  );
  assert.equal(
    chatTabSource.includes("tabType === 'chat' && resolvedViewKey === 'main'"),
    true,
    'returning a detached main chat should reattach into the permanent Chat tab rather than opening a new dynamic tab',
  );
  assert.equal(
    chatTabSource.includes('createReplacementMainChatView();'),
    true,
    'detaching the permanent Chat view should create a fresh replacement view for the main shell instead of reloading the moved session',
  );
  assert.equal(
    hostSource.includes('hostStateByViewKey.delete(previousViewKey);'),
    true,
    'retargeting an OWUI host to a replacement view key should clear the old key mapping first',
  );
});

test('OWUI slim-build guard still strips the heavy frontend code-execution paths', () => {
  const dockerfileSource = readRepoFile('Dockerfile.open-webui-patched');
  const slimScriptSource = readRepoFile('src', 'scripts', 'slim-openwebui-frontend.cjs');

  assert.equal(
    dockerfileSource.includes('RUN node /build/src/scripts/slim-openwebui-frontend.cjs /build'),
    true,
    'the patched Open WebUI image should keep running the slim frontend hook during the build',
  );
  assert.equal(
    slimScriptSource.includes("import PyodideWorker from '$lib/workers/pyodide.worker?worker';"),
    true,
    'the slimmer should keep removing Pyodide worker imports from the frontend bundle inputs',
  );
  assert.equal(
    slimScriptSource.includes("let engines = ['jupyter'];"),
    true,
    'the slimmer should keep code-execution settings narrowed to the Jupyter-only path',
  );
});

test('Cmd+G is scoped via the Custom Highlight API controller and bridged through chat preload', () => {
  // Chat.svelte marks the scoping root the in-page controller looks for;
  // without it the controller would fall through to scanning the whole
  // document and re-introduce the E-10 sidebar/nav leakage.
  const chatSvelteSource = readRepoFile(
    'src',
    'patches',
    'frontend',
    'src',
    'lib',
    'components',
    'chat',
    'Chat.svelte',
  );
  assert.equal(
    chatSvelteSource.includes('data-portico-chat-root="true"'),
    true,
    '#messages-container must declare data-portico-chat-root so the in-page local-find controller has a transcript-only scope',
  );

  // The page IIFE that the controller injects MUST query that exact root and
  // exclude the editor / mathml mirror surfaces called out in test plan
  // E-13/E-14.
  const pageSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-local-find-page.js',
  );
  assert.match(
    pageSource,
    /\[data-portico-chat-root="true"\]/,
    'in-page local-find controller must scope its TreeWalker to data-portico-chat-root',
  );
  for (const exclude of ['textarea', 'input', '[data-portico-find-exclude]', '.katex-mathml', '.sr-only']) {
    assert.equal(
      pageSource.includes(exclude),
      true,
      `in-page local-find controller must exclude ${exclude} from the search corpus`,
    );
  }
  assert.match(
    pageSource,
    /CSS\.highlights/,
    'in-page local-find controller must feature-detect CSS.highlights so the native fallback can engage',
  );

  // Host-side bridge wiring: the chat-webview preload turns
  // portico-portico-local-find-update window events into ipc.send so MutationObserver
  // updates can reach the shell-side find-bar counter (E-11 streaming gate).
  const chatPreloadSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'chat-webview-preload.js',
  );
  assert.match(
    chatPreloadSource,
    /addEventListener\('portico-portico-local-find-update'/,
    'chat-webview-preload must forward portico-portico-local-find-update window events',
  );
  assert.match(
    chatPreloadSource,
    /ipcRenderer\.send\('owui-portico-local-find-update'/,
    'chat-webview-preload must bridge local-find updates over the owui-portico-local-find-update ipc channel',
  );

  // Main-process router: receives the preload signal and forwards through the
  // unchanged found-in-page-result channel so find-bar.js does not need to
  // know which engine produced the count.
  const ipcSource = readRepoFile('electron-app', 'src', 'services', 'ipc.js');
  assert.match(
    ipcSource,
    /ipcMain\.on\("owui-portico-local-find-update"/,
    'ipc.js must register a handler for owui-portico-local-find-update',
  );
  assert.match(
    ipcSource,
    /owuiViews\.deliverHighlightUpdateForContents/,
    'ipc.js must forward Highlight-API updates through owuiViews.deliverHighlightUpdateForContents',
  );

  const owuiViewsSource = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-views.js',
  );
  assert.match(
    owuiViewsSource,
    /require\("\.\/owui-local-find-controller"\)/,
    'owui-views must consume the local-find controller bridge',
  );
  assert.match(
    owuiViewsSource,
    /PORTICO_DISABLE_portico_LOCAL_FIND/,
    'owui-views must expose an PORTICO_DISABLE_portico_LOCAL_FIND escape hatch for the native fallback',
  );
  assert.match(
    owuiViewsSource,
    /"highlight"/,
    'owui-views must tag highlight-engine sessions so deliverHighlightUpdateForContents can gate updates',
  );
  assert.match(
    owuiViewsSource,
    /session\.engine !== "highlight"/,
    'deliverHighlightUpdateForContents must gate updates on engine === highlight to avoid cross-engine pollution',
  );
  assert.match(
    owuiViewsSource,
    /deliverHighlightUpdateForContents/,
    'owui-views must export deliverHighlightUpdateForContents',
  );

  // B1 regression: once a session has fallen back to native, owui-views must
  // short-circuit subsequent findInPage calls to nativeFindInPage instead of
  // re-attempting the highlight engine. Otherwise every keystroke pays an
  // executeJavaScript round-trip that we know will fail, AND
  // deliverHighlightUpdateForContents drops streaming updates because the
  // session engine reads "native".
  assert.match(
    owuiViewsSource,
    /existingSession\?\.engine === "native"/,
    'findInPage must short-circuit to nativeFindInPage when the session has already fallen back to native (B1)',
  );

  // B2 regression: the in-page IIFE must rebind the MutationObserver on each
  // search call, so a remounted [data-portico-chat-root] (e.g. conversation
  // navigation within the same WebContentsView) doesn't leave the observer
  // bound to a detached root.
  const pageSourceB2 = readRepoFile(
    'electron-app',
    'src',
    'services',
    'owui-local-find-page.js',
  );
  assert.match(
    pageSourceB2,
    /stopObserver\(state\);\s*\n\s*startObserver\(state\);/,
    'in-page local-find search() must stopObserver before startObserver so a remounted chat root rebinds (B2)',
  );
});
