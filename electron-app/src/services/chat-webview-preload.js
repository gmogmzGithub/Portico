// Preload script for Open WebUI content hosted by the Electron shell.
// Exposes the legacy webviewHost API while using regular IPC instead of sendToHost.

const { contextBridge, ipcRenderer } = require('electron');

const nativeSidebarVibrancy = process.argv.includes(
  '--portico-native-sidebar-vibrancy',
);

function applyElectronHostCapability() {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement?.classList.add('portico-electron-shell');
}

function applyNativeSidebarVibrancyCapability() {
  if (!nativeSidebarVibrancy || typeof document === 'undefined') {
    return;
  }
  document.documentElement?.classList.add('portico-native-sidebar-vibrancy');
}

applyElectronHostCapability();
applyNativeSidebarVibrancyCapability();
window.addEventListener(
  'DOMContentLoaded',
  () => {
    applyElectronHostCapability();
    applyNativeSidebarVibrancyCapability();
  },
  { once: true },
);

function logKonamiOwuiPreload(level, message, meta = {}) {
  ipcRenderer.send('log-to-main', {
    level,
    message: `[Konami:OWUI preload] ${message}`,
    meta: {
      konami: true,
      konamiLayer: 'OWUI-Preload',
      ...meta,
    },
  });
}
function sendArtifactAction(action, artifactId) {
  if (!action || !artifactId) {
    return;
  }
  ipcRenderer.send('owui-artifact-action', { action, artifact_id: artifactId });
}

function writeClipboard(payload = {}) {
  return ipcRenderer.invoke('clipboard-write', payload);
}

function readClipboardText() {
  return ipcRenderer.invoke('clipboard-read-text');
}

function reportPromptCost(payload) {
  if (!payload || typeof payload !== 'object') {
    return Promise.resolve({ success: false, error: 'Invalid payload' });
  }
  return ipcRenderer.invoke('report-prompt-cost', payload);
}

function getChatCostSummary(options = {}) {
  if (!options || typeof options !== 'object') {
    return Promise.resolve({ success: false, error: 'Invalid payload' });
  }
  return ipcRenderer.invoke('get-chat-cost-summary', options);
}

function getChatTurnSummary(options = {}) {
  if (!options || typeof options !== 'object') {
    return Promise.resolve({ success: false, error: 'Invalid payload' });
  }
  return ipcRenderer.invoke('get-chat-turn-summary', options);
}

function getUiCalloutState(key) {
  if (typeof key !== 'string' || !key.trim()) {
    return Promise.resolve({ success: false, error: 'Invalid callout key' });
  }
  return ipcRenderer.invoke('owui-ui-callout-get', key);
}

function incrementUiCalloutImpressions(key) {
  if (typeof key !== 'string' || !key.trim()) {
    return Promise.resolve({ success: false, error: 'Invalid callout key' });
  }
  return ipcRenderer.invoke('owui-ui-callout-increment', key);
}

function getSidebarPreference() {
  return ipcRenderer.invoke('owui-get-sidebar-preference');
}

function saveSidebarPreference(open) {
  return ipcRenderer.invoke('owui-save-sidebar-preference', open);
}

function openConversationWindow({ conversationId, href, title, windowType } = {}) {
  if (!conversationId || !href) {
    return Promise.resolve({
      success: false,
      error: 'Missing conversationId or href',
    });
  }

  let resolvedUrl;
  try {
    resolvedUrl = new URL(href, window.location.href);
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: 'Invalid conversation URL',
    });
  }

  const currentOrigin = window.location.origin;
  if (resolvedUrl.origin !== currentOrigin) {
    return Promise.resolve({
      success: false,
      error: 'Cross-origin conversation URLs are not allowed',
    });
  }

  return ipcRenderer.invoke('conversation-detach', {
    conversationId,
    url: resolvedUrl.toString(),
    title,
    windowType,
  });
}

function openDebugRequestModal(detail = {}) {
  if (!detail || typeof detail !== 'object') {
    return Promise.resolve({ success: false, error: 'Invalid debug request payload' });
  }
  return ipcRenderer.invoke('owui-open-debug-request-modal', detail);
}

