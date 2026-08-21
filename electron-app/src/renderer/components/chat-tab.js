// Chat tab component - EXACT code from services/renderer.js
// NO BUSINESS LOGIC CHANGES

// Track hover state to prevent tooltip flickering
let lastHoverState = false;

// ============================================================================
// WEBVIEW AUTO-RECONNECT LOGIC
// Automatically retries loading when backend containers restart
// ============================================================================
let reconnectInterval = null;
let reconnectAttempts = 0;
let isInitialLoad = true; // Track if this is initial load vs reconnect
const MAX_RECONNECT_ATTEMPTS = 36; // Try for up to 3 minutes (5s intervals)
const RECONNECT_INTERVAL_MS = 5000; // Check every 5 seconds
const MIN_WEBVIEW_HTML_LENGTH = 400;
const MAX_BLANK_RECOVERY_ATTEMPTS = 3;
const MAX_HARD_RECOVERY_ATTEMPTS = 2;
const MAX_PROBE_FAILURES_BEFORE_HARD_RECOVERY = 3;
const BLANK_RECOVERY_RELOAD_DELAY_MS = 800;
const WEBVIEW_HEALTH_PROBE_DELAY_MS = 600;
const WEBVIEW_VISIBILITY_STABILIZE_MS = 2000;
const INITIAL_SESSION_LOADING_MIN_MS = 2200;
const INITIAL_SESSION_LOADING_MAX_MS = 4200;
const INITIAL_SESSION_SUPPRESSION_REASON = 'main-chat-initial-loading';
const WEBVIEW_ERROR_CONSOLE_LEVEL = 2;
const WEBVIEW_CONSOLE_LEVEL_MAP = {
  0: 'debug',
  1: 'info',
  2: 'warn',
  3: 'error',
};
const WEBVIEW_FORCED_RECOVERY_COOLDOWN_MS = 8000;
const SYSTEM_RESUME_PROBE_DELAY_MS = 3000;
const OPEN_WEBUI_HOME_URL = 'http://localhost:3789/';
const WEBVIEW_KNOWN_NOISE_PATTERNS = [
  'no token found in localstorage, user-join event not emitted',
  '[tiptap warn]: duplicate extension names found',
  'electron security warning',
];
const WEBVIEW_HEALTH_CHECK_SCRIPT = `(() => {
  const bodyText = document.body ? document.body.innerText || '' : '';
  const title = document.title || '';
  const htmlLength = document.documentElement
    ? document.documentElement.innerHTML.length
    : 0;
  const hasAppScript = !!document.querySelector('script[src*="/_app/"]');
  return {
    htmlLength,
    hasAppScript,
    title,
    sample: bodyText.slice(0, 200)
  };
})()`;
const CHAT_CURSOR_FIX_CSS = `
  /* Fix cursor position in input fields */
  textarea,
  input[type="text"],
  input[type="search"],
  input[type="email"],
  input[type="password"],
  [contenteditable="true"],
  .prose {
    text-align: left !important;
    direction: ltr !important;
  }

  /* Fix the specific chat input box */
  #chat-textarea,
  textarea[placeholder*="How can I help"],
  textarea[placeholder*="Message"],
  .flex-1 textarea {
    text-align: left !important;
    direction: ltr !important;
    padding-left: 1rem !important;
  }

  /* Ensure placeholder text is also left-aligned */
  textarea::placeholder,
  input::placeholder {
    text-align: left !important;
  }

  /* Override any flex centering */
  .flex.items-center textarea,
  .flex.justify-center textarea {
    text-align: left !important;
  }

  /* Target the chat input area specifically */
  .relative.flex.flex-col.flex-1 textarea {
    text-align: left !important;
    padding-left: 1rem !important;
  }

  /* Slightly reduce Thought block height */
  div[role="button"]:has(> .collapsible-header-row.font-medium) {
    padding-top: 0.375rem !important;
    padding-bottom: 0.375rem !important;
  }
`;
const webviewRecoveryState = new WeakMap();
const webviewRecoveryBindings = new WeakMap();
const boundWebviews = new WeakSet();
let forceRecoveryListenerRegistered = false;
let lastForcedRecoveryAt = 0;
let systemResumeListenerRegistered = false;
let systemResumeProbeTimer = null;

let chatWebviewPreloadPathPromise = null;
let initialSessionLoadingStartedAt = 0;
let initialSessionLoadingReleaseTimer = null;
let initialSessionLoadingVisible = false;
let initialSessionLoadingCompleted = false;
let initialSessionLoadingCompletionPromise = null;

function ensureOwuiHostElement(element, options = {}) {
  if (!element) {
    return null;
  }

  if (window.ensureOwuiHost) {
    return window.ensureOwuiHost(element, options);
  }

  return element;
}

function buildOwuiHostElement(options = {}) {
  if (window.createOwuiHostElement) {
    return window.createOwuiHostElement(options);
  }

  const element = document.createElement('div');
  element.className = options.className || 'chat-webview';
  if (options.id) {
    element.id = options.id;
  }
  return ensureOwuiHostElement(element, options);
}

function disposeOwuiHostElement(element, options = {}) {
  if (window.disposeOwuiHost) {
    window.disposeOwuiHost(element, options);
  }
}

function getWebviewRecoveryState(webview) {
  if (!webviewRecoveryState.has(webview)) {
    webviewRecoveryState.set(webview, {
      attempts: 0,
      recovering: false,
      probeTimer: null,
      consecutiveProbeFailures: 0,
      hardRecoveryAttempts: 0,
      lastShownAt: 0,
    });
  }
  return webviewRecoveryState.get(webview);
}

function resetWebviewRecoveryState(webview, options = {}) {
  const { preserveHardRecoveryAttempts = false } = options;
  const state = getWebviewRecoveryState(webview);
  state.attempts = 0;
  state.recovering = false;
  state.consecutiveProbeFailures = 0;
  if (!preserveHardRecoveryAttempts) {
    state.hardRecoveryAttempts = 0;
  }
  if (state.probeTimer) {
    clearTimeout(state.probeTimer);
    state.probeTimer = null;
  }
}

function getWebviewIdentity(webview) {
  if (!webview) {
    return 'webview:missing';
  }

  const id = webview.id || webview.getAttribute?.('id') || 'unknown';
  let webContentsId = 'unknown';
  try {
    if (typeof webview.getWebContentsId === 'function') {
      webContentsId = webview.getWebContentsId();
    }
  } catch (error) {
    webContentsId = 'unavailable';
  }

  return `${id}/wc:${webContentsId}`;
}

function getWebviewReloadUrl(webview, fallbackUrl = 'http://localhost:3789') {
  const candidates = [];

  try {
    if (typeof webview?.getURL === 'function') {
      candidates.push(webview.getURL());
    }
  } catch (error) {
    // Ignore getURL failures and continue with src fallback
  }

  if (webview?.getAttribute) {
    candidates.push(webview.getAttribute('src'));
  }
  candidates.push(fallbackUrl);

  const valid = candidates.find((candidate) => {
    return Boolean(candidate && candidate !== 'about:blank');
  });

  return valid || fallbackUrl;
}

