const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const conversationWindowScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'conversation-window.js',
);
const conversationWindowHtml = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'conversation-window.html',
);
const chatTabScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'chat-tab.js',
);
const tabBarScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'tab-bar.js',
);
const windowsService = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'windows.js',
);
const ipcService = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'ipc.js',
);
const preloadService = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'preload.js',
);
const owuiViewsService = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'owui-views.js',
);
const owuiHostScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'components',
  'owui-host.js',
);
const indexViewScript = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'index.js',
);
const indexViewHtml = path.join(
  repoRoot,
  'electron-app',
  'src',
  'renderer',
  'views',
  'index.html',
);
const shellStylesheet = path.join(
  repoRoot,
  'electron-app',
  'src',
  'styles.css',
);
const detachedConversationDockPolicy = path.join(
  repoRoot,
  'electron-app',
  'src',
  'services',
  'detached-conversation-dock-policy.js',
);

test('detached conversation recovery no longer creates legacy webview elements', () => {
  const source = fs.readFileSync(conversationWindowScript, 'utf8');
  assert.equal(
    source.includes('document.createElement("webview")'),
    false,
    'detached conversation recovery should stay on the OWUI host path',
  );
});

test('detached subagent windows carry semantic identity alongside detached-window state', () => {
  const source = fs.readFileSync(conversationWindowScript, 'utf8');
  assert.equal(
    source.includes('url.searchParams.set("detached-window", "subagent")'),
    true,
    'detached subagent viewers should tag the inner OWUI route',
  );
  assert.equal(
    source.includes('url.searchParams.set("subagent-view", "1")'),
    true,
    'detached subagent viewers should preserve chat identity independently of window state',
  );
  assert.equal(
    source.includes('normalized.searchParams.set("subagent-view", "1")'),
    true,
    'explicit redocking should add the stable subagent identity before removing detached metadata',
  );
  assert.equal(
    source.includes('normalized.searchParams.delete("subagent-view")'),
    false,
    'explicit redocking must not strip semantic subagent identity',
  );
});

test('detached chat windows reuse provided conversation view keys but keep a detached fallback', () => {
  const source = fs.readFileSync(conversationWindowScript, 'utf8');
  assert.equal(
    source.includes('const providedViewKey = params.get("viewKey") || "";'),
    true,
    'detached conversation windows should accept an explicit live OWUI view key when one is provided',
  );
  assert.equal(
    source.includes('providedViewKey ||'),
    true,
    'detached conversation windows should prefer the provided live view key before falling back',
  );
  assert.equal(
    source.includes('`detached-chat:${conversationId || "main"}`'),
    true,
    'main chat detach should still fall back to its own detached OWUI view key',
  );
  assert.equal(
    source.includes('const hostWindowType = viewKey.startsWith("conversation:")'),
    true,
    'adopted conversation tabs should keep the conversation OWUI host behavior after detach',
  );
  assert.equal(
    source.includes('windowType: hostWindowType,'),
    true,
    'detached windows should pass the normalized OWUI host type to ensureOwuiHost',
  );
});

test('main chat detach opens a detached window and restores the main host to home', () => {
  const source = fs.readFileSync(chatTabScript, 'utf8');
  const dynamicDetachBlock = source.slice(
    source.indexOf('async function detachConversationTab('),
    source.indexOf('// Detach main chat tab'),
  );
  const mainDetachBlock = source.slice(
    source.indexOf('async function detachMainChatTab()'),
    source.indexOf('function setupChatDetachButton()'),
  );

  assert.equal(
    dynamicDetachBlock.includes('viewKey: liveViewKey'),
    true,
    'dynamic conversation tabs should pass their live OWUI view key so detach can adopt the existing view',
  );
  assert.equal(
    mainDetachBlock.includes('viewKey: liveViewKey'),
    true,
    'main chat detach should pass its live OWUI view key so the detached window adopts the existing session',
  );
  assert.equal(
    mainDetachBlock.includes('const adopted = await waitForOwuiViewAttachment(liveViewKey, result.windowId);'),
    false,
    'main chat detach should not wait for detached-window adoption of the live OWUI view',
  );
  assert.equal(
    mainDetachBlock.includes("const detachedId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;"),
    true,
    'main chat detach should use a fresh detached chat id',
  );
  assert.equal(
    mainDetachBlock.includes("createReplacementMainChatView();"),
    true,
    'main chat detach should rebuild the permanent Chat host after a successful detach instead of reloading the moved session',
  );
});