function openDebugMonitorLink(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid debug monitor URL' });
  }
  return ipcRenderer.invoke('owui-open-debug-monitor-link', { url });
}

function openChatWorkspace(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  return ipcRenderer.invoke('open-chat-workspace', { chatId });
}

function getChatWorkspaceSelection(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  return ipcRenderer.invoke('get-chat-workspace-selection', { chatId });
}

function chooseChatWorkspaceFolder(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  return ipcRenderer.invoke('choose-chat-workspace-folder', { chatId });
}

function selectChatWorkspaceFolder(chatId, hostPath = null) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  const payload = { chatId };
  if (typeof hostPath === 'string' && hostPath.trim() !== '') {
    payload.hostPath = hostPath.trim();
  }
  return ipcRenderer.invoke('select-chat-workspace-folder', payload);
}

function clearChatWorkspaceFolder(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  return ipcRenderer.invoke('clear-chat-workspace-folder', { chatId });
}

function moveChatWorkspaceSelection(fromChatId, toChatId) {
  const normalizedFromChatId = typeof fromChatId === 'string' ? fromChatId.trim() : '';
  const normalizedToChatId = typeof toChatId === 'string' ? toChatId.trim() : '';
  if (
    !normalizedFromChatId ||
    !normalizedToChatId ||
    normalizedFromChatId === normalizedToChatId
  ) {
    return Promise.resolve({
      success: true,
      moved: false,
      fromChatId: normalizedFromChatId,
      toChatId: normalizedToChatId,
    });
  }
  return ipcRenderer.invoke('move-chat-workspace-selection', {
    fromChatId: normalizedFromChatId,
    toChatId: normalizedToChatId,
  });
}

function reconcileChatWorkspaceVms(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    return Promise.resolve({ success: false, error: 'Invalid chat ID' });
  }
  return ipcRenderer.invoke('reconcile-chat-workspace-vms', { chatId });
}

async function getDebugMode() {
  const result = await ipcRenderer.invoke('owui-get-debug-mode');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to get OWUI debug mode');
  }
  return Boolean(result.enabled);
}

async function getDebugMonitorAccess() {
  const result = await ipcRenderer.invoke('owui-get-debug-monitor-access');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to get debug monitor access');
  }
  return {
    baseUrl: typeof result.baseUrl === 'string' ? result.baseUrl : undefined,
    token: typeof result.token === 'string' ? result.token : undefined,
  };
}

async function navigateToConversation(chatId, messageId, options = {}) {
  try {
    const result = await ipcRenderer.invoke(
      'navigate-to-conversation-window',
      chatId,
      messageId,
      options,
    );
    return result?.found === true;
  } catch {
    return false;
  }
}

function reportTabActivity(payload = {}) {
  ipcRenderer.send('owui-tab-activity', {
    busy: payload?.busy === true,
    phase: typeof payload?.phase === 'string' ? payload.phase : 'idle',
    chatId: typeof payload?.chatId === 'string' ? payload.chatId : '',
    title: typeof payload?.title === 'string' ? payload.title : '',
    modelIdentity: normalizeChatNotificationModelIdentity(payload?.modelIdentity),
    // Multi-chat tiling: artifact routing treats this tab as windowed-only.
    multiChat: payload?.multiChat === true,
  });
}