function isWebviewVisible(webview) {
  if (!webview || !webview.isConnected) {
    return false;
  }

  if (webview.classList?.contains('hidden')) {
    return false;
  }

  const style = window.getComputedStyle(webview);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = webview.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isExpectedNavigationAbort(event) {
  return Number(event?.errorCode) === -3;
}

function getConversationIdFromWebview(webview) {
  const id = webview?.id || '';
  const match = id.match(/^conversation-webview-(.+)$/);
  return match ? match[1] : null;
}

function markWebviewShown(webview) {
  if (!webview) {
    return;
  }

  const state = getWebviewRecoveryState(webview);
  state.lastShownAt = Date.now();
}

function getVisibilityStabilizeDelayMs(state) {
  if (!state?.lastShownAt) {
    return 0;
  }

  const elapsedMs = Date.now() - state.lastShownAt;
  if (elapsedMs >= WEBVIEW_VISIBILITY_STABILIZE_MS) {
    return 0;
  }

  return Math.max(400, WEBVIEW_VISIBILITY_STABILIZE_MS - elapsedMs + 200);
}

function registerWebviewRecoveryBinding(webview, bindingFn) {
  if (!webview || typeof bindingFn !== 'function') {
    return;
  }
  webviewRecoveryBindings.set(webview, bindingFn);
}

function copyWebviewStateToReplacement(previousWebview, replacementWebview) {
  const previousState = getWebviewRecoveryState(previousWebview);
  const replacementState = getWebviewRecoveryState(replacementWebview);
  replacementState.hardRecoveryAttempts = previousState.hardRecoveryAttempts;
  replacementState.consecutiveProbeFailures = 0;
  replacementState.attempts = 0;
  replacementState.recovering = false;
  if (replacementState.probeTimer) {
    clearTimeout(replacementState.probeTimer);
    replacementState.probeTimer = null;
  }
  resetWebviewRecoveryState(previousWebview, { preserveHardRecoveryAttempts: true });
}

function getOwuiViewKeyForWebview(webview, conversationId = null) {
  return webview?.dataset?.owuiViewKey || (conversationId ? `conversation:${conversationId}` : 'main');
}

function getOwuiWindowTypeForWebview(webview, conversationId = null) {
  return webview?.dataset?.owuiWindowType || (conversationId ? 'conversation' : 'main');
}

async function attachOwuiViewAndSyncActiveKey(webview, tabName, conversationId = null) {
  if (!webview) {
    return null;
  }

  let attachedState = null;
  if (typeof webview.attachOwuiView === 'function') {
    try {
      attachedState = await webview.attachOwuiView();
    } catch (error) {
      console.warn(`[Chat] Failed to attach OWUI view for ${tabName}:`, error);
    }
  }

  if (
    tabName &&
    window.appState?.activeTab === tabName &&
    window.electronAPI?.setActiveViewKey
  ) {
    const viewKey = getOwuiViewKeyForWebview(webview, conversationId);
    window.electronAPI.setActiveViewKey(viewKey || null);
    scheduleActiveTabFocusHandoff(tabName);
  }

  return attachedState;
}

const SHELL_ONLY_OWUI_URL_PARAMS = new Set([
  'portico-target-message',
  'detached-window',
  // New-chat prompt deep links are one-shot launch instructions. Persisting
  // them would risk submitting the same prompt again after tab restoration.
  'q',
  'submit',
]);

function normalizeOwuiShellUrl(rawUrl, fallbackUrl = 'http://localhost:3789') {
  const candidate = String(rawUrl || fallbackUrl || '').trim();
  if (!candidate) {
    return fallbackUrl;
  }

  try {
    const normalized = new URL(candidate, window.location.origin);
    for (const param of SHELL_ONLY_OWUI_URL_PARAMS) {
      normalized.searchParams.delete(param);
    }
    normalized.hash = '';
    return normalized.toString();
  } catch (_error) {
    return candidate;
  }
}

function getLiveOwuiUrl(webview, fallbackUrl = 'http://localhost:3789') {
  return normalizeOwuiShellUrl(getWebviewReloadUrl(webview, fallbackUrl), fallbackUrl);
}

async function replaceAttachedOwuiShellUrlInPlace(webview, rawTargetUrl) {
  if (!webview || typeof webview.executeJavaScript !== 'function' || !rawTargetUrl) {
    return false;
  }

  const targetUrl = normalizeOwuiShellUrl(rawTargetUrl);
  let currentUrl = '';
  try {
    currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
  } catch (_error) {
    currentUrl = '';
  }

  if (!currentUrl || currentUrl === targetUrl) {
    return true;
  }

  // Redocking adopts the existing native view so its scroll position and live
  // renderer state survive. When the only URL difference is shell-owned state,
  // clean the address with History API instead of reloading that adopted view.
  if (normalizeOwuiShellUrl(currentUrl) !== targetUrl) {
    return false;
  }

  try {
    const replacedUrl = await webview.executeJavaScript(`
      (() => {
        const target = new URL(${JSON.stringify(targetUrl)}, window.location.href);
        if (target.origin !== window.location.origin) {
          return null;
        }
        window.history.replaceState(window.history.state, document.title, target.href);
        return window.location.href;
      })()
    `);
    return replacedUrl === targetUrl;
  } catch (error) {
    console.warn(
      '[CONVERSATION] Failed to clear shell-only URL state after redocking:',
      error?.message || error,
    );
    return false;
  }
}

function syncConversationUrlState(conversationId, rawUrl, fallbackUrl = 'http://localhost:3789') {
  if (!conversationId) {
    return;
  }

  const state = window.appState;
  const normalizedUrl = normalizeOwuiShellUrl(rawUrl, fallbackUrl);
  resetTabBusyOnChatSwitch(conversationId, normalizedUrl);
  if (state?.conversationTabs?.[conversationId]) {
    state.conversationTabs[conversationId].url = normalizedUrl;
  }
  if (state?.tabMeta?.[conversationId]) {
    state.tabMeta[conversationId].url = normalizedUrl;
  }
  publishChatAttentionSnapshot();
}

function createReplacementMainChatView(homeUrl = 'http://localhost:3789') {
  const webview = document.getElementById('chat-webview');
  if (!webview) {
    return null;
  }

  const replacementViewKey = `main-home:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const replacementWebview = ensureOwuiHostElement(webview, {
    viewKey: replacementViewKey,
    windowType: 'main',
    url: homeUrl,
    createImmediately: true,
  });
  markWebviewShown(replacementWebview);
  scheduleWebviewHealthProbe(replacementWebview, buildMainChatProbeOptions(replacementWebview));
  void attachOwuiViewAndSyncActiveKey(replacementWebview, 'chat');
  return replacementWebview;
}

const GENERIC_TAB_TITLES = new Set(['open webui', 'Portico', 'chat']);

function normalizeConversationTabTitle(rawTitle) {
  const title = String(rawTitle || '').trim();
  if (!title) {
    return null;
  }

  const normalized = title.toLowerCase();
  if (GENERIC_TAB_TITLES.has(normalized)) {
    return null;
  }

  const separator = ' • ';
  const separatorIndex = title.lastIndexOf(separator);
  if (separatorIndex !== -1) {
    const baseTitle = title.slice(0, separatorIndex).trim();
    const suffix = title.slice(separatorIndex + separator.length).trim().toLowerCase();
    if (baseTitle && GENERIC_TAB_TITLES.has(suffix)) {
      return baseTitle;
    }
  }

  return title;
}

function extractChatIdFromRuntimeUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  try {
    const parsed = new URL(String(rawUrl), 'http://localhost:3789');
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1].trim() : '';
  } catch {
    const match = String(rawUrl).match(/\/c\/([^/?#]+)/);
    return match ? match[1].trim() : '';
  }
}

function getRuntimeChatIdForTab(tabId, state = window.appState) {
  const meta = state?.tabMeta?.[tabId] || {};
  const conversation = state?.conversationTabs?.[tabId] || {};
  const hostElement = tabId === 'chat'
    ? document.getElementById('chat-webview')
    : document.getElementById(`conversation-webview-${tabId}`);
  let liveUrl = '';
  try {
    liveUrl = typeof hostElement?.getURL === 'function'
      ? hostElement.getURL()
      : (hostElement?.getAttribute?.('src') || hostElement?.src || '');
  } catch {}

  const liveChatId = extractChatIdFromRuntimeUrl(liveUrl);
  if (liveChatId) {
    return liveChatId;
  }

  const explicitChatId = String(meta.currentChatId || '').trim();
  if (explicitChatId) {
    return explicitChatId;
  }

  for (const candidate of [conversation.url, meta.url]) {
    const parsedChatId = extractChatIdFromRuntimeUrl(candidate);
    if (parsedChatId) {
      return parsedChatId;
    }
  }

  if (tabId !== 'chat' && tabId !== 'control') {
    return String(meta.conversationId || tabId || '').trim();
  }
  return '';
}

function buildChatAttentionSnapshot(state = window.appState) {
  const chats = new Map();
  for (const [tabId, meta] of Object.entries(state?.tabMeta || {})) {
    const unread = meta?.unread === true;
    const attentionRequired = meta?.attentionRequired === true;
    if (!unread && !attentionRequired) {
      continue;
    }
    const chatId = getRuntimeChatIdForTab(tabId, state);
    if (chatId) {
      const status = chats.get(chatId) || { chatId };
      if (unread) {
        status.unread = true;
      }
      if (attentionRequired) {
        status.attentionRequired = true;
      }
      chats.set(chatId, status);
    }
  }
  return { version: 1, chats: Array.from(chats.values()) };
}

function publishChatAttentionSnapshot() {
  const broadcast = window.electronAPI?.owui?.broadcastOwnerEvent;
  if (typeof broadcast !== 'function') {
    return;
  }
  void broadcast('owui-chat-attention-snapshot', buildChatAttentionSnapshot()).catch((error) => {
    console.warn('[Chat] Failed to publish chat attention snapshot:', error);
  });
}

function setTabBusyState(tabId, busy, phase = 'idle', currentChatId = null) {
  if (!tabId) {
    return;
  }

  const state = window.appState;
  const previousBusy = state?.tabMeta?.[tabId]?.busy === true;
  const previousChatId = String(state?.tabMeta?.[tabId]?.currentChatId || '').trim();
  const hasReportedChatId = typeof currentChatId === 'string';
  const normalizedChatId = hasReportedChatId ? currentChatId.trim() : previousChatId;
  if (state?.tabMeta?.[tabId]) {
    state.tabMeta[tabId].busy = busy === true;
    state.tabMeta[tabId].busyPhase = busy === true ? phase : 'idle';
    if (hasReportedChatId) {
      state.tabMeta[tabId].currentChatId = normalizedChatId;
    }
  }

  if (hasReportedChatId && normalizedChatId) {
    window.backendModalAttention?.claimForChat?.(normalizedChatId, tabId);
  }

  window.tabBar?.setActivity(tabId, {
    busy: busy === true,
    phase: busy === true ? phase : 'idle',
  });

  const fullTabId = tabId === 'chat' || tabId === 'control' ? tabId : `conversation-${tabId}`;
  if (!busy && previousBusy && state?.activeTab !== fullTabId) {
    setTabUnreadState(tabId, true);
  }
  if (!busy) {
    scheduleBackgroundTabUnloadCheck();
  }
  if (hasReportedChatId && previousChatId !== normalizedChatId) {
    publishChatAttentionSnapshot();
  }
}

function resetTabBusyOnChatSwitch(tabId, nextUrl) {
  if (!tabId) {
    return;
  }

  const meta = window.appState?.tabMeta?.[tabId];
  if (!meta) {
    return;
  }

  const nextChatId = extractChatIdFromRuntimeUrl(nextUrl) || '';
  const previousChatId = String(meta.currentChatId || '').trim();
  if (nextChatId) {
    // A committed OWUI route is authoritative even when cached tab metadata
    // already names the same chat (for example after a blank-host adoption).
    window.backendModalAttention?.claimForChat?.(nextChatId, tabId);
  }
  if (nextChatId === previousChatId) {
    return;
  }

  // PORTICO-432: this tab's unread flag described the chat it was showing. Now that
  // it shows a different chat, keeping the flag lights the tab dot for a chat
  // that never had activity. The departed chat's own unread lives in the
  // chat-scoped activity registry and is unaffected by clearing it here.
  if (meta.busy === true) {
    // OWUI does not emit busy=false for the departed chat on SPA navigation
    // (the main-process registry owns background chat lifecycle), so clear
    // the stale spinner when this tab navigates to a different chat.
    setTabBusyState(tabId, false, 'idle', nextChatId);
    // setTabBusyState marks an inactive tab unread on any busy->idle
    // transition, but that completion belongs to the DEPARTED chat, so it must
    // not carry over to the chat being opened.
    if (meta.unread === true) {
      setTabUnreadState(tabId, false);
    }
    return;
  }

  // Not busy: keep the recorded chat id in sync without re-render churn.
  meta.currentChatId = nextChatId;
  if (meta.unread === true) {
    // Clearing also republishes, so this replaces the publish below. Only taken
    // when there is a stale flag to drop, keeping the common idle switch free of
    // tab-bar churn.
    setTabUnreadState(tabId, false);
    return;
  }
  publishChatAttentionSnapshot();
}

// The last responding model per tab, compared by the fields that change the
// rendered icon so unchanged reports skip DOM + persistence work entirely.
function tabModelIdentityKey(identity) {
  if (!identity || typeof identity !== 'object') {
    return '';
  }
  return [identity.id, identity.baseModelId].map((v) => String(v || '')).join('|');
}

function setTabModelIdentity(tabId, identity) {
  if (!tabId || !identity || typeof identity !== 'object') {
    return;
  }
  const meta = window.appState?.tabMeta?.[tabId];
  if (!meta) {
    return;
  }
  if (tabModelIdentityKey(meta.modelIdentity) === tabModelIdentityKey(identity)) {
    return;
  }
  meta.modelIdentity = {
    id: String(identity.id || ''),
    name: String(identity.name || ''),
    ownedBy: String(identity.ownedBy || ''),
    baseModelId: String(identity.baseModelId || ''),
    baseModelName: String(identity.baseModelName || ''),
    baseModelOwnedBy: String(identity.baseModelOwnedBy || ''),
  };
  window.tabBar?.setModelIdentity?.(tabId, meta.modelIdentity);
  window.persistTabState?.();
}

function applyTabActivityEvent(tabId, event) {
  const busy = event?.busy === true;
  const eventChatId = String(event?.chatId || '').trim();
  const currentChatId = String(window.appState?.tabMeta?.[tabId]?.currentChatId || '').trim();
  const isStaleChatEvent = Boolean(eventChatId && currentChatId && eventChatId !== currentChatId);
  if (busy && isStaleChatEvent) {
    // Late activity from a chat this tab has already navigated away from
    // must not re-light the spinner after resetTabBusyOnChatSwitch cleared it.
    return;
  }
  if (!isStaleChatEvent && event?.modelIdentity) {
    setTabModelIdentity(tabId, event.modelIdentity);
  }
  // Stale busy=false events may still clear the spinner, but must not
  // overwrite the recorded chat id for the chat this tab now shows.
  setTabBusyState(tabId, busy, event?.phase || 'idle', isStaleChatEvent ? null : eventChatId);
}

function setTabUnreadState(tabId, unread) {
  if (!tabId) {
    return;
  }

  const state = window.appState;
  if (state?.tabMeta?.[tabId]) {
    state.tabMeta[tabId].unread = unread === true;
  }
  window.tabBar?.setUnread(tabId, unread === true);
  publishChatAttentionSnapshot();
}

function setTabAttentionRequiredState(tabId, required, _details = {}) {
  if (!tabId) {
    return;
  }

  const state = window.appState;
  if (state?.tabMeta?.[tabId]) {
    state.tabMeta[tabId].attentionRequired = required === true;
  }
  window.tabBar?.setAttentionRequired?.(tabId, required === true);
  publishChatAttentionSnapshot();
  if (required === true && tabId !== 'chat' && tabId !== 'control') {
    ensureConversationWebviewMounted(tabId);
  } else {
    scheduleBackgroundTabUnloadCheck();
  }
}

const owuiFocusSuppressionReasons = new Set();

function setOwuiFocusSuppressed(reason, suppressed) {
  if (!reason) {
    return;
  }

  if (suppressed) {
    owuiFocusSuppressionReasons.add(reason);
  } else {
    owuiFocusSuppressionReasons.delete(reason);
  }
}

function isOwuiFocusSuppressed() {
  return owuiFocusSuppressionReasons.size > 0;
}

window.setOwuiFocusSuppressed = setOwuiFocusSuppressed;
window.isOwuiFocusSuppressed = isOwuiFocusSuppressed;

async function focusActiveOwuiView() {
  if (!window.electronAPI?.owui?.focusView) {
    return;
  }

  if (window.isOwuiInteractionSuppressed?.()) {
    return;
  }

  if (window.isOwuiFocusSuppressed?.()) {
    return;
  }

  const activeTab = String(window.appState?.activeTab || 'chat');
  if (activeTab.startsWith('conversation-')) {
    const conversationId = activeTab.replace('conversation-', '');
    const conversationWebview = document.getElementById(`conversation-webview-${conversationId}`);
    if (!conversationWebview) {
      return;
    }
    const viewKey = getOwuiViewKeyForWebview(conversationWebview, conversationId);
    await window.electronAPI.owui.focusView(viewKey).catch(() => {});
    return;
  }

  if (activeTab !== 'chat') {
    return;
  }

  const webview = document.getElementById('chat-webview');
  if (!webview) {
    return;
  }
  const viewKey = getOwuiViewKeyForWebview(webview);
  await window.electronAPI.owui.focusView(viewKey).catch(() => {});
}

async function focusShellRenderer() {
  if (!window.electronAPI?.focusRenderer) {
    return;
  }

  await window.electronAPI.focusRenderer().catch(() => {});
}

async function handoffActiveTabFocus(tabName = String(window.appState?.activeTab || 'chat')) {
  if (window.isOwuiInteractionSuppressed?.() || window.isOwuiFocusSuppressed?.()) {
    await focusShellRenderer();
    return;
  }

  if (tabName === 'chat' || tabName.startsWith('conversation-')) {
    await focusActiveOwuiView();
    return;
  }

  await focusShellRenderer();
}

function scheduleActiveTabFocusHandoff(expectedTab = String(window.appState?.activeTab || 'chat')) {
  const schedule = window.requestAnimationFrame?.bind(window) || ((callback) => callback());
  schedule(() => {
    const activeTab = String(window.appState?.activeTab || 'chat');
    if (activeTab !== expectedTab) {
      return;
    }
    void handoffActiveTabFocus(activeTab);
  });
}

window.addEventListener('focus', () => {
  void focusActiveOwuiView();
});

async function safeExecuteWebviewScript(webview, script, options = {}) {
  const { label = 'Chat', tag = 'executeJavaScript' } = options;

  try {
    const result = await webview.executeJavaScript(script);
    return { ok: true, result };
  } catch (error) {
    console.warn(
      `[${label}] ${tag} failed (${getWebviewIdentity(webview)}):`,
      error?.message || error,
    );
    return { ok: false, error };
  }
}

async function rebuildWebviewInPlace(webview, options = {}) {
  if (!webview || !webview.parentNode) {
    return null;
  }

  const {
    label = 'Chat',
    reloadUrl = 'http://localhost:3789',
    reason = 'unknown',
    onRebuilt = null,
  } = options;

  const bindRecovery = webviewRecoveryBindings.get(webview);
  if (typeof bindRecovery !== 'function') {
    console.error(`[${label}] Missing recovery binding; cannot rebuild webview`);
    return null;
  }

  const conversationId = getConversationIdFromWebview(webview);
  const targetUrl =
    conversationId && window.appState?.conversationTabs?.[conversationId]?.url
      ? window.appState.conversationTabs[conversationId].url
      : getWebviewReloadUrl(webview, reloadUrl);

  if (webview.dataset?.owuiHost === 'true' && typeof webview.recreateOwuiView === 'function') {
    try {
      await webview.recreateOwuiView(targetUrl);
      resetWebviewRecoveryState(webview, { preserveHardRecoveryAttempts: true });
      if (typeof onRebuilt === 'function') {
        onRebuilt(webview, { reason, targetUrl });
      }
      return webview;
    } catch (error) {
      console.error(
        `[${label}] Failed to recreate OWUI host (${reason}):`,
        error?.message || error,
      );
      return null;
    }
  }

  const replacement = buildOwuiHostElement({
    id: webview.id,
    className: webview.className,
    viewKey: getOwuiViewKeyForWebview(webview, conversationId),
    windowType: getOwuiWindowTypeForWebview(webview, conversationId),
    conversationId,
  });
  replacement.style.cssText = webview.style.cssText;

  webview.parentNode.replaceChild(replacement, webview);
  copyWebviewStateToReplacement(webview, replacement);
  bindRecovery(replacement);

  // Defensive: if the recovery binding path did not attach listeners for any
  // reason, attach directly so crash self-heal retains all handlers.
  if (!boundWebviews.has(replacement)) {
    if (conversationId) {
      attachConversationWebviewListeners(
        replacement,
        conversationId,
        reloadUrl,
      );
    } else {
      attachMainChatWebviewListeners(replacement);
    }
  }

  if (conversationId && window.appState?.conversationTabs?.[conversationId]) {
    window.appState.conversationTabs[conversationId].webviewElement = replacement;
  }

  try {
    await ensureChatWebviewPreload(replacement);
  } catch (error) {
    console.warn(`[${label}] Failed to reapply preload during rebuild:`, error?.message || error);
  }

  try {
    if (typeof replacement.loadURL === 'function') {
      replacement.loadURL(targetUrl);
    } else {
      replacement.src = targetUrl;
    }
  } catch (error) {
    console.error(
      `[${label}] Failed to load rebuilt webview (${reason}):`,
      error?.message || error,
    );
    return null;
  }

  if (typeof onRebuilt === 'function') {
    onRebuilt(replacement, { reason, targetUrl });
  }

  return replacement;
}

async function triggerHardWebviewRecovery(webview, options = {}) {
  if (!webview) {
    return false;
  }

  const {
    label = 'Chat',
    reloadUrl = 'http://localhost:3789',
    reason = 'unknown',
    onRecoveryExhausted = null,
  } = options;

  const state = getWebviewRecoveryState(webview);
  if (state.recovering) {
    return false;
  }

  if (state.hardRecoveryAttempts >= MAX_HARD_RECOVERY_ATTEMPTS) {
    console.error(
      `[${label}] Hard recovery exhausted (${state.hardRecoveryAttempts}/${MAX_HARD_RECOVERY_ATTEMPTS})`,
    );
    if (typeof onRecoveryExhausted === 'function') {
      onRecoveryExhausted(null);
    }
    return false;
  }

  state.recovering = true;
  state.hardRecoveryAttempts += 1;
  console.error(
    `[${label}] Starting hard recovery (${state.hardRecoveryAttempts}/${MAX_HARD_RECOVERY_ATTEMPTS}) due to ${reason}`,
  );

  try {
    const rebuiltWebview = await rebuildWebviewInPlace(webview, {
      label,
      reloadUrl,
      reason,
      onRebuilt: options.onRebuilt,
    });

    if (!rebuiltWebview) {
      if (typeof onRecoveryExhausted === 'function') {
        onRecoveryExhausted(null);
      }
      return false;
    }

    const nextProbeOptions =
      typeof options.nextProbeOptionsFactory === 'function'
        ? options.nextProbeOptionsFactory(rebuiltWebview)
        : { ...options };
    delete nextProbeOptions.nextProbeOptionsFactory;
    delete nextProbeOptions.reason;
    delete nextProbeOptions.onRebuilt;

    scheduleWebviewHealthProbe(rebuiltWebview, {
      ...nextProbeOptions,
      delayMs: 1200,
    });
    return true;
  } catch (error) {
    console.error(
      `[${label}] Hard recovery failed (${reason}):`,
      error?.message || error,
    );
    if (typeof onRecoveryExhausted === 'function') {
      onRecoveryExhausted(null);
    }
    return false;
  } finally {
    state.recovering = false;
  }
}

function isWebviewSnapshotHealthy(snapshot) {
  const htmlLength = snapshot?.htmlLength || 0;
  const hasAppScript = snapshot?.hasAppScript === true;
  const titleLower = (snapshot?.title || '').toLowerCase();
  const sampleLower = (snapshot?.sample || '').toLowerCase();
  const looksLikeError =
    titleLower.includes('internal error') ||
    titleLower.startsWith('500') ||
    sampleLower.includes('internal error');

  return (
    !looksLikeError &&
    (hasAppScript || htmlLength >= MIN_WEBVIEW_HTML_LENGTH)
  );
}

function shouldLogWebviewConsoleMessage(event) {
  const message = String(event?.message || '').toLowerCase();
  if (WEBVIEW_KNOWN_NOISE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return false;
  }

  const level = Number(event?.level ?? 0);
  if (level >= WEBVIEW_ERROR_CONSOLE_LEVEL) {
    return true;
  }

  return (
    message.includes('error') ||
    message.includes('exception') ||
    message.includes('uncaught') ||
    message.includes('failed')
  );
}

function getWebviewConsoleLevelName(eventLevel) {
  const level = Number(eventLevel);
  if (Number.isFinite(level) && WEBVIEW_CONSOLE_LEVEL_MAP[level]) {
    return WEBVIEW_CONSOLE_LEVEL_MAP[level];
  }
  return 'info';
}

function forwardWebviewConsoleMessage(prefix, event) {
  if (!window.electronAPI?.logToMain) {
    return;
  }

  const level = Number(event?.level ?? 1);
  window.electronAPI.logToMain(
    getWebviewConsoleLevelName(level),
    `${prefix} ${String(event?.message ?? '')}`,
    {
      webviewConsole: true,
      prefix,
      level,
      sourceId: event?.sourceId || null,
      line: Number.isFinite(Number(event?.line)) ? Number(event.line) : null,
    },
  );
}

function logWebviewConsoleMessage(prefix, event) {
  forwardWebviewConsoleMessage(prefix, event);

  if (!shouldLogWebviewConsoleMessage(event)) {
    return;
  }

  const level = Number(event?.level ?? 0);
  if (level >= WEBVIEW_ERROR_CONSOLE_LEVEL) {
    console.error(prefix, event.message);
    return;
  }

  console.warn(prefix, event.message);
}

async function probeWebviewHealthAndRecover(webview, options = {}) {
  if (!webview) {
    return false;
  }

  const {
    label = 'Chat',
    reloadUrl = 'http://localhost:3789',
    allowAutoReload = true,
    onHealthy = null,
    onUnhealthy = null,
    onRecoveryExhausted = null,
  } = options;

  const state = getWebviewRecoveryState(webview);
  const probeResult = await safeExecuteWebviewScript(
    webview,
    WEBVIEW_HEALTH_CHECK_SCRIPT,
    {
      label,
      tag: 'health-probe',
    },
  );
  const visibilityStabilizeDelayMs = getVisibilityStabilizeDelayMs(state);
  if (!probeResult.ok) {
    if (visibilityStabilizeDelayMs > 0) {
      scheduleWebviewHealthProbe(webview, {
        ...options,
        delayMs: visibilityStabilizeDelayMs,
      });
      return false;
    }

    state.consecutiveProbeFailures += 1;
    console.warn(
      `[${label}] Health probe inconclusive (${state.consecutiveProbeFailures}/${MAX_PROBE_FAILURES_BEFORE_HARD_RECOVERY})`,
    );

    if (
      allowAutoReload &&
      state.consecutiveProbeFailures >= MAX_PROBE_FAILURES_BEFORE_HARD_RECOVERY
    ) {
      await triggerHardWebviewRecovery(webview, {
        ...options,
        reason: 'probe-failures',
        reloadUrl,
      });
    }
    return false;
  }

  state.consecutiveProbeFailures = 0;
  const snapshot = probeResult.result;

  const healthy = isWebviewSnapshotHealthy(snapshot);
  if (healthy) {
    resetWebviewRecoveryState(webview);
    if (typeof onHealthy === 'function') {
      onHealthy(snapshot);
    }
    return true;
  }

  if (visibilityStabilizeDelayMs > 0) {
    scheduleWebviewHealthProbe(webview, {
      ...options,
      delayMs: visibilityStabilizeDelayMs,
    });
    return false;
  }

  if (typeof onUnhealthy === 'function') {
    onUnhealthy(snapshot);
  }

  if (!allowAutoReload) {
    return false;
  }

  if (state.recovering) {
    return false;
  }

  if (state.attempts >= MAX_BLANK_RECOVERY_ATTEMPTS) {
    await triggerHardWebviewRecovery(webview, {
      ...options,
      reason: 'blank-state',
      reloadUrl,
      onRecoveryExhausted: (hardRecoverySnapshot) => {
        if (typeof onRecoveryExhausted === 'function') {
          onRecoveryExhausted(hardRecoverySnapshot || snapshot);
        }
      },
    });
    return false;
  }

  state.attempts += 1;
  state.recovering = true;
  console.warn(
    `[${label}] Blank-state detected, attempting recovery reload (${state.attempts}/${MAX_BLANK_RECOVERY_ATTEMPTS})`,
  );

  setTimeout(() => {
    if (!webview.isConnected) {
      state.recovering = false;
      return;
    }

    state.recovering = false;
    try {
      ensureRecoveryWebviewListenersAttached(webview, options);
      if (typeof webview.reloadIgnoringCache === 'function') {
        webview.reloadIgnoringCache();
      } else if (typeof webview.reload === 'function') {
        webview.reload();
      } else if (typeof webview.loadURL === 'function' && reloadUrl) {
        webview.loadURL(reloadUrl);
      } else if (reloadUrl) {
        webview.src = reloadUrl;
      }
    } catch (reloadError) {
      console.error(`[${label}] Recovery reload failed:`, reloadError);
    }
  }, BLANK_RECOVERY_RELOAD_DELAY_MS);

  return false;
}

function scheduleWebviewHealthProbe(webview, options = {}) {
  if (!webview) {
    return;
  }

  const state = getWebviewRecoveryState(webview);
  if (state.probeTimer) {
    clearTimeout(state.probeTimer);
  }

  const delayMs =
    typeof options.delayMs === 'number'
      ? Math.max(0, options.delayMs)
      : WEBVIEW_HEALTH_PROBE_DELAY_MS;

  state.probeTimer = setTimeout(() => {
    state.probeTimer = null;
    if (!webview.isConnected) {
      return;
    }
    if (!isWebviewVisible(webview)) {
      return;
    }
    void probeWebviewHealthAndRecover(webview, options);
  }, delayMs);
}

async function getChatWebviewPreloadPath() {
  if (!chatWebviewPreloadPathPromise) {
    chatWebviewPreloadPathPromise = Promise.resolve(null);
  }
  return chatWebviewPreloadPathPromise;
}

async function ensureChatWebviewPreload(webview) {
  void getChatWebviewPreloadPath();
  return webview;
}

function showInitialSessionLoadingOverlay() {
  const sessionLoadingOverlay = document.getElementById(
    'main-chat-session-loading-overlay',
  );
  if (!sessionLoadingOverlay || initialSessionLoadingVisible) {
    return;
  }

  initialSessionLoadingStartedAt = Date.now();
  initialSessionLoadingVisible = true;
  initialSessionLoadingCompleted = false;
  window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, true);
  sessionLoadingOverlay.classList.add('visible');

  if (initialSessionLoadingReleaseTimer) {
    clearTimeout(initialSessionLoadingReleaseTimer);
  }
  initialSessionLoadingReleaseTimer = setTimeout(() => {
    void completeInitialSessionLoading({ force: true });
  }, INITIAL_SESSION_LOADING_MAX_MS);
}

async function completeInitialSessionLoading(options = {}) {
  const { force = false } = options;
  const sessionLoadingOverlay = document.getElementById(
    'main-chat-session-loading-overlay',
  );

  if (initialSessionLoadingCompleted) {
    return;
  }

  if (!initialSessionLoadingVisible || !sessionLoadingOverlay) {
    initialSessionLoadingCompleted = true;
    window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, false);
    return;
  }

  if (initialSessionLoadingCompletionPromise) {
    return initialSessionLoadingCompletionPromise;
  }

  initialSessionLoadingCompletionPromise = (async () => {
    const elapsedMs = initialSessionLoadingStartedAt
      ? Date.now() - initialSessionLoadingStartedAt
      : INITIAL_SESSION_LOADING_MIN_MS;
    const remainingMs = force
      ? 0
      : Math.max(0, INITIAL_SESSION_LOADING_MIN_MS - elapsedMs);
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }

    if (initialSessionLoadingReleaseTimer) {
      clearTimeout(initialSessionLoadingReleaseTimer);
      initialSessionLoadingReleaseTimer = null;
    }

    initialSessionLoadingCompleted = true;
    initialSessionLoadingVisible = false;
    sessionLoadingOverlay.classList.remove('visible');
    window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, false);
  })().finally(() => {
    initialSessionLoadingCompletionPromise = null;
  });

  return initialSessionLoadingCompletionPromise;
}

async function isOpenWebuiReady(url) {
  if (window.electronAPI?.checkOpenWebuiReady) {
    const result = await window.electronAPI.checkOpenWebuiReady();
    return result?.ready === true;
  }

  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Start auto-reconnect for webview when backend connection fails
 * @param {HTMLElement} webview - The webview element to reconnect
 * @param {string} url - The URL to reconnect to
 */
function startWebviewReconnect(webview, url) {
  // Don't start if already reconnecting
  if (reconnectInterval) {
    console.log('[Reconnect] Already attempting to reconnect...');
    return;
  }

  const statusMsg = isInitialLoad
    ? '[Reconnect] Backend not ready yet, waiting for services to start...'
    : '[Reconnect] Backend connection lost, starting auto-reconnect...';
  console.log(statusMsg);
  reconnectAttempts = 0;

  // Show reconnecting overlay with appropriate message
  showReconnectOverlay(isInitialLoad);

  reconnectInterval = setInterval(async () => {
    reconnectAttempts++;
    console.log(`[Reconnect] Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
    updateReconnectOverlay(reconnectAttempts, MAX_RECONNECT_ATTEMPTS);

    // Check if backend is available
    try {
      const ready = await isOpenWebuiReady(url);
      if (!ready) {
        throw new Error('Open WebUI not ready');
      }
      console.log('[Reconnect] Backend is ready! Reloading webview...');
      stopWebviewReconnect();

      // Small delay to ensure backend is fully ready
      setTimeout(() => {
        if (!webview?.isConnected) {
          return;
        }
        ensureRecoveryWebviewListenersAttached(webview, {
          conversationId: getConversationIdFromWebview(webview),
          fallbackUrl: url,
          reloadUrl: url,
        });
        webview.reload();
      }, 1000);
      return;
    } catch (error) {
      // Server still not available
      console.log(`[Reconnect] Backend still unavailable: ${error.message}`);
    }

    // Stop after max attempts
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[Reconnect] Max attempts reached, stopping auto-reconnect');
      stopWebviewReconnect();
      showReconnectFailed();
    }
  }, RECONNECT_INTERVAL_MS);
}