test('detached conversation windows return the live OWUI session only through the explicit button', () => {
  const conversationSource = fs.readFileSync(conversationWindowScript, 'utf8');
  const htmlSource = fs.readFileSync(conversationWindowHtml, 'utf8');
  const chatTabSource = fs.readFileSync(chatTabScript, 'utf8');
  const tabBarSource = fs.readFileSync(tabBarScript, 'utf8');
  const ipcSource = fs.readFileSync(ipcService, 'utf8');
  const preloadSource = fs.readFileSync(preloadService, 'utf8');
  const owuiViewsSource = fs.readFileSync(owuiViewsService, 'utf8');
  const owuiHostSource = fs.readFileSync(owuiHostScript, 'utf8');
  const indexSource = fs.readFileSync(indexViewScript, 'utf8');
  const indexHtmlSource = fs.readFileSync(indexViewHtml, 'utf8');
  const stylesSource = fs.readFileSync(shellStylesheet, 'utf8');

  assert.equal(
    htmlSource.includes('id="conversation-return-to-tab-btn"'),
    true,
    'detached conversation windows should render a Return to Tab action',
  );
  assert.equal(
    htmlSource.includes('conversation-window-titlebar-actions'),
    false,
    'detached conversation windows should no longer render a second titlebar action row below the safe-area strip',
  );
  assert.equal(
    htmlSource.includes('conversation-window-title-text'),
    true,
    'detached conversation windows should render the detached chat title inside the reused header strip',
  );
  assert.equal(
    htmlSource.includes('conversation-window-toolbar'),
    false,
    'detached conversation windows should no longer reserve a full toolbar row for the fallback attach action',
  );
  assert.equal(
    conversationSource.includes('window.electronAPI.attachConversationToMain({'),
    false,
    'detached conversation windows should reuse the shared attach payload builder instead of duplicating inline payload assembly',
  );
  assert.equal(
    conversationSource.includes('function buildConversationAttachPayload()'),
    true,
    'detached conversation windows should centralize their reattach payload construction',
  );
  assert.equal(
    conversationSource.includes('const detachedWindowTitleEl = document.getElementById("conversation-window-title-text");'),
    true,
    'detached conversation windows should wire the visible detached title text element',
  );
  assert.equal(
    conversationSource.includes('function applyDetachedWindowTitle(nextTitle, options = {}) {'),
    true,
    'detached conversation windows should centralize visible-title updates before syncing the BrowserWindow title',
  );
  assert.equal(
    conversationSource.includes('function startDetachedTitleRename() {'),
    true,
    'detached conversation windows should support inline title editing from the reused header strip',
  );
  assert.equal(
    conversationSource.includes('detachedWindowTitleEl.addEventListener("dblclick", (event) => {'),
    true,
    'detached conversation windows should start title editing from a double-click on the centered title',
  );
  assert.equal(
    conversationSource.includes('function normalizeComparableConversationUrl(rawUrl)'),
    true,
    'detached conversation windows should compare effective conversation URLs instead of exact shell-decorated strings',
  );
  assert.equal(
    conversationSource.includes('!areConversationUrlsEquivalent(currentUrl, targetUrl)'),
    true,
    'detached conversation windows should avoid reloading when the adopted view already matches the same effective conversation route',
  );
  assert.equal(
    conversationSource.includes('url: buildAttachTargetUrl(),'),
    true,
    'detached conversation windows should normalize the active URL before reattaching to a tab',
  );
  assert.equal(
    conversationSource.includes('viewKey,'),
    true,
    'detached conversation windows should preserve the live OWUI view key when returning to a tab',
  );
  assert.equal(
    chatTabSource.includes('const resolvedViewKey = viewKey || `conversation:${conversationId}`;'),
    true,
    'main-window conversation tabs should accept an explicit detached OWUI view key during reattach',
  );
  assert.equal(
    chatTabSource.includes("window.attachDetachedConversationToTab = attachDetachedConversationToTab;"),
    true,
    'chat tabs should expose a renderer helper for detached-window reattach events',
  );
  assert.equal(
    ipcSource.includes('ipcMain.handle("conversation-attach", async (event, payload = {}) => {'),
    true,
    'the main process should provide a dedicated conversation attach IPC handler',
  );
  assert.equal(
    conversationSource.includes('returnToTabBtn.addEventListener("click", () => {'),
    true,
    'the detached-window redock button should be the renderer action that starts reattachment',
  );
  assert.equal(
    conversationSource.includes('window.electronAPI.attachConversationToMain('),
    true,
    'the redock button should submit the live attach payload directly to the main process',
  );
  assert.equal(
    fs.existsSync(detachedConversationDockPolicy),
    false,
    'the retired native drag-return policy should not remain in the source tree',
  );
  assert.equal(
    ipcSource.includes('registerDetachedConversationWindowDragHandlers'),
    false,
    'detached windows should not register native move handlers for drag-return',
  );
  assert.equal(
    ipcSource.includes('detachedWindow.on("move"'),
    false,
    'moving a detached window should never trigger reattachment logic',
  );
  assert.equal(
    ipcSource.includes('detachedWindow.on("moved"'),
    false,
    'finishing a detached-window move should never trigger reattachment logic',
  );
  assert.equal(
    ipcSource.includes('detached-conversation-drop-target-bounds'),
    false,
    'the main process should not accept drag-only drop-target bounds',
  );
  assert.equal(
    ipcSource.includes('detached-conversation-drag-state'),
    false,
    'the main process should not broadcast drag-only hover state',
  );
  assert.equal(
    ipcSource.includes('request-conversation-attach-payload'),
    false,
    'the main process should not request attach payloads in response to window movement',
  );
  assert.equal(
    ipcSource.includes('mainWindow.webContents.send("attach-detached-conversation", attachPayload);'),
    true,
    'conversation attach should signal the main renderer before closing the detached window',
  );
  assert.equal(
    preloadSource.includes('attachConversationToMain: (payload = {}) =>'),
    true,
    'preload should expose the detached-window attach request to renderer code',
  );
  assert.equal(
    preloadSource.includes('setDetachedConversationWindowTitle: (title) =>'),
    true,
    'preload should expose detached-window title updates back to the main process',
  );
  assert.equal(
    ipcSource.includes('ipcMain.handle("detached-conversation-set-title", (event, title) => {'),
    true,
    'the main process should provide a dedicated detached-window title sync handler',
  );
  assert.equal(
    stylesSource.includes('.conversation-window-title-input'),
    true,
    'detached conversation styling should provide an inline title editor inside the existing header strip',
  );
  assert.match(
    stylesSource,
    /\.platform-darwin\s+\.conversation-window-titlebar-fill\s*\{[^}]*flex:\s*0 0 var\(--mac-main-header-height\);[^}]*height:\s*var\(--mac-main-header-height\);[^}]*\}/s,
    'detached conversation styling should size the titlebar fill to the shared main macOS header height',
  );
  assert.equal(
    owuiViewsSource.includes('const OWUI_SHELL_ONLY_SEARCH_PARAMS = new Set(['),
    true,
    'OWUI view ownership should keep a dedicated shell-only search-param allowlist for route comparisons',
  );
  assert.equal(
    owuiViewsSource.includes('"portico-target-message"'),
    true,
    'OWUI view ownership should ignore one-shot message-target metadata when comparing adoptable routes',
  );
  assert.equal(
    owuiViewsSource.includes('"detached-window"'),
    true,
    'OWUI view ownership should treat detached-window metadata as shell-only when comparing routes for adoption',
  );
  assert.equal(
    chatTabSource.includes("searchParams.delete('subagent-view')"),
    false,
    'tab persistence should retain semantic subagent identity',
  );
  assert.equal(
    owuiHostSource.includes('searchParams.delete("subagent-view")'),
    false,
    'OWUI view adoption should retain semantic subagent identity',
  );
  assert.equal(
    owuiViewsSource.includes('if (areOwuiUrlsEquivalent(currentUrl, targetUrl)) {'),
    true,
    'OWUI view adoption should no-op instead of loadURL when the existing document already matches the same conversation route',
  );
  assert.equal(
    owuiHostSource.includes('!areOwuiUrlsEquivalent(explicitUrl, currentUrl)'),
    true,
    'renderer OWUI host adoption should skip redundant loadUrl IPC when only shell-only URL metadata differs',
  );
  assert.equal(
    chatTabSource.includes('async function replaceAttachedOwuiShellUrlInPlace(webview, rawTargetUrl)'),
    true,
    'redocking should reconcile the adopted live view to its shell-clean target URL',
  );
  assert.equal(
    chatTabSource.includes(
      'window.history.replaceState(window.history.state, document.title, target.href);',
    ),
    true,
    'redocking should remove shell-only URL state in place instead of reloading the adopted conversation',
  );
  assert.equal(
    chatTabSource.match(/await replaceAttachedOwuiShellUrlInPlace\([^;]+;/g)?.length,
    2,
    'both main-chat and conversation-tab redocking should clear shell-only URL state',
  );
  assert.equal(
    preloadSource.includes('sendConversationAttachPayloadResponse: (requestId, payload = {}) =>'),
    false,
    'preload should not expose the retired drag-only attach-payload response',
  );
  assert.equal(
    preloadSource.includes('setDetachedConversationDropTargetBounds: (payload = {}) =>'),
    false,
    'preload should not expose drag-only drop-target bounds reporting',
  );
  assert.equal(
    preloadSource.includes('onAttachDetachedConversation: (callback) => {'),
    true,
    'preload should expose the main-window attach event subscription',
  );
  assert.equal(
    preloadSource.includes('onDetachedConversationDragState: (callback) => {'),
    false,
    'preload should not expose detached-window drag state updates',
  );
  assert.equal(
    preloadSource.includes('onRequestConversationAttachPayload: (callback) => {'),
    false,
    'preload should not expose drag-only attach-payload requests',
  );
  assert.equal(
    conversationSource.includes('onRequestConversationAttachPayload'),
    false,
    'detached renderers should not answer attach-payload requests from native window movement',
  );
  assert.equal(
    indexSource.includes('window.attachDetachedConversationToTab(payload);'),
    true,
    'the main renderer should route attach events through the chat-tab reattach helper',
  );
  assert.equal(
    indexSource.includes('setupDetachedConversationDropTarget()'),
    false,
    'the main renderer should not initialize a detached-window return drop target',
  );
  assert.equal(
    indexHtmlSource.includes('id="detached-return-drop-target"'),
    false,
    'the main renderer should not render a drag-to-redock affordance',
  );
  assert.equal(
    stylesSource.includes('.detached-return-drop-target'),
    false,
    'the shell stylesheet should not retain drag-to-redock-only styles',
  );
  assert.equal(
    tabBarSource.includes("strip.addEventListener('drop', onStripDrop);"),
    true,
    'tab drag-and-drop reordering should remain available',
  );
  assert.equal(
    tabBarSource.includes("source: 'drag-out',"),
    true,
    'dragging an attached tab out of the strip should still detach it',
  );
});