function normalizeChatNotificationModelIdentity(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  for (const key of [
    'id',
    'name',
    'ownedBy',
    'baseModelId',
    'baseModelName',
    'baseModelOwnedBy',
  ]) {
    if (typeof source[key] === 'string' && source[key].trim()) {
      normalized[key] = source[key].trim().slice(0, 256);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function notifyChatStatus(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return Promise.resolve({ success: false, error: 'Invalid chat notification payload' });
  }
  return ipcRenderer.invoke('show-chat-native-notification', {
    type: typeof payload.type === 'string' ? payload.type : '',
    chatId: typeof payload.chatId === 'string' ? payload.chatId : '',
    chatTitle: typeof payload.chatTitle === 'string' ? payload.chatTitle : '',
    notificationKey:
      typeof payload.notificationKey === 'string' ? payload.notificationKey : '',
    itemCount: Number.isSafeInteger(payload.itemCount) ? payload.itemCount : undefined,
    modelIdentity: normalizeChatNotificationModelIdentity(payload.modelIdentity),
  });
}

async function getChatActivitySnapshot() {
  const result = await ipcRenderer.invoke('owui-get-chat-activity-snapshot');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to get chat activity snapshot');
  }
  return result.data || { version: 1, chats: [] };
}

async function reconcileChatRuntime(payload = {}) {
  const result = await ipcRenderer.invoke('owui-reconcile-chat-runtime', {
    chatId: typeof payload?.chatId === 'string' ? payload.chatId : '',
    busy: payload?.busy === true,
    phase: typeof payload?.phase === 'string' ? payload.phase : 'idle',
    title: typeof payload?.title === 'string' ? payload.title : '',
    modelIdentity: normalizeChatNotificationModelIdentity(payload?.modelIdentity),
  });
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to reconcile chat runtime');
  }
  return result.data || { version: 2, chats: [] };
}

async function acknowledgeChatRuntime(chatId = '') {
  const result = await ipcRenderer.invoke(
    'owui-acknowledge-chat-runtime',
    typeof chatId === 'string' ? chatId : '',
  );
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to acknowledge chat runtime');
  }
  return result.data || { version: 2, chats: [] };
}

async function getNativeInputPresentationSnapshot() {
  const result = await ipcRenderer.invoke('owui-get-native-input-presentation-snapshot');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to get native-input presentation snapshot');
  }
  return result.data || { version: 1, flows: [] };
}

async function reopenNativeInput(kind = '', flowId = '', chatId = '') {
  const result = await ipcRenderer.invoke('owui-reopen-native-input', {
    kind: typeof kind === 'string' ? kind : '',
    flow_id: typeof flowId === 'string' ? flowId : '',
    chat_id: typeof chatId === 'string' ? chatId : '',
  });
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to reopen native-input modal');
  }
  return result.data || { version: 1, flows: [] };
}

// PORTICO-348: answer an Ask User Question flow from the chat transcript. The host
// re-validates flow ownership against this view's owner window and chat id.
async function submitUserQuestion(payload = {}) {
  const result = await ipcRenderer.invoke('owui-submit-user-question', {
    flow_id: typeof payload.flowId === 'string' ? payload.flowId : '',
    chat_id: typeof payload.chatId === 'string' ? payload.chatId : '',
    action: payload.action === 'dismissed' ? 'dismissed' : 'submitted',
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  });
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to submit question answers');
  }
  return true;
}

let latestChatAttentionSnapshot = { version: 1, chats: [] };

function getChatAttentionSnapshot() {
  return latestChatAttentionSnapshot;
}
const api = {
  sendArtifactAction,
  writeClipboard,
  readClipboardText,
  reportPromptCost,
  getChatCostSummary,
  getChatTurnSummary,
  getUiCalloutState,
  incrementUiCalloutImpressions,
  getSidebarPreference,
  saveSidebarPreference,
  openConversationWindow,
  openDebugRequestModal,
  openDebugMonitorLink,
  openChatWorkspace,
  getChatWorkspaceSelection,
  chooseChatWorkspaceFolder,
  selectChatWorkspaceFolder,
  clearChatWorkspaceFolder,
  moveChatWorkspaceSelection,
  reconcileChatWorkspaceVms,
  getDebugMode,
  getDebugMonitorAccess,
  navigateToConversation,
  reportTabActivity,
  notifyChatStatus,
  getChatActivitySnapshot,
  reconcileChatRuntime,
  acknowledgeChatRuntime,
  getChatAttentionSnapshot,
  getNativeInputPresentationSnapshot,
  reopenNativeInput,
  submitUserQuestion,
};

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

let themeStorageWarningLogged = false;