/**
 * Stop auto-reconnect attempts
 */
function stopWebviewReconnect() {
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
  }
  reconnectAttempts = 0;
  hideReconnectOverlay();
}

/**
 * Get current theme colors for overlay
 */
function getOverlayThemeColors() {
  const theme = localStorage.getItem('theme') || 'dark';
  const isDark = theme === 'dark';

  return {
    background: isDark ? 'rgba(23, 23, 23, 0.98)' : 'rgba(255, 255, 255, 0.98)',
    text: isDark ? '#e5e5e5' : '#1a1a1a',
    subtext: isDark ? '#9ca3af' : '#6b7280',
    spinnerTrack: isDark ? '#333' : '#e5e7eb',
    spinnerActive: '#3b82f6',
    buttonBg: '#3b82f6',
    buttonText: '#ffffff'
  };
}

async function collectDebugInfoFromReconnectOverlay(button) {
  const status = document.getElementById('reconnect-debug-status');
  const startedAt = Date.now();
  const defaultText = button?.textContent || 'Collect Debug Logs';

  if (!window.electronAPI?.collectDebugInfo) {
    if (status) {
      status.textContent = 'Debug collection is not available in this window.';
    }
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Collecting...';
  }
  if (status) {
    status.textContent = 'Collecting debug logs...';
  }

  try {
    window.electronAPI.logToMain?.('info', '[Debug Info] Chat overlay collection started', {
      source: 'chat-reconnect-overlay',
      startedAt,
    });
    const result = await window.electronAPI.collectDebugInfo();
    if (!result?.success || !result?.zipFile) {
      const error = result?.error || 'debug collection failed';
      if (status) {
        status.textContent = 'Failed to collect debug logs. Try again.';
      }
      window.electronAPI.logToMain?.('error', '[Debug Info] Chat overlay collection failed', {
        source: 'chat-reconnect-overlay',
        elapsedMs: Date.now() - startedAt,
        error,
      });
      return;
    }
    if (status) {
      status.textContent = `Debug logs saved: ${result.zipFile}`;
    }
    window.electronAPI.logToMain?.('info', '[Debug Info] Chat overlay collection complete', {
      source: 'chat-reconnect-overlay',
      elapsedMs: Date.now() - startedAt,
      zipFile: result.zipFile,
    });
  } catch (error) {
    if (status) {
      status.textContent = 'Something went wrong collecting debug logs.';
    }
    window.electronAPI.logToMain?.('error', '[Debug Info] Chat overlay collection errored', {
      source: 'chat-reconnect-overlay',
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error),
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = defaultText;
    }
  }
}