test('detached conversation windows do not request webviewTag support', () => {
  const source = fs.readFileSync(windowsService, 'utf8');
  const createConversationWindowBlock = source.slice(
    source.indexOf('function createConversationWindow('),
    source.indexOf('function openNewChatWindow('),
  );
  assert.equal(
    createConversationWindowBlock.includes('webviewTag: true'),
    false,
    'detached conversation windows should not enable webviewTag',
  );
  assert.equal(
    createConversationWindowBlock.includes("titleBarStyle: 'hidden'"),
    true,
    'detached conversation windows should use the hidden macOS chrome path so renderer content can fill behind the traffic lights',
  );
  assert.equal(
    createConversationWindowBlock.includes('titleBarOverlay: true'),
    false,
    'detached conversation windows should use the simpler hidden-titlebar path without titleBarOverlay on macOS',
  );
  assert.equal(
    createConversationWindowBlock.includes('trafficLightPosition: detachedConversationTrafficLightPosition'),
    true,
    'detached conversation windows should use their own tuned macOS traffic light position',
  );
  assert.equal(
    createConversationWindowBlock.includes(
      'applyMacTrafficLightPosition(\n      conversationWindow,\n      detachedConversationTrafficLightPosition,',
    ),
    true,
    'detached conversation windows should reapply their detached-specific macOS traffic light position after creation',
  );
});