function persistThemePreference(themeName) {
  try {
    window.localStorage?.setItem('theme', themeName);
  } catch (error) {
    if (!themeStorageWarningLogged) {
      themeStorageWarningLogged = true;
      console.debug(
        '[OWUI preload] Theme preference storage unavailable in isolated context:',
        error?.message || error,
      );
    }
  }
}

function ensureThemeStyleElement() {
  const styleId = 'owui-context-utilization-theme';
  let styleEl = document.getElementById(styleId);
  if (styleEl) {
    return styleEl;
  }

  const parent = document.head || document.documentElement;
  if (!parent) {
    return null;
  }

  styleEl = document.createElement('style');
  styleEl.id = styleId;
  parent.appendChild(styleEl);
  return styleEl;
}

function applyTheme(themeName) {
  if (!themeName || typeof document === 'undefined') {
    return;
  }

  const openWebuiTheme = themeName;
  const metaThemeColor = openWebuiTheme === 'dark' ? '#171717' : '#ffffff';
  const root = document.documentElement;
  if (!root) {
    return;
  }

  persistThemePreference(openWebuiTheme);
  root.classList.remove('dark', 'light', 'her');
  root.classList.add(openWebuiTheme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', metaThemeColor);
  }

  if (openWebuiTheme === 'dark') {
    root.style.setProperty('--color-gray-800', '#333');
    root.style.setProperty('--color-gray-850', '#262626');
    root.style.setProperty('--color-gray-900', '#171717');
    root.style.setProperty('--color-gray-950', '#0d0d0d');
  }

  const styleEl = ensureThemeStyleElement();
  if (!styleEl) {
    return;
  }
  styleEl.textContent = contextUtilizationCss;
}

const clipboardBridgeSource = `
(() => {
  if (window.__owuiClipboardBridgeInstalled) {
    return;
  }
  window.__owuiClipboardBridgeInstalled = true;

  const hostApi = window.webviewHost;
  if (!hostApi || typeof hostApi.writeClipboard !== 'function') {
    return;
  }

  const originalClipboard = navigator.clipboard || null;
  const originalWrite = originalClipboard && typeof originalClipboard.write === 'function'
    ? originalClipboard.write.bind(originalClipboard)
    : null;
  const originalWriteText = originalClipboard && typeof originalClipboard.writeText === 'function'
    ? originalClipboard.writeText.bind(originalClipboard)
    : null;
  const originalRead = originalClipboard && typeof originalClipboard.read === 'function'
    ? originalClipboard.read.bind(originalClipboard)
    : null;
  const originalReadText = originalClipboard && typeof originalClipboard.readText === 'function'
    ? originalClipboard.readText.bind(originalClipboard)
    : null;

  const bridgedClipboard = originalClipboard || {};

  bridgedClipboard.writeText = async (text) => {
    const normalizedText =
      typeof text === 'string' ? text : text == null ? '' : String(text);

    try {
      const result = await hostApi.writeClipboard({ text: normalizedText });
      if (result === false && originalWriteText) {
        return await originalWriteText(normalizedText);
      }
      return;
    } catch (error) {
      if (originalWriteText) {
        return await originalWriteText(normalizedText);
      }
      throw error;
    }
  };

  bridgedClipboard.write = async (items) => {
    const itemList = Array.from(items || []);
    if (!itemList.length) {
      if (originalWrite) {
        return await originalWrite(itemList);
      }
      throw new DOMException('No clipboard items provided', 'DataError');
    }

    let html = '';
    let text = '';

    for (const item of itemList) {
      const itemTypes = Array.from(item?.types || []);
      if (!html && itemTypes.includes('text/html') && typeof item?.getType === 'function') {
        const htmlBlob = await item.getType('text/html');
        html = await htmlBlob.text();
      }
      if (!text && itemTypes.includes('text/plain') && typeof item?.getType === 'function') {
        const textBlob = await item.getType('text/plain');
        text = await textBlob.text();
      }
      if (html && text) {
        break;
      }
    }

    if (!html && !text) {
      if (originalWrite) {
        return await originalWrite(itemList);
      }
      throw new DOMException(
        'Only text/html and text/plain clipboard items are supported by this host',
        'NotSupportedError'
      );
    }

    try {
      const result = await hostApi.writeClipboard({ text, html });
      if (result === false && originalWrite) {
        return await originalWrite(itemList);
      }
      return;
    } catch (error) {
      if (originalWrite) {
        return await originalWrite(itemList);
      }
      throw error;
    }
  };

  bridgedClipboard.readText = async () => {
    try {
      if (typeof hostApi.readClipboardText === 'function') {
        const text = await hostApi.readClipboardText();
        return typeof text === 'string' ? text : '';
      }
    } catch (error) {
      if (originalReadText) {
        return await originalReadText();
      }
      throw error;
    }

    if (originalReadText) {
      return await originalReadText();
    }

    return '';
  };

  if (originalRead) {
    bridgedClipboard.read = (...args) => originalRead(...args);
  }

  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      enumerable: true,
      value: bridgedClipboard,
    });
  } catch (error) {
    try {
      if (navigator.clipboard) {
        navigator.clipboard.write = bridgedClipboard.write;
        navigator.clipboard.writeText = bridgedClipboard.writeText;
        navigator.clipboard.readText = bridgedClipboard.readText;
      }
    } catch (patchError) {
      console.warn('[OWUI preload] Failed to patch clipboard bridge:', patchError);
    }
  }
})();
`;