/**
 * Show reconnecting overlay on the chat tab
 * @param {boolean} initialLoad - Whether this is initial app load vs reconnect
 */
function showReconnectOverlay(initialLoad = false, options = {}) {
  let overlay = document.getElementById('webview-reconnect-overlay');
  const chatContainer = document.querySelector('.chat-container');
  const chatHost = document.getElementById('chat-webview');
  const suppressOwuiHost = options.suppressOwuiHost !== false;
  if (!suppressOwuiHost) {
    chatHost?.classList.remove('owui-suppressed');
  } else {
    chatHost?.classList.add('owui-suppressed');
  }
  window.syncOwuiHosts?.();

  const title = initialLoad
    ? 'Starting services...'
    : 'Reconnecting to backend...';
  const subtitle = initialLoad
    ? 'Chat will be ready shortly'
    : 'Waiting for services to restart';

  const colors = getOverlayThemeColors();

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'webview-reconnect-overlay';
    overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: ${colors.background};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      color: ${colors.text};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
    overlay.innerHTML = `
      <div style="text-align: center;">
        <div class="reconnect-spinner" style="
          width: 40px;
          height: 40px;
          border: 3px solid ${colors.spinnerTrack};
          border-top: 3px solid ${colors.spinnerActive};
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin: 0 auto 16px;
        "></div>
        <div id="reconnect-title" style="font-size: 18px; font-weight: 500; margin-bottom: 8px; color: ${colors.text};">${title}</div>
        <div id="reconnect-status" style="font-size: 14px; color: ${colors.subtext};">${subtitle}</div>
        <button id="reconnect-debug-btn" style="
          margin-top: 20px;
          padding: 8px 16px;
          background: transparent;
          color: ${colors.spinnerActive};
          border: 1px solid ${colors.spinnerActive};
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Collect Debug Logs</button>
        <button id="reconnect-retry-btn" style="
          margin-top: 12px;
          padding: 8px 16px;
          background: ${colors.buttonBg};
          color: ${colors.buttonText};
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          display: none;
        ">Retry Now</button>
        <div id="reconnect-debug-status" style="
          min-height: 18px;
          margin-top: 10px;
          font-size: 12px;
          color: ${colors.subtext};
          max-width: 420px;
          word-break: break-word;
        "></div>
      </div>
      <style>
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    `;

    const chatContainer = document.querySelector('.chat-container');
    if (chatContainer) {
      chatContainer.style.position = 'relative';
      chatContainer.appendChild(overlay);
    } else {
      return;
    }
  } else {
    // Update title and status text if overlay already exists
    const titleEl = document.getElementById('reconnect-title');
    const statusEl = document.getElementById('reconnect-status');
    if (titleEl) titleEl.textContent = title;
    if (statusEl) statusEl.textContent = subtitle;

    // Update colors in case theme changed
    overlay.style.background = colors.background;
    overlay.style.color = colors.text;
    const spinner = overlay.querySelector('.reconnect-spinner');
    if (spinner) {
      spinner.style.borderColor = colors.spinnerTrack;
      spinner.style.borderTopColor = colors.spinnerActive;
    }
    if (titleEl) titleEl.style.color = colors.text;
    if (statusEl) statusEl.style.color = colors.subtext;
    const debugBtn = document.getElementById('reconnect-debug-btn');
    const debugStatus = document.getElementById('reconnect-debug-status');
    if (debugBtn) {
      debugBtn.style.color = colors.spinnerActive;
      debugBtn.style.borderColor = colors.spinnerActive;
    }
    if (debugStatus) debugStatus.style.color = colors.subtext;
  }
  const debugBtn = document.getElementById('reconnect-debug-btn');
  if (debugBtn && !debugBtn.dataset.boundDebugCollector) {
    debugBtn.dataset.boundDebugCollector = 'true';
    debugBtn.addEventListener('click', () => {
      void collectDebugInfoFromReconnectOverlay(debugBtn);
    });
  }
  if (debugBtn) {
    debugBtn.style.display = window.electronAPI?.collectDebugInfo ? 'inline-block' : 'none';
  }
  if (overlay) {
    overlay.style.display = 'flex';
  }
}

/**
 * Update the reconnect overlay with current attempt info
 */
function updateReconnectOverlay(attempt, maxAttempts) {
  const status = document.getElementById('reconnect-status');
  if (status) {
    const prefix = isInitialLoad ? 'Starting up' : 'Reconnecting';
    status.textContent = `${prefix} - attempt ${attempt}/${maxAttempts}`;
  }
}

/**
 * Hide the reconnect overlay
 */
function hideReconnectOverlay() {
  const overlay = document.getElementById('webview-reconnect-overlay');
  const chatHost = document.getElementById('chat-webview');
  chatHost?.classList.remove('owui-suppressed');
  window.syncOwuiHosts?.();
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Show reconnect failed state with retry button
 */
function showReconnectFailed() {
  const status = document.getElementById('reconnect-status');
  const title = document.getElementById('reconnect-title');
  const retryBtn = document.getElementById('reconnect-retry-btn');
  const spinner = document.querySelector('.reconnect-spinner');

  if (title) {
    title.textContent = isInitialLoad ? 'Services taking longer than expected' : 'Connection failed';
  }
  if (status) {
    status.textContent = 'Services may still be starting. Click below to retry.';
  }
  if (spinner) {
    spinner.style.display = 'none';
  }
  if (retryBtn) {
    retryBtn.style.display = 'inline-block';
    retryBtn.onclick = () => {
      const webview = document.getElementById('chat-webview');
      if (webview) {
        retryBtn.style.display = 'none';
        if (spinner) spinner.style.display = 'block';
        startWebviewReconnect(webview, 'http://localhost:3789');
      }
    };
  }
}

function buildMainChatProbeOptions(webview, overrides = {}) {
  const options = {
    label: 'Chat',
    reloadUrl: 'http://localhost:3789',
    onHealthy: () => {
      stopWebviewReconnect();
      isInitialLoad = false;
      void completeInitialSessionLoading();
    },
    onUnhealthy: () => {
      startWebviewReconnect(webview, 'http://localhost:3789');
    },
    onRecoveryExhausted: () => {
      startWebviewReconnect(webview, 'http://localhost:3789');
    },
    ...overrides,
  };
  if (typeof options.nextProbeOptionsFactory !== 'function') {
    options.nextProbeOptionsFactory = (nextWebview) =>
      buildMainChatProbeOptions(nextWebview);
  }
  return options;
}

function getConversationReloadUrl(conversationId, fallbackUrl = 'http://localhost:3789') {
  if (window.appState?.conversationTabs?.[conversationId]?.url) {
    return window.appState.conversationTabs[conversationId].url;
  }
  return fallbackUrl;
}

function buildConversationProbeOptions(conversationId, fallbackUrl, overrides = {}) {
  const effectiveFallbackUrl = fallbackUrl || 'http://localhost:3789';
  const resolvedReloadUrl = getConversationReloadUrl(
    conversationId,
    effectiveFallbackUrl,
  );
  const options = {
    label: `CONVERSATION ${conversationId}`,
    conversationId,
    fallbackUrl: effectiveFallbackUrl,
    reloadUrl: resolvedReloadUrl,
    onRecoveryExhausted: () => {
      console.error(
        `[CONVERSATION ${conversationId}] Blank-state recovery exhausted`,
      );
    },
    ...overrides,
  };
  if (typeof options.nextProbeOptionsFactory !== 'function') {
    options.nextProbeOptionsFactory = () =>
      buildConversationProbeOptions(
        conversationId,
        getConversationReloadUrl(conversationId, effectiveFallbackUrl),
      );
  }
  return options;
}

function ensureRecoveryWebviewListenersAttached(webview, options = {}) {
  if (!webview || boundWebviews.has(webview)) {
    return;
  }

  const conversationId =
    options?.conversationId || getConversationIdFromWebview(webview);

  if (conversationId) {
    const fallbackUrl =
      options?.fallbackUrl ||
      options?.reloadUrl ||
      getConversationReloadUrl(conversationId);
    attachConversationWebviewListeners(webview, conversationId, fallbackUrl);
    return;
  }

  attachMainChatWebviewListeners(webview);
}

function attachMainChatWebviewListeners(webview) {
  if (!webview || boundWebviews.has(webview)) {
    return;
  }
  boundWebviews.add(webview);
  registerWebviewRecoveryBinding(webview, (replacementWebview) => {
    attachMainChatWebviewListeners(replacementWebview);
  });

  webview.addEventListener('dom-ready', () => {
    if (webview.dataset?.owuiHost !== 'true') {
      try {
        const webviewId = webview.getWebContentsId();

        if (window.electronAPI && window.electronAPI.setupWebviewLinkHandler) {
          window.electronAPI.setupWebviewLinkHandler(webviewId);
        }
      } catch (error) {
        console.error('Error setting up webview link handler:', error);
      }
    }

    webview.insertCSS(CHAT_CURSOR_FIX_CSS);

    if (webview.dataset?.owuiHost === 'true') {
      return;
    }

    if (window.syncThemeToWebview) {
      const currentTheme = localStorage.getItem('theme') || 'dark';
      window.syncThemeToWebview(currentTheme);
    }
  });

  webview.addEventListener('new-window', (e) => {
    console.log('New window event in control panel webview:', e.url);
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(e.url);
    }
  });

  webview.addEventListener('did-fail-load', (event) => {
    if (isExpectedNavigationAbort(event)) {
      return;
    }
    console.error('Webview failed to load:', event);
    startWebviewReconnect(webview, 'http://localhost:3789');
    scheduleWebviewHealthProbe(
      webview,
      buildMainChatProbeOptions(webview, {
        delayMs: 250,
      }),
    );
  });

  webview.addEventListener('did-finish-load', () => {
    stopWebviewReconnect();
    isInitialLoad = false;
    scheduleWebviewHealthProbe(webview, buildMainChatProbeOptions(webview));
    void completeInitialSessionLoading();
    publishChatAttentionSnapshot();
  });

  webview.addEventListener('render-process-gone', (event) => {
    console.error('[Chat] Webview render process gone:', event);
    setTabBusyState('chat', false, 'idle');
    scheduleWebviewHealthProbe(
      webview,
      buildMainChatProbeOptions(webview, {
        delayMs: 250,
      }),
    );
  });

  webview.addEventListener('console-message', (event) => {
    logWebviewConsoleMessage('[CHAT WEBVIEW]', event);
  });

  webview.addEventListener('did-navigate', (event) => {
    resetTabBusyOnChatSwitch('chat', event?.url);
  });

  webview.addEventListener('did-navigate-in-page', (event) => {
    resetTabBusyOnChatSwitch('chat', event?.url);
  });

  webview.addEventListener('tab-activity-changed', (event) => {
    applyTabActivityEvent('chat', event);
  });
}