test('detached conversation windows align macOS traffic lights with the main header baseline', () => {
  const source = fs.readFileSync(windowsService, 'utf8');

  assert.equal(
    source.includes(
      'position = DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION,',
    ),
    true,
    'detached conversation windows should default to the main-window traffic light baseline',
  );
  assert.equal(
    source.includes(
      'return { ...DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION };',
    ),
    true,
    'detached conversation windows should fall back to the main-window traffic light baseline',
  );
  assert.equal(
    source.includes('DETACHED_CONVERSATION_MAC_TRAFFIC_LIGHT_Y_OFFSET'),
    false,
    'detached conversation windows should not keep the taller legacy titlebar offset',
  );
});

test('detached conversation windows show a session-loading veil before revealing OWUI', () => {
  const scriptSource = fs.readFileSync(conversationWindowScript, 'utf8');
  const htmlSource = fs.readFileSync(conversationWindowHtml, 'utf8');

  assert.equal(
    htmlSource.includes('Preparing new session...'),
    true,
    'detached conversation windows should render the new-session loading copy',
  );
  assert.equal(
    htmlSource.includes('conversation-session-loading-overlay visible'),
    true,
    'detached conversation windows should show the loading veil from first paint',
  );
  assert.equal(
    htmlSource.includes('conversation-window-titlebar-fill'),
    true,
    'detached conversation windows should render a shell titlebar fill behind the macOS traffic lights',
  );
  assert.equal(
    scriptSource.includes('INITIAL_SESSION_LOADING_MIN_MS = 2200'),
    true,
    'detached conversation windows should keep the initial loading veil up for a couple seconds',
  );
  assert.equal(
    scriptSource.includes('INITIAL_SESSION_LOADING_MAX_MS'),
    false,
    'detached conversation windows should not force-release the loading veil over a blank route',
  );
  assert.equal(
    scriptSource.includes('completeInitialSessionLoading({ force: true })'),
    false,
    'detached conversation windows should only hide the veil after a healthy content probe',
  );
  assert.equal(
    scriptSource.includes('window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, true);'),
    true,
    'detached conversation windows should suppress the OWUI host while the initial loading veil is visible',
  );
  assert.equal(
    scriptSource.includes('syncMacTitlebarSafeArea()'),
    true,
    'detached conversation windows should sync the macOS titlebar safe area for the custom chrome fill',
  );
});