function injectMainWorldScript(source) {
  const inject = () => {
    if (typeof document === 'undefined') {
      return false;
    }

    const parent = document.head || document.documentElement;
    if (!parent) {
      return false;
    }

    const script = document.createElement('script');
    script.textContent = source;
    parent.appendChild(script);
    script.remove();
    return true;
  };

  if (inject()) {
    return;
  }

  window.addEventListener(
    'DOMContentLoaded',
    () => {
      inject();
    },
    { once: true },
  );
}

ipcRenderer.on('owui-artifacts-update', (_event, detail) => {
  try {
    if (typeof window.__updateArtifacts === 'function') {
      window.__updateArtifacts(detail);
    }
    window.dispatchEvent(new CustomEvent('artifacts-updated', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch artifacts update:', error);
  }
});

ipcRenderer.on('owui-chat-workspace-selection-updated', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('chat-workspace-selection-updated', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch workspace selection update:', error);
  }
});

ipcRenderer.on('owui-set-theme', (_event, themeName) => {
  try {
    applyTheme(themeName);
  } catch (error) {
    console.warn('[OWUI preload] Failed to apply theme:', error);
  }
});

ipcRenderer.on('cost-report-updated', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-cost-report-updated', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch cost-report update:', error);
  }
});

ipcRenderer.on('owui-debug-mode-changed', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-debug-mode-changed', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch debug-mode update:', error);
  }
});

ipcRenderer.on('owui-konami-unlock-changed', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-konami-unlock-changed', { detail }));
    logKonamiOwuiPreload('info', 'Dispatched OWUI Konami unlock event into the page', {
      phase: 'owui-event-dispatch',
      detail,
    });
  } catch (error) {
    logKonamiOwuiPreload('error', 'Failed to dispatch OWUI Konami unlock event into the page', {
      phase: 'owui-event-dispatch',
      detail,
      error: error?.message || String(error),
    });
    console.warn('[OWUI preload] Failed to dispatch Konami unlock update:', error);
  }
});

ipcRenderer.on('owui-models-refresh-requested', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-models-refresh-requested', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch model refresh request:', error);
  }
});

ipcRenderer.on('owui-chat-activity-snapshot', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-chat-activity-snapshot', { detail }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch chat activity snapshot:', error);
  }
});