function attachConversationWebviewListeners(webview, conversationId, fallbackUrl) {
  if (!webview || boundWebviews.has(webview)) {
    return;
  }
  boundWebviews.add(webview);
  registerWebviewRecoveryBinding(webview, (replacementWebview) => {
    if (window.appState?.conversationTabs?.[conversationId]) {
      window.appState.conversationTabs[conversationId].webviewElement = replacementWebview;
    }
    attachConversationWebviewListeners(replacementWebview, conversationId, fallbackUrl);
  });

  webview.addEventListener('page-title-updated', (e) => {
    const title = normalizeConversationTabTitle(e.detail?.title || e.title);
    const state = window.appState;
    const meta = state?.tabMeta?.[conversationId];
    if (!meta) return;

    if (!title) {
      if (meta.autoTitle) {
        meta.autoTitle = null;
        if (!meta.customTitle) {
          window.tabBar?.updateTitle(conversationId, 'New Chat');
          window.persistTabState?.();
        }
      }
      return;
    }

    meta.autoTitle = title;
    if (!meta.customTitle) {
      window.tabBar?.updateTitle(conversationId, title);
      window.persistTabState?.();
    }
  });

  webview.addEventListener('tab-activity-changed', (event) => {
    applyTabActivityEvent(conversationId, event);
  });

  webview.addEventListener('did-navigate', (event) => {
    syncConversationUrlState(conversationId, event?.url, fallbackUrl);
  });

  webview.addEventListener('did-navigate-in-page', (event) => {
    syncConversationUrlState(conversationId, event?.url, fallbackUrl);
  });

  webview.addEventListener('dom-ready', () => {
    console.log(`Conversation webview ready for ${conversationId}`);

    if (webview.dataset?.owuiHost !== 'true') {
      try {
        const webviewId = webview.getWebContentsId();
        console.log(`[CONVERSATION ${conversationId}] Webview ID:`, webviewId);

        if (window.electronAPI && window.electronAPI.setupWebviewLinkHandler) {
          console.log(`[CONVERSATION ${conversationId}] Setting up link handler...`);
          window.electronAPI.setupWebviewLinkHandler(webviewId);
          console.log(`[CONVERSATION ${conversationId}] Link handler setup complete`);
        } else {
          console.error('setupWebviewLinkHandler not available!');
        }
      } catch (error) {
        console.error(`[CONVERSATION ${conversationId}] Error setting up link handler:`, error);
      }
    }

    webview.insertCSS(CHAT_CURSOR_FIX_CSS);
    console.log(`[CONVERSATION ${conversationId}] CSS injected`);

    if (webview.dataset?.owuiHost === 'true') {
      return;
    }

    if (window.syncThemeToWebview) {
      const currentTheme = localStorage.getItem('theme') || 'dark';
      const openWebuiTheme = currentTheme;
      const metaThemeColor = openWebuiTheme === 'dark' ? '#171717' : '#ffffff';
      const contextUtilizationCss = `
        html.dark .min-w-\\[240px\\].max-w-\\[320px\\].dark\\:bg-gray-800,
        html.dark .min-w-\\[160px\\].max-w-\\[280px\\].dark\\:bg-gray-800,
        html.dark .absolute.bottom-full.left-1\\/2.-translate-x-1\\/2.dark\\:bg-gray-800 {
          background-color: #000000 !important;
        }

        html.dark .min-w-\\[240px\\].max-w-\\[320px\\] .dark\\:border-t-gray-800,
        html.dark .min-w-\\[160px\\].max-w-\\[280px\\] .dark\\:border-t-gray-800,
        html.dark .absolute.bottom-full.left-1\\/2.-translate-x-1\\/2 .dark\\:border-t-gray-800 {
          border-top-color: #000000 !important;
        }

        html.dark .group.relative.flex.items-center.gap-1.ml-3.cursor-pointer svg.-rotate-90 circle[stroke-linecap="round"] {
          stroke: #ffffff !important;
        }
      `;
      const serializedContextCss = JSON.stringify(contextUtilizationCss);
      const syncScript = `
        (function() {
          localStorage.setItem('theme', '${openWebuiTheme}');
          document.documentElement.classList.remove('dark', 'light', 'her');
          document.documentElement.classList.add('${openWebuiTheme}');
          const meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.setAttribute('content', '${metaThemeColor}');
          if ('${openWebuiTheme}' === 'dark') {
            document.documentElement.style.setProperty('--color-gray-800', '#333');
            document.documentElement.style.setProperty('--color-gray-850', '#262626');
            document.documentElement.style.setProperty('--color-gray-900', '#171717');
            document.documentElement.style.setProperty('--color-gray-950', '#0d0d0d');
          }

          const styleId = 'owui-context-utilization-theme';
          let styleEl = document.getElementById(styleId);
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
          }
          styleEl.textContent = ${serializedContextCss};
        })();
      `;

      void safeExecuteWebviewScript(webview, syncScript, {
        label: `CONVERSATION ${conversationId}`,
        tag: 'theme-sync',
      }).then((result) => {
        if (!result.ok) {
          console.log(`[CONVERSATION ${conversationId}] Theme sync failed`);
        }
      });
      console.log(`[CONVERSATION ${conversationId}] Theme synced:`, currentTheme);
    }
  });

  webview.addEventListener('new-window', (e) => {
    console.log(`[CONVERSATION ${conversationId}] New window event:`, e.url);
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(e.url);
    }
  });

  webview.addEventListener('did-fail-load', (event) => {
    if (isExpectedNavigationAbort(event)) {
      return;
    }
    console.error(`[CONVERSATION ${conversationId}] Webview failed to load:`, event);
    setTabBusyState(conversationId, false, 'idle');
    scheduleWebviewHealthProbe(
      webview,
      buildConversationProbeOptions(conversationId, fallbackUrl, {
        delayMs: 250,
      }),
    );
  });

  webview.addEventListener('did-finish-load', () => {
    console.log(`[CONVERSATION ${conversationId}] Webview finished loading`);
    syncConversationUrlState(conversationId, getLiveOwuiUrl(webview, fallbackUrl), fallbackUrl);
    setTabBusyState(conversationId, false, 'idle');
    publishChatAttentionSnapshot();
    scheduleWebviewHealthProbe(
      webview,
      buildConversationProbeOptions(conversationId, fallbackUrl),
    );
  });

  webview.addEventListener('render-process-gone', (event) => {
    console.error(`[CONVERSATION ${conversationId}] Render process gone:`, event);
    setTabBusyState(conversationId, false, 'idle');
    scheduleWebviewHealthProbe(
      webview,
      buildConversationProbeOptions(conversationId, fallbackUrl, {
        delayMs: 250,
      }),
    );
  });

  webview.addEventListener('console-message', (event) => {
    logWebviewConsoleMessage(`[CONVERSATION ${conversationId} WEBVIEW]`, event);
  });
}

async function recoverVisibleWebview(payload = {}) {
  const activeTab = window.appState?.activeTab || 'chat';
  const reason = payload?.reason || 'main-frame-send-failure';

  if (activeTab.startsWith('conversation-')) {
    const conversationId = activeTab.replace('conversation-', '');
    const conversationWebview = document.getElementById(
      `conversation-webview-${conversationId}`,
    );
    if (conversationWebview) {
      await triggerHardWebviewRecovery(
        conversationWebview,
        buildConversationProbeOptions(
          conversationId,
          getConversationReloadUrl(conversationId),
          {
            reason,
          },
        ),
      );
      return;
    }
  }

  const chatWebview = document.getElementById('chat-webview');
  if (chatWebview) {
    await triggerHardWebviewRecovery(
      chatWebview,
      buildMainChatProbeOptions(chatWebview, {
        reason,
      }),
    );
  } else {
    console.warn('[Chat] No active webview found for forced recovery', payload);
  }
}

function setupForceWebviewRecoveryListener() {
  if (forceRecoveryListenerRegistered) {
    return;
  }

  if (!window.electronAPI?.onForceWebviewRecovery) {
    return;
  }

  forceRecoveryListenerRegistered = true;
  window.electronAPI.onForceWebviewRecovery((payload = {}) => {
    const now = Date.now();
    if (now - lastForcedRecoveryAt < WEBVIEW_FORCED_RECOVERY_COOLDOWN_MS) {
      return;
    }

    lastForcedRecoveryAt = now;
    console.warn('[Chat] Received forced webview recovery signal:', payload);
    void recoverVisibleWebview(payload);
  });
}

setupForceWebviewRecoveryListener();

function getVisibleWebviewForResumeProbe() {
  const activeTab = String(window.appState?.activeTab || 'chat');
  if (activeTab.startsWith('conversation-')) {
    const conversationId = activeTab.replace('conversation-', '');
    const webview = document.getElementById(`conversation-webview-${conversationId}`);
    return webview ? { webview, conversationId } : null;
  }
  if (activeTab !== 'chat') {
    return null;
  }
  const webview = document.getElementById('chat-webview');
  return webview ? { webview, conversationId: null } : null;
}

async function probeVisibleWebviewAfterSystemResume(payload = {}) {
  const target = getVisibleWebviewForResumeProbe();
  if (!target || !isWebviewVisible(target.webview)) {
    return;
  }

  const { webview, conversationId } = target;
  const reloadUrl = conversationId
    ? getConversationReloadUrl(conversationId)
    : 'http://localhost:3789';
  const backendReady = await isOpenWebuiReady(reloadUrl);
  if (!backendReady) {
    if (!conversationId) {
      startWebviewReconnect(webview, reloadUrl);
    }
    return;
  }

  const baseOptions = conversationId
    ? buildConversationProbeOptions(conversationId, reloadUrl)
    : buildMainChatProbeOptions(webview);
  const healthy = await probeWebviewHealthAndRecover(webview, {
    ...baseOptions,
    allowAutoReload: false,
    onUnhealthy: null,
    onRecoveryExhausted: null,
  });
  if (healthy || !webview.isConnected) {
    return;
  }

  console.warn('[Power] Visible chat failed its delayed resume probe; reloading in place', payload);
  resetWebviewRecoveryState(webview);
  ensureRecoveryWebviewListenersAttached(webview, baseOptions);
  if (typeof webview.reload === 'function') {
    await webview.reload();
  } else if (typeof webview.loadURL === 'function') {
    await webview.loadURL(reloadUrl);
  }
}

function setupSystemResumeListener() {
  if (systemResumeListenerRegistered || !window.electronAPI?.onSystemResume) {
    return;
  }

  systemResumeListenerRegistered = true;
  window.electronAPI.onSystemResume((payload = {}) => {
    // Timers and connection attempts that straddled sleep are no longer
    // trustworthy. Cancel them quietly, then wait for macOS networking and
    // Docker to settle before inspecting the currently visible view.
    stopWebviewReconnect();
    if (systemResumeProbeTimer) {
      clearTimeout(systemResumeProbeTimer);
    }
    systemResumeProbeTimer = setTimeout(() => {
      systemResumeProbeTimer = null;
      void probeVisibleWebviewAfterSystemResume(payload).catch((error) => {
        console.warn('[Power] Delayed chat resume probe failed:', error?.message || error);
      });
    }, SYSTEM_RESUME_PROBE_DELAY_MS);
  });
}

setupSystemResumeListener();

// Load chat interface in iframe
function loadChatInterface() {
  const state = window.appState;

  // Early return if already loaded - prevents console spam from repeated calls
  if (state.chatLoaded) {
    return;
  }

  console.log('[Chat] loadChatInterface called');
  const webview = ensureOwuiHostElement(document.getElementById('chat-webview'), {
    viewKey: getOwuiViewKeyForWebview(document.getElementById('chat-webview')),
    windowType: getOwuiWindowTypeForWebview(document.getElementById('chat-webview')),
  });
  const placeholder = document.getElementById('chat-placeholder');

  // Always attempt to load the webview - the retry logic will handle
  // cases where the backend isn't ready yet
  if (webview) {
    console.log('[Chat] Setting up webview and loading...');
    showInitialSessionLoadingOverlay();
    attachMainChatWebviewListeners(webview);

    // Show loading overlay immediately while we attempt to load
    // This ensures users see feedback right away if backend isn't ready
    showReconnectOverlay(true, {
      suppressOwuiHost: false,
    });
    state.chatLoaded = true;

    void ensureChatWebviewPreload(webview).finally(() => {
      markWebviewShown(webview);
      webview.classList.remove('hidden');
      window.syncOwuiHosts?.();

      // Load the URL after preload is set and the host is visible, so the
      // initial WebContentsView creation gets real bounds and visibility.
      webview.src = 'http://localhost:3789';
      void attachOwuiViewAndSyncActiveKey(webview, 'chat');
    });
  }
  if (placeholder) {
    placeholder.style.display = 'none';
  }
}