test('detached conversation health probe waits for meaningful OWUI content', () => {
  const scriptSource = fs.readFileSync(conversationWindowScript, 'utf8');

  assert.equal(
    scriptSource.includes("bodyTextLength: trimmedBodyText.length"),
    true,
    'detached health snapshots should include visible body text length',
  );
  assert.equal(
    scriptSource.includes("querySelector('[data-detached-subagent-state]')"),
    true,
    'detached health snapshots should include the detached subagent state marker',
  );
  assert.match(
    scriptSource,
    /if \(windowType === "subagent"\) \{\s*return hasDetachedSubagentState && hasVisibleText;\s*\}/,
    'subagent windows should not treat app shell HTML or scripts as healthy content',
  );
  assert.equal(
    scriptSource.includes('htmlLength >='),
    false,
    'detached health probe should not accept app shell HTML length by itself',
  );
  assert.equal(
    scriptSource.includes('hasAppScript ||'),
    false,
    'detached health probe should not accept Svelte app scripts by themselves',
  );
});

test('detached chat surfaces no longer render or manage the privacy warning banner', () => {
  const conversationScriptSource = fs.readFileSync(conversationWindowScript, 'utf8');
  const conversationHtmlSource = fs.readFileSync(conversationWindowHtml, 'utf8');
  const chatTabSource = fs.readFileSync(chatTabScript, 'utf8');

  assert.equal(
    conversationHtmlSource.includes('id="warning-banner"'),
    false,
    'detached conversation HTML should not render the legacy privacy banner',
  );
  assert.equal(
    conversationHtmlSource.includes('conversation-guidelines-link'),
    false,
    'detached conversation HTML should not render the acceptable-use link',
  );
  assert.equal(
    conversationScriptSource.includes('warning-banner-dismissed-time'),
    false,
    'detached conversation renderer should not manage banner dismissal state',
  );
  assert.equal(
    conversationScriptSource.includes('company-wide-generative-ai-use-guidelines'),
    false,
    'detached conversation renderer should not open the removed privacy banner link',
  );
  assert.equal(
    chatTabSource.includes('warning-banner-dismissed-time'),
    false,
    'dynamic conversation tabs should not persist removed banner state',
  );
  assert.equal(
    chatTabSource.includes('conversation-guidelines-link'),
    false,
    'dynamic conversation tabs should not create the removed banner link',
  );
  assert.equal(
    chatTabSource.includes('warning-banner-'),
    false,
    'dynamic conversation tabs should not create per-conversation warning banner nodes',
  );
});