ipcRenderer.on('owui-chat-attention-snapshot', (_event, detail) => {
  try {
    latestChatAttentionSnapshot = detail && typeof detail === 'object'
      ? detail
      : { version: 1, chats: [] };
    window.dispatchEvent(new CustomEvent('owui-chat-attention-snapshot', {
      detail: latestChatAttentionSnapshot,
    }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch chat attention snapshot:', error);
  }
});

ipcRenderer.on('owui-native-input-presentation-snapshot', (_event, detail) => {
  try {
    window.dispatchEvent(new CustomEvent('owui-native-input-presentation-snapshot', {
      detail: detail && typeof detail === 'object' ? detail : { version: 1, flows: [] },
    }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch native-input presentation snapshot:', error);
  }
});

ipcRenderer.on('trigger-search', () => {
  try {
    window.dispatchEvent(new CustomEvent('trigger-search'));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch trigger-search:', error);
  }
});

ipcRenderer.on('open-new-chat', () => {
  try {
    window.dispatchEvent(new CustomEvent('open-new-chat'));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch open-new-chat:', error);
  }
});

// PORTICO PATCH: Bridge MutationObserver-driven local-find updates from the
// in-page Custom Highlight API controller back to the main process, so the
// shell-side find-bar can refresh its "N of M" counter while the assistant is
// still streaming new matches into the transcript. (See E-11 streaming gate.)
window.addEventListener('portico-portico-local-find-update', (event) => {
  try {
    const detail = event && event.detail ? event.detail : {};
    ipcRenderer.send('owui-portico-local-find-update', {
      totalMatches: Math.max(0, Number(detail.totalMatches) || 0),
      activeOrdinal: Math.max(0, Number(detail.activeOrdinal) || 0),
      finalUpdate: detail.finalUpdate !== false,
      error: typeof detail.error === 'string' ? detail.error : null,
    });
  } catch (error) {
    console.warn('[OWUI preload] Failed to forward local-find update:', error);
  }
});

ipcRenderer.on('ui-scale-adjust', (_event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('ui-scale-adjust', { detail: payload }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch ui-scale-adjust:', error);
  }
});

ipcRenderer.on('navigate-to-message', (_event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('navigate-to-message', { detail: payload }));
  } catch (error) {
    console.warn('[OWUI preload] Failed to dispatch navigate-to-message:', error);
  }
});
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('webviewHost', api);
} else {
  window.webviewHost = api;
}

injectMainWorldScript(clipboardBridgeSource);

// ── Cmd+/Cmd- UI Scale keyboard shortcut handler ──
// Injected into the main world so it can read the CSS variable, call the OWUI
// settings API, and update localStorage — all of which live in the page origin.
const uiScaleShortcutSource = `
(function() {
  if (window.__porticoUiScaleShortcutInit) return;
  window.__porticoUiScaleShortcutInit = true;

  var COMPACT_BASE = 0.9;
  var STEP = 0.05;
  var MIN = 1;
  var MAX = 1.5;

  function getCurrentUserScale() {
    var raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--app-text-scale').trim();
    var effective = parseFloat(raw);
    if (!Number.isFinite(effective) || effective <= 0) return 1;
    return parseFloat((effective / COMPACT_BASE).toFixed(2));
  }

  function applyScale(userScale) {
    var effective = parseFloat((userScale * COMPACT_BASE).toFixed(3));
    document.documentElement.style.setProperty('--app-text-scale', String(effective));
  }

  function persistScale(userScale) {
    var token = localStorage.getItem('token');
    if (!token) return;

    var settingsRaw = localStorage.getItem('settings');
    var settings = {};
    try { settings = JSON.parse(settingsRaw) || {}; } catch (_) {}

    var textScale = userScale === 1 ? null : userScale;
    settings.textScale = textScale;
    localStorage.setItem('settings', JSON.stringify(settings));

    var origin = window.location.origin;
    fetch(origin + '/api/v1/users/user/settings/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ ui: settings })
    }).catch(function() {});
  }

  window.addEventListener('ui-scale-adjust', function(e) {
    var dir = e.detail && e.detail.direction;
    var current = getCurrentUserScale();
    var next;
    if (dir === 'in') {
      next = Math.min(MAX, parseFloat((current + STEP).toFixed(2)));
    } else if (dir === 'out') {
      next = Math.max(MIN, parseFloat((current - STEP).toFixed(2)));
    } else {
      next = 1;
    }
    applyScale(next);
    persistScale(next);
  });
})();
`;
injectMainWorldScript(uiScaleShortcutSource);