// Tab switching
let controlPlaneActivationWorkToken = 0;

function scheduleAfterNextPaint(callback) {
  const run = () => callback();
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(run);
    });
    return;
  }
  setTimeout(run, 0);
}

function scheduleControlPlaneActivationWork(state) {
  const token = ++controlPlaneActivationWorkToken;
  scheduleAfterNextPaint(() => {
    const currentState = window.appState || state;
    if (
      token !== controlPlaneActivationWorkToken ||
      currentState?.activeTab !== 'control'
    ) {
      return;
    }

    if (window.initControlPlaneV2) {
      window.initControlPlaneV2();
    }

    if (
      currentState?.controlPlaneView === 'mcp-servers' &&
      window.updateMcpServersList
    ) {
      window.updateMcpServersList();
      if (window.refreshToolsCountForHealthyServers) {
        window.refreshToolsCountForHealthyServers({ forceRender: true });
      }
    } else if (
      currentState?.controlPlaneView === 'agent-skills' &&
      window.showAgentSkillsView
    ) {
      window.showAgentSkillsView({ refresh: true });
    } else if (
      currentState?.controlPlaneView === 'agents-tab' &&
      window.AgentsTabModule?.show
    ) {
      window.AgentsTabModule.show();
    } else if (
      currentState?.controlPlaneView === 'cost-dashboard' &&
      window.refreshCostDashboard
    ) {
      window.refreshCostDashboard();
    } else if (
      currentState?.controlPlaneView === 'updates' &&
      window.UpdatesViewHooks?.showUpdatesView
    ) {
      // Returning to the Control tab counts as arriving at the Updates tab:
      // showUpdatesView re-asserts visibility and auto-runs the Refresh.
      window.UpdatesViewHooks.showUpdatesView();
    }
  });
}

function switchTab(tabName) {
  const state = window.appState;
  if (state) {
    state.activeTab = tabName;
  }
  if (tabName !== 'control') {
    controlPlaneActivationWorkToken += 1;
  }

  const tabId = tabName.startsWith('conversation-')
    ? tabName.replace('conversation-', '')
    : tabName;
  setTabUnreadState(tabId, false);

  window.tabBar?.setActive(tabName);

  let viewKey = null;
  if (tabName === 'chat') {
    const chatWebview = document.getElementById('chat-webview');
    viewKey = getOwuiViewKeyForWebview(chatWebview);
  } else if (tabName.startsWith('conversation-')) {
    const cid = tabName.replace('conversation-', '');
    const conversationWebview = document.getElementById(`conversation-webview-${cid}`);
    if (conversationWebview) {
      syncConversationUrlState(cid, getLiveOwuiUrl(conversationWebview), window.appState?.conversationTabs?.[cid]?.url);
    }
    viewKey = getOwuiViewKeyForWebview(conversationWebview, cid);
  }
  if (window.electronAPI?.setActiveViewKey) {
    window.electronAPI.setActiveViewKey(viewKey || null);
  }

  window.persistTabState?.();

  // Hide tooltip when switching tabs and reset hover state
  lastHoverState = false;
  const tooltip = document.getElementById('mcp-tooltip');
  if (tooltip) {
    tooltip.style.display = 'none';
    tooltip.style.opacity = '0';
    tooltip.style.visibility = 'hidden';
    tooltip.style.pointerEvents = 'none';
  }
  window.electronAPI?.mcpTooltip?.hide?.().catch(() => {});
  window.syncOwuiHosts?.();
  // Chat-scoped native input modals present only while their own chat is
  // active, so they must re-evaluate on a tab switch. The modals otherwise
  // listen for `owui-committed-url-changed`, which owui-host only dispatches
  // when a view's URL actually changes -- switching tabs never does, so without
  // this a pending prompt stays bound to the previous chat and its suppression
  // is never released.
  void window.syncSensitiveInfoModalForNavigation?.();
  void window.syncChatWorkspaceConsentModalForNavigation?.();

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  window.syncControlPlaneToggleActive?.(tabName === 'control');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });

  const targetTab = document.getElementById(`${tabName}-tab`);
  if (targetTab) {
    targetTab.classList.add('active');

    // Handle webview visibility based on tab
    const webview = document.getElementById('chat-webview');
    if (webview) {
      if (tabName === 'chat') {
        webview.classList.remove('hidden');
        markWebviewShown(webview);
        scheduleWebviewHealthProbe(webview, buildMainChatProbeOptions(webview));
        // Load chat interface if switching to chat tab for the first time
        if (!state.chatLoaded) {
          loadChatInterface();
        }
      } else {
        // Hide webview when switching to control plane or debugger tabs
        webview.classList.add('hidden');
      }
    }

    // Initialize Control Plane V2 when switching to control tab
    if (tabName === 'control') {
      scheduleControlPlaneActivationWork(state);
    }

    // Hide all debugger webviews when switching away from debugger tabs
    Object.keys(state.debuggerTabs).forEach(serverId => {
      const debugWebview = document.getElementById(`debugger-webview-${serverId}`);
      if (debugWebview) {
        if (tabName === `mcp-debugger-${serverId}`) {
          debugWebview.classList.remove('hidden');
        } else {
          debugWebview.classList.add('hidden');
        }
      }
    });

    // Restore suspended tab if needed
    if (tabName.startsWith('conversation-')) {
      const cid = tabName.replace('conversation-', '');
      ensureConversationWebviewMounted(cid);
    }

    // Hide all conversation webviews when switching away from conversation tabs
    Object.keys(state.conversationTabs).forEach(conversationId => {
      const conversationWebview = document.getElementById(`conversation-webview-${conversationId}`);
      if (conversationWebview) {
        if (tabName === `conversation-${conversationId}`) {
          conversationWebview.classList.remove('hidden');
          markWebviewShown(conversationWebview);
          const conversation = state.conversationTabs[conversationId];
          scheduleWebviewHealthProbe(
            conversationWebview,
            buildConversationProbeOptions(
              conversationId,
              conversation?.url || 'http://localhost:3789',
            ),
          );
        } else {
          conversationWebview.classList.add('hidden');
        }
      }
    });
    window.syncServiceDrawerLayout?.();
    scheduleActiveTabFocusHandoff(tabName);
    // Re-update MCP badge to ensure tooltip works after tab switch
    // Use health-aware badge update if health status is available
    if (state.healthStatus) {
      if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
    } else {
      const configuredServers = state.servers.filter(s => s.isConfigured);
      let enabledServers = configuredServers.filter(
        (s) => s.isCore || state.toggles[s.id] === true,
      );

      // Filter out HOST servers if HOST_MODE is not supported
      if (!state.hostModeSupported) {
        enabledServers = enabledServers.filter(s => (s.deploymentType || 'docker') !== 'host');
      }

      if (window.updateMcpBadge) window.updateMcpBadge(enabledServers);
    }
  }

  updateConversationTabActiveTimestamps(tabName);
  window.artifactPanel?.activateForCurrentTab?.(tabName);
  window.McpOperationOverlayController?.handleActiveTabChange?.(tabName);
  const activeChatId = getRuntimeChatIdForTab(tabId, state);
  if (activeChatId) {
    window.backendModalAttention?.claimForChat?.(activeChatId, tabId);
  }
  window.backendModalAttention?.drainForTab?.(tabId);
  maybeUnloadBackgroundTabs(tabName);
}

const BACKGROUND_TAB_UNLOAD_GRACE_MS = 15 * 60 * 1000;
const BACKGROUND_TAB_WARM_CACHE_LIMIT = 1;
const tabLastActive = {};
const tabBecameInactiveAt = {};
const suspendedTabs = new Set();
let backgroundTabUnloadTimer = null;

function getDynamicConversationTabIds(state = window.appState) {
  return (state?.tabOrder || []).filter(id => !['control', 'chat'].includes(id));
}

function getPendingModalCountForTab(tabId) {
  try {
    return Math.max(0, Number(window.backendModalAttention?.getPendingCountForTab?.(tabId)) || 0);
  } catch (_error) {
    return 0;
  }
}

function hasMountedConversationWebview(conversationId) {
  const conversation = window.appState?.conversationTabs?.[conversationId];
  const webview =
    conversation?.webviewElement ||
    document.getElementById(`conversation-webview-${conversationId}`);
  return Boolean(webview && webview.isConnected !== false);
}

function isConversationTabUnloadProtected(conversationId, activeFullTabId = window.appState?.activeTab) {
  const state = window.appState;
  if (!state) return true;
  if (activeFullTabId === `conversation-${conversationId}`) return true;

  const meta = state.tabMeta?.[conversationId] || {};
  return (
    meta.busy === true ||
    meta.attentionRequired === true ||
    getPendingModalCountForTab(conversationId) > 0
  );
}

function updateConversationTabActiveTimestamps(activeFullTabId) {
  const now = Date.now();
  for (const conversationId of getDynamicConversationTabIds()) {
    if (activeFullTabId === `conversation-${conversationId}`) {
      tabLastActive[conversationId] = now;
      delete tabBecameInactiveAt[conversationId];
      continue;
    }
    if (!tabBecameInactiveAt[conversationId]) {
      tabBecameInactiveAt[conversationId] = now;
    }
  }
}

function getUnloadEligibleConversationIds(activeFullTabId = window.appState?.activeTab, now = Date.now()) {
  const state = window.appState;
  if (!state) return [];

  const mountedIdleTabs = getDynamicConversationTabIds(state)
    .filter(id =>
      hasMountedConversationWebview(id) &&
      !suspendedTabs.has(id) &&
      !isConversationTabUnloadProtected(id, activeFullTabId)
    )
    .sort((a, b) => (tabLastActive[b] || 0) - (tabLastActive[a] || 0));

  const unloadableTabs = mountedIdleTabs.slice(BACKGROUND_TAB_WARM_CACHE_LIMIT);
  return unloadableTabs.filter(id => {
    const inactiveAt = tabBecameInactiveAt[id] || now;
    return now - inactiveAt >= BACKGROUND_TAB_UNLOAD_GRACE_MS;
  });
}

function getNextBackgroundUnloadDelay(activeFullTabId = window.appState?.activeTab, now = Date.now()) {
  const state = window.appState;
  if (!state) return null;

  const mountedIdleTabs = getDynamicConversationTabIds(state)
    .filter(id =>
      hasMountedConversationWebview(id) &&
      !suspendedTabs.has(id) &&
      !isConversationTabUnloadProtected(id, activeFullTabId)
    )
    .sort((a, b) => (tabLastActive[b] || 0) - (tabLastActive[a] || 0))
    .slice(BACKGROUND_TAB_WARM_CACHE_LIMIT);

  let nextDelay = null;
  for (const id of mountedIdleTabs) {
    const inactiveAt = tabBecameInactiveAt[id] || now;
    const delay = Math.max(0, BACKGROUND_TAB_UNLOAD_GRACE_MS - (now - inactiveAt));
    nextDelay = nextDelay === null ? delay : Math.min(nextDelay, delay);
  }
  return nextDelay;
}

function unloadConversationWebview(conversationId, reason = 'idle-background') {
  const state = window.appState;
  const conversation = state?.conversationTabs?.[conversationId];
  const webview =
    conversation?.webviewElement ||
    document.getElementById(`conversation-webview-${conversationId}`);
  if (!conversation || !webview) {
    return false;
  }

  resetWebviewRecoveryState(webview);
  disposeOwuiHostElement(webview, { destroyView: true });
  if (typeof webview.remove === 'function') {
    webview.remove();
  }
  conversation.webviewElement = null;
  conversation.mountPromise = null;
  suspendedTabs.add(conversationId);
  console.log(`[TabBar] Unloaded background tab: ${conversationId} (${reason})`);
  return true;
}

function scheduleBackgroundTabUnloadCheck() {
  if (backgroundTabUnloadTimer) {
    clearTimeout(backgroundTabUnloadTimer);
    backgroundTabUnloadTimer = null;
  }

  const delay = getNextBackgroundUnloadDelay();
  if (delay === null) {
    return;
  }

  backgroundTabUnloadTimer = setTimeout(() => {
    backgroundTabUnloadTimer = null;
    maybeUnloadBackgroundTabs();
  }, delay);
}

function maybeUnloadBackgroundTabs(activeFullTabId = window.appState?.activeTab) {
  const now = Date.now();
  for (const conversationId of getUnloadEligibleConversationIds(activeFullTabId, now)) {
    if (!isConversationTabUnloadProtected(conversationId, activeFullTabId)) {
      unloadConversationWebview(conversationId);
    }
  }
  scheduleBackgroundTabUnloadCheck();
}