test('detached conversation windows host backend-triggered modals for their own chat', () => {
  const scriptSource = fs.readFileSync(conversationWindowScript, 'utf8');
  const htmlSource = fs.readFileSync(conversationWindowHtml, 'utf8');

  assert.equal(
    htmlSource.includes('<div id="oauth-wizard-container"></div>'),
    true,
    'detached conversation windows should include the OAuth modal host',
  );
  assert.equal(
    htmlSource.includes('<div id="sensitive-info-container"></div>'),
    true,
    'detached conversation windows should include the sensitive information modal host',
  );
  assert.equal(
    htmlSource.includes('<div id="chat-workspace-consent-container"></div>'),
    true,
    'detached conversation windows should include the chat workspace consent modal host',
  );
  assert.equal(
    htmlSource.includes('<div id="mcp-config-modal" class="modal-overlay">'),
    true,
    'detached conversation windows should include the MCP config modal host',
  );
  assert.match(
    htmlSource,
    /<script src="renderer\/components\/oauth-wizard-modal\.js"><\/script>[\s\S]*<script src="renderer\/components\/sensitive-info-modal\.js"><\/script>[\s\S]*<script src="renderer\/components\/chat-workspace-consent-modal\.js"><\/script>[\s\S]*<script src="renderer\/components\/mcp-config-modal\.js"><\/script>[\s\S]*<script src="renderer\/components\/backend-modal-listeners\.js"><\/script>/s,
    'detached conversation windows should load backend modal runtimes before registering listeners',
  );
  assert.equal(
    htmlSource.includes('window.setupBackendModalListeners?.({ label: "Conversation Window" });'),
    true,
    'detached conversation windows should register the shared backend modal listeners',
  );
  assert.equal(
    scriptSource.includes('window.setNativeOverlayInteractionSuppressed = (reason, suppressed) => {'),
    true,
    'detached conversation windows should expose per-window native overlay suppression for modal runtimes',
  );
});