function ensureConversationWebviewMounted(conversationId, options = {}) {
  const state = window.appState;
  const conversation = state?.conversationTabs?.[conversationId];
  if (!conversation) return null;

  const existingWebview =
    conversation.webviewElement ||
    document.getElementById(`conversation-webview-${conversationId}`);
  if (existingWebview && existingWebview.isConnected !== false) {
    conversation.webviewElement = existingWebview;
    suspendedTabs.delete(conversationId);
    return existingWebview;
  }

  const container = document.getElementById(`chat-container-${conversationId}`);
  if (!container) return null;

  const requestedUrl =
    options.navigationUrl ||
    conversation.url ||
    state.tabMeta?.[conversationId]?.url ||
    'http://localhost:3789';
  const persistedUrl = normalizeOwuiShellUrl(requestedUrl);
  const viewKey = conversation.viewKey || `conversation:${conversationId}`;
  const hostWindowType =
    conversation.hostWindowType ||
    (viewKey.startsWith('conversation:')
      ? 'conversation'
      : (state?.tabMeta?.[conversationId]?.type === 'chat' ? 'chat' : 'conversation'));
  const webview = buildOwuiHostElement({
    id: `conversation-webview-${conversationId}`,
    className: 'chat-webview',
    viewKey,
    windowType: hostWindowType,
    conversationId,
  });
  webview.classList.toggle('hidden', state.activeTab !== `conversation-${conversationId}`);

  container.appendChild(webview);
  conversation.webviewElement = webview;
  conversation.url = persistedUrl;
  conversation.viewKey = viewKey;
  conversation.hostWindowType = hostWindowType;
  suspendedTabs.delete(conversationId);
  attachConversationWebviewListeners(webview, conversationId, persistedUrl);

  conversation.mountPromise = ensureChatWebviewPreload(webview).finally(() => {
    if (conversation.webviewElement !== webview || webview.isConnected === false) {
      return;
    }
    webview.src = requestedUrl;
    void attachOwuiViewAndSyncActiveKey(
      webview,
      `conversation-${conversationId}`,
      conversationId,
    );
    scheduleWebviewHealthProbe(
      webview,
      buildConversationProbeOptions(conversationId, persistedUrl, { delayMs: 1200 }),
    );
    conversation.mountPromise = null;
  });

  console.log(`[TabBar] Mounted conversation tab: ${conversationId}`);
  return webview;
}

window.ensureConversationWebviewMounted = ensureConversationWebviewMounted;

// MCP Debugger Functions

// Get MCPO debug URL based on server type
function getMcpoDebugUrl(serverId, deploymentType, isCore) {
  let port;

  if (isCore) {
    port = 8766; // Core MCPO
  } else if (deploymentType === 'host') {
    port = 8890; // Host MCPO
  } else {
    port = 8765; // Regular Docker MCPO
  }

  return `http://localhost:${port}/${serverId}/docs`;
}

// Open MCP debugger tab for a server
function openMcpDebugger(serverId, serverName, deploymentType, isCore) {
  const state = window.appState;

  // Check if tab already exists
  if (state.debuggerTabs[serverId]) {
    // Focus existing tab
    switchTab(`mcp-debugger-${serverId}`);
    return;
  }

  // Get debug URL
  const debugUrl = getMcpoDebugUrl(serverId, deploymentType, isCore);
  console.log(`Opening debugger for ${serverName} at ${debugUrl}`);

  // Create tab button in navigation
  const tabNavigation = document.querySelector('.tab-strip') || document.querySelector('.tab-navigation');
  const tabButton = document.createElement('button');
  tabButton.className = 'tab-btn';
  tabButton.dataset.tab = `mcp-debugger-${serverId}`;
  tabButton.innerHTML = `
    <span class="tab-icon">🐛</span>
    <span class="tab-label">MCP Debugger (${serverName})</span>
    <button class="tab-close-btn" data-server-id="${serverId}" title="Close debugger">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  // Add click handler for tab (but not for close button)
  tabButton.addEventListener('click', (e) => {
    if (!e.target.closest('.tab-close-btn')) {
      switchTab(`mcp-debugger-${serverId}`);
    }
  });

  // Add click handler for close button
  const closeBtn = tabButton.querySelector('.tab-close-btn');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMcpDebuggerTab(serverId);
  });

  tabNavigation.appendChild(tabButton);

  // Create tab content with webview
  const mainContent = document.querySelector('.main-content');
  const tabContent = document.createElement('div');
  tabContent.className = 'tab-content';
  tabContent.id = `mcp-debugger-${serverId}-tab`;
  tabContent.style.padding = '0';
  tabContent.style.position = 'relative';

  const webview = document.createElement('webview');
  webview.id = `debugger-webview-${serverId}`;
  webview.className = 'debugger-webview';
  webview.src = debugUrl;
  webview.partition = 'persist:mcpo-debugger';
  webview.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no');

  // Set up webview event listeners
  webview.addEventListener('dom-ready', () => {
    console.log(`Debugger webview ready for ${serverName}`);

    // Force light mode at document level using JavaScript FIRST
    void safeExecuteWebviewScript(webview, `
      // Force light color scheme at the root level
      document.documentElement.style.colorScheme = 'light';
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.style.colorScheme = 'light';

      // Add meta tag to force light mode
      const metaTag = document.createElement('meta');
      metaTag.name = 'color-scheme';
      metaTag.content = 'light';
      if (!document.querySelector('meta[name="color-scheme"]')) {
        document.head.appendChild(metaTag);
      }

      console.log('Light mode forced via JavaScript at document level');
    `, {
      label: `DEBUGGER ${serverId}`,
      tag: 'force-light-mode',
    }).then((result) => {
      if (result.ok) {
        console.log(`Light mode JavaScript executed for ${serverName} debugger`);
      } else {
        console.error(`Failed to execute light mode script for ${serverName}`);
      }
    });

    // Also inject comprehensive CSS for Swagger UI and syntax highlighting
    const lightModeCss = `
      /* Force light mode globally */
      html, body {
        background: #ffffff !important;
        color: #1a1a1a !important;
        color-scheme: light !important;
      }

      /* Override all containers */
      div, section, header, footer, nav, aside, main, article {
        background-color: transparent !important;
      }

      /* Fix Swagger UI specific elements */
      .swagger-ui,
      .swagger-ui .wrapper,
      .swagger-ui .info,
      .swagger-ui .scheme-container,
      .swagger-ui .topbar {
        background: #ffffff !important;
        color: #1a1a1a !important;
      }

      /* Fix operation blocks */
      .swagger-ui .opblock,
      .swagger-ui .opblock-summary,
      .swagger-ui .opblock-body {
        background: #fafafa !important;
        color: #1a1a1a !important;
        border-color: #d1d5db !important;
      }

      /* Fix parameters and responses */
      .swagger-ui .parameters,
      .swagger-ui .responses-wrapper,
      .swagger-ui table thead tr td,
      .swagger-ui table thead tr th {
        background: #f9fafb !important;
        color: #1a1a1a !important;
      }

      /* Fix ALL code blocks and pre elements */
      pre, code, .highlight {
        background: #f5f5f5 !important;
        color: #1a1a1a !important;
      }

      .swagger-ui pre,
      .swagger-ui pre code,
      .swagger-ui code,
      .swagger-ui .microlight {
        background: #f5f5f5 !important;
        color: #1a1a1a !important;
      }

      /* Force light syntax highlighting - Highlight.js */
      .hljs {
        background: #f5f5f5 !important;
        color: #1a1a1a !important;
      }

      .hljs-string, .hljs-attr {
        color: #22863a !important;
      }

      .hljs-number, .hljs-literal, .hljs-built_in, .hljs-keyword {
        color: #005cc5 !important;
      }

      .hljs-name, .hljs-tag {
        color: #116329 !important;
      }

      .hljs-comment {
        color: #6a737d !important;
      }

      /* Force light syntax highlighting - Prism.js / token based */
      .token.string, .token.attr-value {
        color: #22863a !important;
      }

      .token.property, .token.tag, .token.boolean, .token.number,
      .token.function, .token.keyword, .token.constant {
        color: #005cc5 !important;
      }

      .token.punctuation, .token.operator {
        color: #24292e !important;
      }

      .token.comment, .token.prolog, .token.doctype {
        color: #6a737d !important;
      }

      .token.null {
        color: #d73a49 !important;
      }

      /* Fix microlight (FastAPI default) */
      .microlight {
        background: #f6f8fa !important;
      }

      /* Fix models section */
      .swagger-ui .model-box,
      .swagger-ui .model {
        background: #f9fafb !important;
        color: #1a1a1a !important;
      }

      /* Fix input fields */
      .swagger-ui input[type="text"],
      .swagger-ui textarea,
      .swagger-ui select {
        background: #ffffff !important;
        color: #1a1a1a !important;
        border: 1px solid #d1d5db !important;
      }

      /* Fix buttons */
      .swagger-ui .btn {
        color: #1a1a1a !important;
      }

      /* Fix tables */
      .swagger-ui table {
        background: #ffffff !important;
        color: #1a1a1a !important;
      }

      .swagger-ui table tbody tr {
        background: #ffffff !important;
        border-color: #e5e7eb !important;
      }

      /* Fix description and markdown */
      .swagger-ui .markdown *,
      .swagger-ui .description,
      .swagger-ui .renderedMarkdown * {
        color: #1a1a1a !important;
      }

      /* Ensure all text is dark */
      p, span, li, td, th, h1, h2, h3, h4, h5, h6, label {
        color: #1a1a1a !important;
      }
    `;

    webview.insertCSS(lightModeCss);
    console.log(`Light mode CSS injected for ${serverName} debugger`);
  });

  webview.addEventListener('did-fail-load', (event) => {
    console.error(`Debugger webview failed to load for ${serverName}:`, event);
  });

  webview.addEventListener('console-message', (event) => {
    logWebviewConsoleMessage(`[DEBUGGER ${serverId} WEBVIEW]`, event);
  });

  tabContent.appendChild(webview);
  mainContent.appendChild(tabContent);

  // Track the tab
  state.debuggerTabs[serverId] = {
    name: serverName,
    deploymentType: deploymentType,
    isCore: isCore
  };

  // Switch to the new tab
  switchTab(`mcp-debugger-${serverId}`);
}

// Close MCP debugger tab
function closeMcpDebuggerTab(serverId) {
  const state = window.appState;

  // Remove tab button
  const tabButton = document.querySelector(`.tab-btn[data-tab="mcp-debugger-${serverId}"]`);
  if (tabButton) {
    tabButton.remove();
  }

  // Remove tab content
  const tabContent = document.getElementById(`mcp-debugger-${serverId}-tab`);
  if (tabContent) {
    tabContent.remove();
  }

  // Remove from tracking
  delete state.debuggerTabs[serverId];

  // Switch to Control Plane tab
  switchTab('control');
}

// Conversation Tab Functions - EXACT code from services/renderer.js

function buildNewChatUrl(options = {}) {
  const url = new URL(OPEN_WEBUI_HOME_URL);
  const modelId = String(options?.modelId || '').trim();
  const prompt = String(options?.prompt || '').trim();

  if (modelId) {
    url.searchParams.set('models', modelId);
  }
  if (prompt) {
    url.searchParams.set('q', prompt);
    url.searchParams.set('submit', 'true');
  }

  return url.toString();
}

// Open a fresh chat tab, optionally selecting a model and submitting a prompt.
function openNewChatTab(options = {}) {
  const conversationId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const title = String(options?.title || '').trim() || 'New Chat';
  return openConversationTab(buildNewChatUrl(options), conversationId, {
    title,
    type: 'chat',
  });
}

// Open conversation detail tab
function openConversationTab(url, conversationId, options = {}) {
  const state = window.appState;

  if (state.conversationTabs[conversationId]) {
    switchTab(`conversation-${conversationId}`);
    return true;
  }

  const navigationUrl = String(url || 'http://localhost:3789');
  const persistedUrl = normalizeOwuiShellUrl(navigationUrl);
  const tabTitle = options.title || 'Subagent';
  const tabType = options.type || 'subagent';
  const skipSwitch = options.skipSwitch === true;
  const viewKey = options.viewKey || `conversation:${conversationId}`;
  const hostWindowType =
    options.hostWindowType ||
    (viewKey.startsWith('conversation:') ? 'conversation' : tabType);

  console.log(`Opening conversation tab for ${conversationId} at ${url}`);

  const added = window.tabBar?.addTab(conversationId, {
    title: tabTitle,
    type: tabType,
    url: persistedUrl,
    skipSwitch: true,
  });
  if (added === false) return false;

  const mainContent = document.querySelector('.main-content');
  const tabContent = document.createElement('div');
  tabContent.className = 'tab-content';
  tabContent.id = `conversation-${conversationId}-tab`;
  // CSS rules for conversation tabs handle all styling (see styles.css)

  const chatContainer = document.createElement('div');
  chatContainer.className = 'chat-container';
  chatContainer.id = `chat-container-${conversationId}`;

  const artifactWrapper = document.createElement('div');
  artifactWrapper.className = 'chat-and-artifact-wrapper';
  artifactWrapper.dataset.artifactTabKey = `conversation-${conversationId}`;
  artifactWrapper.appendChild(chatContainer);

  tabContent.appendChild(artifactWrapper);
  mainContent.appendChild(tabContent);

  const tabButton = document.querySelector(`.tab-btn[data-tab="conversation-${conversationId}"]`);
  state.conversationTabs[conversationId] = {
    url: persistedUrl,
    tabElement: tabButton,
    webviewElement: null,
    viewKey,
    hostWindowType,
  };

  if (!skipSwitch) {
    ensureConversationWebviewMounted(conversationId, { navigationUrl });
    switchTab(`conversation-${conversationId}`);
  } else if (options.deferLoad !== true || options.attentionRequired === true) {
    ensureConversationWebviewMounted(conversationId, { navigationUrl });
  }

  publishChatAttentionSnapshot();
  return true;
}

function getVisibleTabCountForCapCheck(state = window.appState) {
  const visibleOrder = window.tabBar?.getTabOrder?.();
  if (Array.isArray(visibleOrder)) {
    return visibleOrder.length;
  }
  return (state?.tabOrder || []).filter(id => id !== 'control').length;
}

function canOpenAdditionalConversationTab(conversationId, state = window.appState) {
  if (state?.conversationTabs?.[conversationId]) {
    return true;
  }

  const maxVisibleTabs = window.tabBar?.MAX_VISIBLE_TABS || 5;
  return getVisibleTabCountForCapCheck(state) < maxVisibleTabs;
}

function getReusableConversationTabTitle(options = {}) {
  return typeof options.title === 'string' && options.title.trim()
    ? options.title.trim()
    : 'Chat';
}

function updateReusedChatTabMetadata(tabId, targetUrl, options = {}) {
  const state = window.appState;
  if (!state?.tabMeta?.[tabId]) {
    return;
  }

  const title = getReusableConversationTabTitle(options);
  const meta = state.tabMeta[tabId];
  meta.title = title;
  meta.autoTitle = title;
  meta.customTitle = null;
  meta.type = options.type || meta.type || 'chat';
  meta.url = normalizeOwuiShellUrl(targetUrl);
  meta.unread = false;
  meta.attentionRequired = false;
  meta.busy = false;
  meta.busyPhase = 'idle';

  window.tabBar?.updateTitle(tabId, title);
  setTabBusyState(tabId, false, 'idle');
  setTabUnreadState(tabId, false);
  setTabAttentionRequiredState(tabId, false);
}

async function loadOwuiUrlInTabWebview(webview, targetUrl, tabName, conversationId = null) {
  if (!webview || !targetUrl) {
    return false;
  }

  try {
    await ensureChatWebviewPreload(webview);
  } catch (error) {
    console.warn('[Chat] Failed to ensure preload before search-result navigation:', error?.message || error);
  }

  try {
    if (typeof webview.loadURL === 'function') {
      await webview.loadURL(targetUrl);
    } else {
      webview.src = targetUrl;
    }
  } catch (error) {
    console.error('[Chat] Failed to load search result in reused tab:', error?.message || error);
    return false;
  }

  void attachOwuiViewAndSyncActiveKey(webview, tabName, conversationId);
  return true;
}

async function reuseMainChatTabForConversation(url, options = {}) {
  const state = window.appState;
  const targetUrl = String(url || 'http://localhost:3789');
  const mainChatElement = document.getElementById('chat-webview');
  const webview = ensureOwuiHostElement(mainChatElement, {
    viewKey: getOwuiViewKeyForWebview(mainChatElement),
    windowType: getOwuiWindowTypeForWebview(mainChatElement),
    url: targetUrl,
  });
  if (!webview) {
    return false;
  }

  if (state) {
    state.chatLoaded = true;
  }
  updateReusedChatTabMetadata('chat', targetUrl, options);
  attachMainChatWebviewListeners(webview);

  const placeholder = document.getElementById('chat-placeholder');
  if (placeholder) {
    placeholder.style.display = 'none';
  }

  switchTab('chat');
  markWebviewShown(webview);
  webview.classList.remove('hidden');
  window.syncOwuiHosts?.();

  const loaded = await loadOwuiUrlInTabWebview(webview, targetUrl, 'chat');
  window.persistTabState?.();
  return loaded;
}

async function reuseConversationTabForConversation(activeTab, url, options = {}) {
  const state = window.appState;
  const slotId = activeTab?.startsWith('conversation-')
    ? activeTab.replace('conversation-', '')
    : null;
  if (!slotId || !state?.conversationTabs?.[slotId]) {
    return reuseMainChatTabForConversation(url, options);
  }

  const targetUrl = String(url || 'http://localhost:3789');
  const conversation = state.conversationTabs[slotId];
  conversation.url = normalizeOwuiShellUrl(targetUrl);
  updateReusedChatTabMetadata(slotId, targetUrl, options);

  let webview =
    conversation.webviewElement ||
    document.getElementById(`conversation-webview-${slotId}`);
  if (!webview || webview.isConnected === false) {
    webview = ensureConversationWebviewMounted(slotId, { navigationUrl: targetUrl });
  }

  if (conversation.mountPromise) {
    await conversation.mountPromise.catch(() => {});
    webview =
      conversation.webviewElement ||
      document.getElementById(`conversation-webview-${slotId}`) ||
      webview;
  }

  if (!webview) {
    return false;
  }

  switchTab(activeTab);
  markWebviewShown(webview);
  webview.classList.remove('hidden');
  syncConversationUrlState(slotId, targetUrl);

  const loaded = await loadOwuiUrlInTabWebview(webview, targetUrl, activeTab, slotId);
  window.persistTabState?.();
  return loaded;
}

async function reuseActiveChatTabForConversation(url, conversationId, options = {}) {
  const state = window.appState;
  const activeTab = state?.activeTab || 'chat';
  const targetTab = activeTab?.startsWith('conversation-') ? activeTab : 'chat';

  console.log(
    `[Chat] Reusing active tab ${targetTab} for search result ${conversationId || 'unknown'} at ${url}`,
  );

  if (targetTab === 'chat') {
    return reuseMainChatTabForConversation(url, options);
  }

  return reuseConversationTabForConversation(targetTab, url, options);
}

async function openConversationTabOrReuseActive(url, conversationId, options = {}) {
  const state = window.appState;
  if (!conversationId) {
    return false;
  }

  if (canOpenAdditionalConversationTab(conversationId, state)) {
    const opened = openConversationTab(url, conversationId, options);
    if (opened !== false) {
      return true;
    }
  }

  return reuseActiveChatTabForConversation(url, conversationId, options);
}

async function attachDetachedConversationToTab(payload = {}) {
  const {
    conversationId,
    url,
    title,
    windowType = 'subagent',
    viewKey,
  } = payload;

  if (!conversationId || !url) {
    return { success: false, error: 'Missing conversationId or url' };
  }

  const tabType = windowType === 'chat' ? 'chat' : 'subagent';
  const resolvedViewKey = viewKey || `conversation:${conversationId}`;
  const hostWindowType = resolvedViewKey.startsWith('conversation:')
    ? 'conversation'
    : tabType;

  try {
    if (tabType === 'chat' && resolvedViewKey === 'main') {
      const mainChatWebview = document.getElementById('chat-webview');
      if (!mainChatWebview) {
        return { success: false, error: 'Main chat webview is unavailable' };
      }

      disposeOwuiHostElement(mainChatWebview, { destroyView: true });
      ensureOwuiHostElement(mainChatWebview, {
        viewKey: resolvedViewKey,
        windowType: 'main',
        url: normalizeOwuiShellUrl(url),
        createImmediately: true,
      });
      if (typeof mainChatWebview.attachOwuiView === 'function') {
        await mainChatWebview.attachOwuiView();
      }
      await replaceAttachedOwuiShellUrlInPlace(mainChatWebview, url);

      switchTab('chat');
      return { success: true };
    }

    const opened = openConversationTab(url, conversationId, {
      title: title || (tabType === 'chat' ? 'Chat' : 'Subagent'),
      type: tabType,
      viewKey: resolvedViewKey,
      hostWindowType,
    });
    if (opened === false) {
      return { success: false, error: 'Maximum of 5 tabs reached. Close some tabs first.' };
    }

    const webview = document.getElementById(`conversation-webview-${conversationId}`);
    if (typeof webview?.attachOwuiView === 'function') {
      await webview.attachOwuiView();
    }
    await replaceAttachedOwuiShellUrlInPlace(webview, url);

    switchTab(`conversation-${conversationId}`);
    return { success: true };
  } catch (error) {
    console.error('[CONVERSATION] Failed to attach detached window back to tab:', error);
    return { success: false, error: error?.message || String(error) };
  }
}

// Detach conversation detail tab to a new window
async function detachConversationTab(conversationId, options = {}) {
  const state = window.appState;
  const conversation = state.conversationTabs[conversationId];
  if (!conversation) {
    console.warn(`[CONVERSATION ${conversationId}] No tab found to detach`);
    return;
  }

  if (!window.electronAPI?.detachConversation) {
    console.error('[CONVERSATION] Detach API not available');
    return;
  }

  try {
    const tabMeta = state.tabMeta?.[conversationId] || {};
    const windowType = tabMeta.type === 'chat' ? 'chat' : 'subagent';
    const ensuredWebview =
      conversation.webviewElement || ensureConversationWebviewMounted(conversationId);
    if (conversation.mountPromise) {
      await conversation.mountPromise.catch(() => {});
    }
    const liveViewKey =
      options.viewKey ||
      ensuredWebview?.dataset?.owuiViewKey ||
      `conversation:${conversationId}`;
    const liveUrl = getLiveOwuiUrl(ensuredWebview, conversation.url || 'http://localhost:3789');
    const windowTitle =
      window.getTabDisplayTitle?.(conversationId) ||
      tabMeta.customTitle ||
      tabMeta.autoTitle ||
      tabMeta.title ||
      (windowType === 'chat' ? 'Chat' : 'Subagent');

    const result = await window.electronAPI.detachConversation(
      conversationId,
      liveUrl,
      windowTitle,
      windowType,
      {
        ...options,
        viewKey: liveViewKey,
      },
    );

    if (result?.success) {
      closeConversationTab(conversationId, { preserveView: true });
    } else {
      console.error('[CONVERSATION] Failed to detach:', result?.error);
    }
  } catch (error) {
    console.error('[CONVERSATION] Detach failed:', error);
  }
}

// Detach main chat tab to a new window
async function detachMainChatTab() {
  const webview = document.getElementById('chat-webview');
  if (!webview) {
    console.error('[Chat] Chat webview not found for detach');
    return;
  }

  if (!window.electronAPI?.detachConversation) {
    console.error('[Chat] Detach API not available');
    return;
  }

  let currentUrl = '';
  try {
    currentUrl = webview.getURL();
  } catch (error) {
    console.warn('[Chat] Failed to read current chat URL:', error);
  }

  if (!currentUrl || currentUrl === 'about:blank') {
    currentUrl = webview.getAttribute('src') || 'http://localhost:3789';
  }
  currentUrl = normalizeOwuiShellUrl(currentUrl);

  const liveViewKey = getOwuiViewKeyForWebview(webview);
  const windowTitle =
    window.getTabDisplayTitle?.('chat') ||
    window.appState?.tabMeta?.chat?.title ||
    'Chat';

  const detachedId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    const result = await window.electronAPI.detachConversation(
      detachedId,
      currentUrl,
      windowTitle,
      'chat',
      {
        viewKey: liveViewKey,
      },
    );

    if (result?.success) {
      createReplacementMainChatView();
    } else {
      console.error('[Chat] Failed to detach:', result?.error);
    }
  } catch (error) {
    console.error('[Chat] Detach failed:', error);
  }
}

function setupChatDetachButton() {
  const detachBtn = document.getElementById('chat-detach-btn');
  if (!detachBtn) {
    return;
  }

  detachBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await detachMainChatTab();
  });
}

// Close conversation detail tab
function closeConversationTab(conversationId, options = {}) {
  const state = window.appState;
  const conversation = state.conversationTabs[conversationId];

  const fullTabId = `conversation-${conversationId}`;
  const wasActive = state.activeTab === fullTabId;
  window.backendModalAttention?.releaseTab?.(conversationId);

  let nextTabId = null;
  if (wasActive && window.tabBar) {
    nextTabId = window.tabBar.getPrevTab(fullTabId) || window.tabBar.getNextTab(fullTabId) || 'chat';
  }

  if (conversation?.webviewElement) {
    resetWebviewRecoveryState(conversation.webviewElement);
    disposeOwuiHostElement(conversation.webviewElement, {
      destroyView: options.preserveView !== true,
    });
  }

  window.artifactPanel?.closeTab?.(fullTabId, {
    destroyView: true,
  });

  const tabContent = document.getElementById(`conversation-${conversationId}-tab`);
  if (tabContent) tabContent.remove();

  suspendedTabs.delete(conversationId);
  delete tabLastActive[conversationId];
  delete tabBecameInactiveAt[conversationId];
  delete state.conversationTabs[conversationId];

  window.tabBar?.removeTab(conversationId);
  publishChatAttentionSnapshot();
  scheduleBackgroundTabUnloadCheck();

  if (wasActive && nextTabId) {
    switchTab(nextTabId);
  }
}

function closeOtherTabs(keepConversationId) {
  const state = window.appState;
  const toClose = Object.keys(state.conversationTabs).filter(id => id !== keepConversationId);
  for (const cid of toClose) closeConversationTab(cid);
}

function closeTabsToRight(conversationId) {
  const state = window.appState;
  const order = state.tabOrder;
  const idx = order.indexOf(conversationId);
  if (idx === -1) return;
  const toClose = order.slice(idx + 1).filter(id => !['control', 'chat'].includes(id));
  for (const cid of toClose) closeConversationTab(cid);
}

function closeActiveTab() {
  const state = window.appState;
  const active = state.activeTab;
  if (!active || active === 'control' || active === 'chat') return;
  const cid = active.replace('conversation-', '');
  closeConversationTab(cid);
}

// Export functions
window.loadChatInterface = loadChatInterface;
window.switchTab = switchTab;
window.openMcpDebugger = openMcpDebugger;
window.closeMcpDebuggerTab = closeMcpDebuggerTab;
window.openConversationTab = openConversationTab;
window.openConversationTabOrReuseActive = openConversationTabOrReuseActive;
window.canOpenAdditionalConversationTab = canOpenAdditionalConversationTab;
window.attachDetachedConversationToTab = attachDetachedConversationToTab;
window.closeConversationTab = closeConversationTab;
window.openNewChatTab = openNewChatTab;
window.closeOtherTabs = closeOtherTabs;
window.closeTabsToRight = closeTabsToRight;
window.closeActiveTab = closeActiveTab;
window.detachConversationTab = detachConversationTab;
window.setChatTabAttentionRequired = setTabAttentionRequiredState;

// Auto-load chat interface when DOM is ready
// This ensures the chat tab shows loading state immediately
document.addEventListener('DOMContentLoaded', () => {
  console.log('[Chat] DOMContentLoaded - auto-loading chat interface');
  setupForceWebviewRecoveryListener();
  setupSystemResumeListener();
  setupChatDetachButton();
  // Small delay to ensure all other scripts have initialized
  setTimeout(() => {
    if (!window.appState?.chatLoaded) {
      console.log('[Chat] Auto-triggering loadChatInterface');
      loadChatInterface();
    }
  }, 100);
});
