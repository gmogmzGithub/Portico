const {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  session,
  shell,
  systemPreferences,
} = require("electron");
const path = require("path");

const state = require("./shared-state");
const {
  buildChatExportSaveDialogOptions,
  classifyOwuiChatExportDownload,
  normalizeChatExportSavePath,
} = require("./owui-downloads");
const { openHttpExternalUrl } = require("./shell-open");
const { createChatRuntimeRegistry } = require("./chat-runtime-registry");
const {
  clearOwuiHumanSessionSeed,
  ensureOwuiHumanSessionForUrl,
  markOwuiHumanSessionSeedVerified,
} = require("./owui-auth-session");
const owuiLocalFindController = require("./owui-local-find-controller");
const {
  NATIVE_SIDEBAR_VIBRANCY_ARGUMENT,
  isMacSidebarVibrancyEnabled,
} = require("./native-window-visuals");
const chatRuntimeRegistry = createChatRuntimeRegistry();
let chatRuntimeTransitionListener = null;

// PORTICO PATCH: Custom Highlight API local-find escape hatch.
// `PORTICO_DISABLE_portico_LOCAL_FIND=1` reverts to native Chromium findInPage,
// which is wider in scope (sidebar/nav leak — see E-10) but useful as a
// runtime fallback if the in-page controller misbehaves in the field.
const NATIVE_FIND_FORCED =
  process.env.PORTICO_DISABLE_portico_LOCAL_FIND === "1" ||
  process.env.PORTICO_DISABLE_portico_LOCAL_FIND === "true";

const OPEN_WEBUI_HOME_URL = "http://localhost:3789";
const OPEN_WEBUI_PARTITION = "persist:openwebui";
const OWUI_FRONTEND_AUTH_VERIFY_TIMEOUT_MS = 15_000;
const OWUI_FRONTEND_AUTH_VERIFY_INTERVAL_MS = 500;
const OWUI_EVENT_CHANNEL = "owui-event";
const CONVERSATION_URL_RE = /^http:\/\/localhost:3789\/c\/([a-f0-9-]+)$/i;
const ALLOWED_NAVIGATION_PREFIXES = [
  "http://localhost:3789",
  "http://localhost:9876/workspace/",
  "http://127.0.0.1:9876/workspace/",
];
const OWUI_SHELL_ONLY_SEARCH_PARAMS = new Set([
  "portico-target-message",
  "detached-window",
]);
const CHAT_CURSOR_FIX_CSS = `
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

  #chat-textarea,
  textarea[placeholder*="How can I help"],
  textarea[placeholder*="Message"],
  .flex-1 textarea {
    text-align: left !important;
    direction: ltr !important;
    padding-left: 1rem !important;
  }

  textarea::placeholder,
  input::placeholder {
    text-align: left !important;
  }

  .flex.items-center textarea,
  .flex.justify-center textarea {
    text-align: left !important;
  }

  .relative.flex.flex-col.flex-1 textarea {
    text-align: left !important;
    padding-left: 1rem !important;
  }

  div[role="button"]:has(> .collapsible-header-row.font-medium) {
    padding-top: 0.375rem !important;
    padding-bottom: 0.375rem !important;
  }

  /* sonner toaster container (z-index:999999999) blocks clicks on the modal
     X-close button at larger UI scales — let events pass through the
     container and only intercept on actual toast elements. */
  [data-sonner-toaster] {
    pointer-events: none !important;
  }
  [data-sonner-toast] {
    pointer-events: auto !important;
  }
`;
// On macOS, hidden WebContentsViews must remain "visible" to the native NSView
// hierarchy.  When every child NSView is setHidden(YES), macOS expands the
// native titlebar hit-test zone, making header buttons unclickable.  Keeping at
// least one child NSView visible (but off-screen) prevents this.
const IS_MAC = process.platform === "darwin";
const HIDDEN_VIEW_BOUNDS = Object.freeze(
  IS_MAC
    ? { x: -1, y: -1, width: 1, height: 1 }
    : { x: 0, y: 0, width: 0, height: 0 },
);

let preloadPath = null;
const viewEntries = new Map();
const contentsIdToViewKey = new Map();
const windowTracking = new Map();

function extractChatIdFromOwuiUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }
  try {
    const url = new URL(String(rawUrl), OPEN_WEBUI_HOME_URL);
    const match = url.pathname.match(/^\/c\/([^/]+)/);
    return match ? decodeURIComponent(match[1]).trim() : "";
  } catch {
    const match = String(rawUrl).match(/\/c\/([^/?#]+)/);
    return match ? match[1].trim() : "";
  }
}

function getChatRuntimeObservationKey(entry) {
  const contentsId = entry?.view?.webContents?.id;
  return entry?.viewKey && Number.isFinite(Number(contentsId))
    ? `${entry.viewKey}:${Number(contentsId)}`
    : "";
}

function syncChatRuntimeViewObservation(entry, rawUrl = entry?.currentUrl) {
  const observationKey = getChatRuntimeObservationKey(entry);
  if (!observationKey) {
    return false;
  }
  const chatId = extractChatIdFromOwuiUrl(rawUrl);
  entry.currentChatId = chatId;
  return chatRuntimeRegistry.setViewState(observationKey, {
    chatId,
    visible: entry.visible !== false,
  });
}

function getPreloadPath() {
  if (!preloadPath) {
    const bootstrap = require("./bootstrap");
    preloadPath = path.join(bootstrap.APP_SERVICES, "chat-webview-preload.js");
  }
  return preloadPath;
}

function getOwuiWindowById(windowId) {
  if (!Number.isFinite(Number(windowId))) {
    return null;
  }
  const windowRef = BrowserWindow.fromId(Number(windowId));
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }
  return windowRef;
}

function getOwuiSession() {
  const owuiSession = session.fromPartition(OPEN_WEBUI_PARTITION);
  if (owuiSession.__porticoOwuiConfigured) {
    return owuiSession;
  }

  owuiSession.__porticoOwuiConfigured = true;
  const isClipboardPermission = (permission) =>
    permission === "clipboard-read" ||
    permission === "clipboard-write" ||
    permission === "clipboard-sanitized-write";

  owuiSession.setPermissionCheckHandler((_contents, permission) => {
    return isClipboardPermission(permission);
  });

  owuiSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (isClipboardPermission(permission)) {
      callback(true);
      return;
    }
    callback(false);
  });

  owuiSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    if (details.url.includes("localhost:3789")) {
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["Content-Security-Policy"];
      responseHeaders["Permissions-Policy"] = [
        "clipboard-read=*, clipboard-write=*",
      ];
    }
    callback({ responseHeaders });
  });

  owuiSession.on("will-download", (event, item, webContents) => {
    const download = classifyOwuiChatExportDownload({
      url: typeof item?.getURL === "function" ? item.getURL() : "",
      filename: typeof item?.getFilename === "function" ? item.getFilename() : "",
    });

    if (!download) {
      return;
    }

    try {
      const suggestedFilename = download.filename;
      const defaultPath = path.join(app.getPath("downloads"), suggestedFilename);
      const parentWindow =
        webContents && !webContents.isDestroyed()
          ? BrowserWindow.fromWebContents(webContents)
          : null;

      // DownloadItem save-path APIs must run during will-download, so use the
      // synchronous dialog to finalize the path before Electron starts writing.
      const selectedPath = parentWindow
        ? dialog.showSaveDialogSync(
            parentWindow,
            buildChatExportSaveDialogOptions({
              defaultPath,
              download,
            }),
          )
        : dialog.showSaveDialogSync(
            buildChatExportSaveDialogOptions({
              defaultPath,
              download,
            }),
          );

      if (!selectedPath) {
        item.cancel();
        return;
      }

      item.setSavePath(
        normalizeChatExportSavePath(selectedPath, download.extension),
      );
    } catch (error) {
      console.warn("[OWUI] Failed to prepare chat export download:", error.message);
      item.cancel();
    }
  });

  return owuiSession;
}

function normalizeBounds(bounds = {}) {
  return {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(0, Math.round(Number(bounds.width) || 0)),
    height: Math.max(0, Math.round(Number(bounds.height) || 0)),
  };
}

function boundsEqual(a, b) {
  return (
    a &&
    b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function normalizeInsets(insets = {}) {
  return {
    left: Math.max(0, Math.round(Number(insets.left) || 0)),
    top: Math.max(0, Math.round(Number(insets.top) || 0)),
    right: Math.max(0, Math.round(Number(insets.right) || 0)),
    bottom: Math.max(0, Math.round(Number(insets.bottom) || 0)),
  };
}

function getWindowContentSize(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  const [width, height] = windowRef.getContentSize();
  return {
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(height) || 0)),
  };
}

function getOwuiHostWindow(entry) {
  return getOwuiWindowById(entry?.attachedWindowId || entry?.ownerWindowId);
}

function getInsetsForBounds(bounds, contentSize) {
  if (!bounds || !contentSize) {
    return null;
  }

  return normalizeInsets({
    left: bounds.x,
    top: bounds.y,
    right: contentSize.width - (bounds.x + bounds.width),
    bottom: contentSize.height - (bounds.y + bounds.height),
  });
}

function getBoundsForInsets(contentSize, insets) {
  if (!contentSize || !insets) {
    return null;
  }

  return normalizeBounds({
    x: insets.left,
    y: insets.top,
    width: contentSize.width - insets.left - insets.right,
    height: contentSize.height - insets.top - insets.bottom,
  });
}

function updateEntryInsets(entry, windowRef = getOwuiHostWindow(entry)) {
  const contentSize = getWindowContentSize(windowRef);
  if (!entry || !entry.bounds || !contentSize) {
    return;
  }

  entry.contentInsets = getInsetsForBounds(entry.bounds, contentSize);
}

function applyEntryBounds(entry, bounds, options = {}) {
  if (!entry || !entry.view || entry.view.webContents.isDestroyed()) {
    return;
  }

  const nextBounds = normalizeBounds(bounds);
  const boundsChanged = !boundsEqual(entry.bounds, nextBounds);
  if (boundsChanged) {
    entry.bounds = nextBounds;
  }

  if (boundsChanged || options.forceViewUpdate) {
    entry.view.setBounds(nextBounds);
  }

  if (options.updateInsets !== false) {
    updateEntryInsets(entry, options.windowRef);
  }
}

function syncNativeViewVisibility(entry, visible, options = {}) {
  if (!entry || !entry.view || entry.view.webContents.isDestroyed()) {
    return;
  }

  if (visible) {
    if (entry.bounds) {
      applyEntryBounds(entry, entry.bounds, {
        forceViewUpdate: true,
        updateInsets: options.updateInsets,
        windowRef: options.windowRef,
      });
    }
    entry.view.setVisible(true);
    return;
  }

  if (IS_MAC) {
    // On macOS with titleBarStyle:'hiddenInset', fully hiding all WebContentsViews
    // causes macOS to reclaim the native titlebar hit-test zone, making header
    // buttons unclickable. Keep the view "visible" to macOS but shrunk to a single
    // 1x1 pixel in the bottom-left corner. A full-width 1px bar rendered the dark
    // top edge of the OWUI page as a visible black line across the window bottom,
    // so we keep only the minimum non-zero frame needed for the hit-test workaround.
    const windowRef = getOwuiHostWindow(entry);
    const contentSize = windowRef && !windowRef.isDestroyed() ? getWindowContentSize(windowRef) : null;
    const safeY = contentSize ? contentSize.height - 1 : 9999;
    entry.view.setBounds({ x: 0, y: safeY, width: 1, height: 1 });
  } else {
    entry.view.setBounds(HIDDEN_VIEW_BOUNDS);
    entry.view.setVisible(false);
  }
}

function safeGetUrl(contents) {
  if (!contents || contents.isDestroyed()) {
    return "";
  }
  try {
    return contents.getURL() || "";
  } catch (error) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOwuiAuthCompleteUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "", OPEN_WEBUI_HOME_URL);
    return (
      url.origin === OPEN_WEBUI_HOME_URL &&
      url.pathname === "/api/v1/portico/auth/complete"
    );
  } catch (_error) {
    return false;
  }
}

function isOwuiAuthPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "", OPEN_WEBUI_HOME_URL);
    return url.origin === OPEN_WEBUI_HOME_URL && url.pathname === "/auth";
  } catch (_error) {
    return false;
  }
}

function isOwuiUiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "", OPEN_WEBUI_HOME_URL);
    return url.origin === OPEN_WEBUI_HOME_URL && !url.pathname.startsWith("/api/");
  } catch (_error) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function owuiAuthFailureHtml(message) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        height: 100%;
        margin: 0;
        background: #050505;
        color: #f4f4f5;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Open WebUI authentication failed</h1>
      <p>${escapeHtml(message || "Open WebUI authentication failed")}</p>
    </main>
  </body>
</html>`;
}

async function showOwuiAuthFailure(entry, message) {
  clearOwuiHumanSessionSeed(getOwuiSession());
  try {
    await entry.view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(owuiAuthFailureHtml(message))}`,
    );
  } catch (_error) {
    // did-fail-load is the normal signal path if even the fallback page fails.
  }
}

async function verifyOwuiFrontendAuth(entry, targetUrl) {
  const startedAt = Date.now();
  let lastReason = "OWUI frontend auth did not verify";
  while (Date.now() - startedAt <= OWUI_FRONTEND_AUTH_VERIFY_TIMEOUT_MS) {
    const currentUrl = safeGetUrl(entry.view.webContents);
    if (isOwuiAuthPageUrl(currentUrl)) {
      throw new Error("OWUI frontend landed on the login page after auth bootstrap");
    }
    if (!isOwuiAuthCompleteUrl(currentUrl)) {
      try {
        const result = await entry.view.webContents.executeJavaScript(
          `(() => {
            const token = window.localStorage && window.localStorage.getItem("token");
            if (!token) {
              return { ok: false, reason: "localStorage_token_missing", path: window.location.pathname };
            }
            return fetch("/api/v1/auths/", {
              method: "GET",
              headers: { Authorization: "Bearer " + token, Accept: "application/json" }
            }).then(async (response) => {
              let payload = null;
              try {
                payload = await response.json();
              } catch (error) {
                payload = null;
              }
              const role = typeof payload?.role === "string" ? payload.role : null;
              const allowedRoles = new Set(["admin", "user"]);
              return {
                ok: response.ok && allowedRoles.has(role),
                status: response.status,
                role,
                reason: response.ok
                  ? (allowedRoles.has(role) ? null : \`unsupported_role:\${role || "missing"}\`)
                  : \`auth_status:\${response.status}\`,
                path: window.location.pathname
              };
            }).catch((error) => ({
              ok: false,
              reason: error && error.message ? error.message : "fetch_failed",
              path: window.location.pathname
            }));
          })()`,
          true,
        );
        if (result?.ok) {
          markOwuiHumanSessionSeedVerified({
            owuiSession: getOwuiSession(),
            targetUrl,
          });
          return true;
        }
        lastReason = result?.reason || `auth status ${result?.status || "unknown"}`;
      } catch (error) {
        lastReason = error.message;
      }
    }
    await sleep(OWUI_FRONTEND_AUTH_VERIFY_INTERVAL_MS);
  }
  throw new Error(lastReason);
}

async function verifyOwuiFrontendAuthWithOneReseed(entry, targetUrl, context) {
  try {
    await verifyOwuiFrontendAuth(entry, targetUrl);
    return true;
  } catch (error) {
    console.warn(
      `[OWUI] Failed to verify ${context || "authenticated"} OWUI frontend auth:`,
      error.message,
    );
  }

  clearOwuiHumanSessionSeed(getOwuiSession());
  try {
    const retryLoadUrl = await ensureOwuiHumanSessionForUrl({
      owuiSession: getOwuiSession(),
      targetUrl,
    });
    await entry.view.webContents.loadURL(retryLoadUrl);
    await verifyOwuiFrontendAuth(entry, targetUrl);
    return true;
  } catch (retryError) {
    console.warn(
      "[OWUI] Failed to verify authenticated OWUI frontend after reseed:",
      retryError.message,
    );
    await showOwuiAuthFailure(entry, retryError.message);
    return false;
  }
}

function normalizeComparableOwuiUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    const normalized = new URL(rawUrl, OPEN_WEBUI_HOME_URL);
    for (const param of OWUI_SHELL_ONLY_SEARCH_PARAMS) {
      normalized.searchParams.delete(param);
    }
    normalized.hash = "";
    const search = normalized.searchParams.toString();
    return `${normalized.origin}${normalized.pathname}${search ? `?${search}` : ""}`;
  } catch (_error) {
    return String(rawUrl || "").trim();
  }
}

function areOwuiUrlsEquivalent(a, b) {
  if (!a || !b) {
    return false;
  }

  return normalizeComparableOwuiUrl(a) === normalizeComparableOwuiUrl(b);
}

function serializeEntry(entry) {
  const currentUrl = safeGetUrl(entry.view.webContents);
  if (currentUrl) {
    entry.currentUrl = currentUrl;
  }

  return {
    viewKey: entry.viewKey,
    windowType: entry.windowType,
    conversationId: entry.conversationId || null,
    ownerWindowId: entry.ownerWindowId,
    attachedWindowId: entry.attachedWindowId,
    webContentsId: entry.view.webContents.id,
    currentUrl: entry.currentUrl || "",
    requestedUrl: entry.requestedUrl || "",
    currentChatId: entry.currentChatId || "",
    visible: entry.visible !== false,
    bounds: entry.bounds || null,
  };
}

function emitToOwner(entry, type, payload = {}) {
  const ownerWindow = getOwuiWindowById(entry.ownerWindowId);
  if (!ownerWindow) {
    return;
  }

  try {
    ownerWindow.webContents.send(OWUI_EVENT_CHANNEL, {
      viewKey: entry.viewKey,
      type,
      ...payload,
    });
  } catch (error) {
    console.warn(`[OWUI] Failed to emit ${type} for ${entry.viewKey}:`, error.message);
  }
}

function emitEventForView(viewKey, type, payload = {}) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return false;
  }

  emitToOwner(entry, type, {
    ...serializeEntry(entry),
    ...payload,
  });
  return true;
}

function getConversationTargetWindow(ownerWindowId) {
  if (state.windows.main && !state.windows.main.isDestroyed()) {
    return state.windows.main;
  }
  return getOwuiWindowById(ownerWindowId);
}

function routeConversationWindowOpen(url, entry) {
  const match = url.match(CONVERSATION_URL_RE);
  if (!match) {
    return false;
  }

  const targetWindow = getConversationTargetWindow(entry.ownerWindowId);
  if (!targetWindow) {
    return false;
  }

  try {
    targetWindow.webContents.send("open-conversation-tab", url, match[1]);
    return true;
  } catch (error) {
    console.warn("[OWUI] Failed to route conversation link:", error.message);
    return false;
  }
}

function isAllowedOwuiNavigation(url) {
  return ALLOWED_NAVIGATION_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function applyNavigationGuards(entry) {
  const contents = entry.view.webContents;
  if (contents.__porticoOwuiNavigationGuardsApplied) {
    return;
  }

  contents.__porticoOwuiNavigationGuardsApplied = true;
  contents.setWindowOpenHandler(({ url }) => {
    if (routeConversationWindowOpen(url, entry)) {
      return { action: "deny" };
    }

    try {
      void openHttpExternalUrl(shell, url);
    } catch (error) {
      // Ignore malformed URLs and deny by default.
    }

    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (
      entry.windowType === "chat" &&
      entry.ownerWindowId !== state.windows.main?.id &&
      routeConversationWindowOpen(url, entry)
    ) {
      event.preventDefault();
      return;
    }

    if (!isAllowedOwuiNavigation(url)) {
      event.preventDefault();
      void openHttpExternalUrl(shell, url).catch(() => {});
    }
  });
}

function bindWebContentsEvents(entry) {
  const contents = entry.view.webContents;
  if (contents.__porticoOwuiEventsBound) {
    return;
  }

  contents.__porticoOwuiEventsBound = true;
  contents.on("dom-ready", () => {
    void contents.insertCSS(CHAT_CURSOR_FIX_CSS).catch(() => {});
    if (state.appState.currentTheme) {
      void setTheme(entry.viewKey, state.appState.currentTheme).catch(() => {});
    }
    emitToOwner(entry, "dom-ready", serializeEntry(entry));
  });

  contents.on("did-finish-load", () => {
    entry.currentUrl = safeGetUrl(contents);
    syncChatRuntimeViewObservation(entry, entry.currentUrl);
    emitToOwner(entry, "did-finish-load", {
      ...serializeEntry(entry),
      url: entry.currentUrl,
    });
    broadcastChatActivitySnapshot();
  });

  contents.on(
    "did-fail-load",
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      emitToOwner(entry, "did-fail-load", {
        ...serializeEntry(entry),
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      });
    },
  );

  contents.on("did-navigate", (_event, url, httpResponseCode, httpStatusText) => {
    entry.currentUrl = url;
    if (syncChatRuntimeViewObservation(entry, url)) {
      broadcastChatActivitySnapshot();
    }
    emitToOwner(entry, "did-navigate", {
      ...serializeEntry(entry),
      url,
      httpResponseCode,
      httpStatusText,
    });
  });

  contents.on("did-navigate-in-page", (_event, url, isMainFrame, frameProcessId, frameRoutingId) => {
    entry.currentUrl = url;
    if (syncChatRuntimeViewObservation(entry, url)) {
      broadcastChatActivitySnapshot();
    }
    emitToOwner(entry, "did-navigate-in-page", {
      ...serializeEntry(entry),
      url,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    });
  });

  contents.on("page-title-updated", (_event, title, explicitSet) => {
    emitToOwner(entry, "page-title-updated", {
      ...serializeEntry(entry),
      title,
      explicitSet,
    });
  });

  contents.on("focus", () => {
    if (entry.currentChatId && chatRuntimeRegistry.markViewed(entry.currentChatId)) {
      broadcastChatActivitySnapshot();
    }
    emitToOwner(entry, "focus", serializeEntry(entry));
  });

  contents.on("found-in-page", (_event, result) => {
    const hostWindow = getOwuiHostWindow(entry);
    const payload = {
      activeMatchOrdinal: result?.activeMatchOrdinal,
      matches: result?.matches,
      finalUpdate: result?.finalUpdate,
    };

    if (hostWindow) {
      try {
        hostWindow.webContents.send("found-in-page-result", payload);
      } catch (error) {
        console.warn("[OWUI] Failed to forward found-in-page result to shell:", error.message);
      }
    }

  });

  const CONSOLE_FLUSH_INTERVAL_MS = 200;
  const CONSOLE_BUFFER_CAP = 50;
  let consoleMsgBuffer = [];
  let consoleMsgFlushTimer = null;

  contents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      emitToOwner(entry, "console-message", {
        ...serializeEntry(entry),
        level,
        message,
        line,
        sourceId,
      });
      return;
    }
    consoleMsgBuffer.push({ level, message, line, sourceId });
    if (consoleMsgBuffer.length > CONSOLE_BUFFER_CAP) {
      consoleMsgBuffer = consoleMsgBuffer.slice(-CONSOLE_BUFFER_CAP);
    }
    if (!consoleMsgFlushTimer) {
      consoleMsgFlushTimer = setTimeout(() => {
        const batch = consoleMsgBuffer;
        consoleMsgBuffer = [];
        consoleMsgFlushTimer = null;
        for (const msg of batch) {
          emitToOwner(entry, "console-message", {
            ...serializeEntry(entry),
            ...msg,
          });
        }
      }, CONSOLE_FLUSH_INTERVAL_MS);
    }
  });

  contents.on("render-process-gone", (_event, details) => {
    chatRuntimeRegistry.removeView(getChatRuntimeObservationKey(entry));
    broadcastChatActivitySnapshot();
    emitToOwner(entry, "render-process-gone", {
      ...serializeEntry(entry),
      details,
    });
  });

  contents.on("destroyed", () => {
    contentsIdToViewKey.delete(contents.id);
    chatRuntimeRegistry.removeView(getChatRuntimeObservationKey(entry));
  });
}

function handleTrackedWindowResize(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  const tracking = windowTracking.get(windowRef.id);
  if (!tracking || tracking.viewKeys.size === 0) {
    return;
  }

  const contentSize = getWindowContentSize(windowRef);
  if (!contentSize) {
    return;
  }

  for (const viewKey of tracking.viewKeys) {
    const entry = viewEntries.get(viewKey);
    if (
      !entry ||
      entry.attachedWindowId !== windowRef.id ||
      !entry.contentInsets
    ) {
      continue;
    }

    const nextBounds = getBoundsForInsets(contentSize, entry.contentInsets);
    if (!nextBounds || boundsEqual(entry.bounds, nextBounds)) {
      continue;
    }

    entry.bounds = nextBounds;
    if (entry.visible !== false) {
      entry.view.setBounds(nextBounds);
    }
  }
}

function ensureWindowTracking(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  let tracking = windowTracking.get(windowRef.id);
  if (tracking) {
    return tracking;
  }

  const onResize = () => {
    handleTrackedWindowResize(windowRef);
  };
  const onClosed = () => {
    windowRef.removeListener("resize", onResize);
    windowTracking.delete(windowRef.id);
  };

  tracking = {
    viewKeys: new Set(),
    onResize,
    onClosed,
  };

  windowTracking.set(windowRef.id, tracking);
  windowRef.on("resize", onResize);
  windowRef.once("closed", onClosed);

  return tracking;
}

function addTrackedView(windowRef, viewKey) {
  const tracking = ensureWindowTracking(windowRef);
  tracking?.viewKeys.add(viewKey);
}

function removeTrackedView(windowId, viewKey) {
  const tracking = windowTracking.get(Number(windowId));
  tracking?.viewKeys.delete(viewKey);
}

function createOwuiEntry(options) {
  getOwuiSession();
  const useNativeSidebarVibrancy =
    options.windowType === "main" &&
    isMacSidebarVibrancyEnabled({
      reduceTransparency: Boolean(
        systemPreferences?.isReduceTransparencyEnabled?.(),
      ),
    });
  const view = new WebContentsView({
    webPreferences: {
      preload: getPreloadPath(),
      partition: OPEN_WEBUI_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      transparent: useNativeSidebarVibrancy,
      backgroundThrottling: true,
      ...(useNativeSidebarVibrancy
        ? { additionalArguments: [NATIVE_SIDEBAR_VIBRANCY_ARGUMENT] }
        : {}),
    },
  });

  view.setBackgroundColor(
    useNativeSidebarVibrancy ? "#00000000" : "#171717",
  );

  const entry = {
    viewKey: options.viewKey,
    conversationId: options.conversationId || null,
    windowType: options.windowType || "main",
    ownerWindowId: Number(options.ownerWindowId),
    attachedWindowId: null,
    requestedUrl: options.url || "",
    currentUrl: "",
    bounds: normalizeBounds(options.bounds || {}),
    visible: options.visible !== false,
    view,
    contentInsets: null,
    currentChatId:
      extractChatIdFromOwuiUrl(options.url) ||
      String(options.conversationId || "").trim(),
  };

  contentsIdToViewKey.set(view.webContents.id, entry.viewKey);
  viewEntries.set(entry.viewKey, entry);
  chatRuntimeRegistry.setViewState(getChatRuntimeObservationKey(entry), {
    chatId: entry.currentChatId,
    visible: entry.visible !== false,
  });

  applyNavigationGuards(entry);
  bindWebContentsEvents(entry);

  return entry;
}

function detachFromWindow(entry) {
  const previousWindowId = entry.attachedWindowId;
  removeTrackedView(entry.attachedWindowId, entry.viewKey);
  if (Number.isFinite(Number(previousWindowId))) {
    const normalizedPreviousWindowId = Number(previousWindowId);
    if (activeViewKeys.get(normalizedPreviousWindowId) === entry.viewKey) {
      activeViewKeys.delete(normalizedPreviousWindowId);
    }
  }

  const currentWindow = getOwuiWindowById(entry.attachedWindowId);
  if (!currentWindow) {
    entry.attachedWindowId = null;
    return;
  }

  try {
    currentWindow.contentView.removeChildView(entry.view);
  } catch (error) {
    console.warn(`[OWUI] Failed to detach ${entry.viewKey}:`, error.message);
  }

  entry.attachedWindowId = null;
}

function attachToWindow(entry, ownerWindowId) {
  const targetWindow = getOwuiWindowById(ownerWindowId);
  if (!targetWindow) {
    throw new Error(`Window ${ownerWindowId} not available for ${entry.viewKey}`);
  }

  if (entry.attachedWindowId && entry.attachedWindowId !== targetWindow.id) {
    detachFromWindow(entry);
  }

  const alreadyAttached = entry.attachedWindowId === targetWindow.id;
  entry.ownerWindowId = targetWindow.id;
  entry.attachedWindowId = targetWindow.id;
  addTrackedView(targetWindow, entry.viewKey);

  if (!alreadyAttached) {
    targetWindow.contentView.addChildView(entry.view);
  }

  if (entry.bounds) {
    updateEntryInsets(entry, targetWindow);
  }

  syncNativeViewVisibility(entry, entry.visible !== false, {
    updateInsets: false,
    windowRef: targetWindow,
  });
}

async function maybeLoadUrl(entry, url) {
  const targetUrl = url ?? entry.requestedUrl;
  if (!targetUrl) {
    return;
  }

  entry.requestedUrl = targetUrl;
  const currentUrl = safeGetUrl(entry.view.webContents);
  if (currentUrl) {
    entry.currentUrl = currentUrl;
    if (areOwuiUrlsEquivalent(currentUrl, targetUrl)) {
      if (isOwuiUiUrl(targetUrl)) {
        await verifyOwuiFrontendAuthWithOneReseed(entry, targetUrl, "existing");
      }
      return;
    }
  }

  let loadUrl = targetUrl;
  try {
    loadUrl = await ensureOwuiHumanSessionForUrl({
      owuiSession: getOwuiSession(),
      targetUrl,
    });
  } catch (error) {
    console.warn("[OWUI] Failed to seed authenticated OWUI session:", error.message);
    return;
  }
  const seededCurrentUrl = safeGetUrl(entry.view.webContents);
  if (seededCurrentUrl) {
    entry.currentUrl = seededCurrentUrl;
    if (areOwuiUrlsEquivalent(seededCurrentUrl, loadUrl)) {
      if (isOwuiUiUrl(targetUrl)) {
        await verifyOwuiFrontendAuthWithOneReseed(entry, targetUrl, "existing");
      }
      return;
    }
  }

  try {
    await entry.view.webContents.loadURL(loadUrl);
    if (isOwuiUiUrl(targetUrl)) {
      await verifyOwuiFrontendAuthWithOneReseed(entry, targetUrl, "authenticated");
    }
  } catch (error) {
    // did-fail-load is the normal signal path for unavailable OWUI.
  }
}

async function createOrAdoptView(options = {}, ownerWindowId) {
  const normalizedWindowId = Number(ownerWindowId);
  let entry = viewEntries.get(options.viewKey);
  if (!entry) {
    entry = createOwuiEntry({
      ...options,
      ownerWindowId: normalizedWindowId,
    });
  } else {
    entry.ownerWindowId = normalizedWindowId;
    entry.windowType = options.windowType || entry.windowType;
    entry.conversationId = options.conversationId ?? entry.conversationId;
    if (options.bounds) {
      entry.bounds = normalizeBounds(options.bounds);
    }
    if (typeof options.visible === "boolean") {
      entry.visible = options.visible;
    }
  }

  attachToWindow(entry, normalizedWindowId);

  const targetUrl = options.url;
  const currentUrl = safeGetUrl(entry.view.webContents);
  if (
    targetUrl !== undefined &&
    targetUrl !== "" &&
    (isOwuiUiUrl(targetUrl) ||
      !currentUrl ||
      !areOwuiUrlsEquivalent(targetUrl, currentUrl) ||
      !areOwuiUrlsEquivalent(targetUrl, entry.requestedUrl))
  ) {
    await maybeLoadUrl(entry, targetUrl);
  } else if (targetUrl !== undefined && targetUrl !== "") {
    entry.requestedUrl = targetUrl;
    if (currentUrl) {
      entry.currentUrl = currentUrl;
    }
  }

  const observedUrl = safeGetUrl(entry.view.webContents) || targetUrl || entry.currentUrl;
  syncChatRuntimeViewObservation(entry, observedUrl);

  return serializeEntry(entry);
}

function getViewState(viewKey) {
  const entry = viewEntries.get(viewKey);
  return entry ? serializeEntry(entry) : null;
}

function setBounds(viewKey, bounds) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return null;
  }

  const windowRef = getOwuiHostWindow(entry);
  if (entry.visible === false) {
    entry.bounds = normalizeBounds(bounds);
    updateEntryInsets(entry, windowRef);
  } else {
    applyEntryBounds(entry, bounds, {
      windowRef,
    });
  }
  return serializeEntry(entry);
}

function setVisible(viewKey, visible) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return null;
  }

  const nextVisible = visible !== false;
  if (entry.visible !== nextVisible) {
    entry.visible = nextVisible;
    if (!nextVisible) {
      clearActiveViewForView(viewKey);
    }
    syncNativeViewVisibility(entry, nextVisible, {
      updateInsets: false,
      windowRef: getOwuiHostWindow(entry),
    });
    if (
      chatRuntimeRegistry.setViewState(getChatRuntimeObservationKey(entry), {
        chatId: entry.currentChatId,
        visible: nextVisible,
      })
    ) {
      broadcastChatActivitySnapshot();
    }
  }
  return serializeEntry(entry);
}

async function loadUrl(viewKey, url) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  await maybeLoadUrl(entry, url || "about:blank");
  return serializeEntry(entry);
}

async function reloadView(viewKey) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }

  entry.view.webContents.reload();
  return serializeEntry(entry);
}

async function executeJavaScript(viewKey, script) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  return entry.view.webContents.executeJavaScript(script);
}

async function insertCss(viewKey, css) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  return entry.view.webContents.insertCSS(css);
}

async function sendArtifactsUpdate(viewKey, detail) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  entry.view.webContents.send("owui-artifacts-update", detail);
  return serializeEntry(entry);
}

async function setTheme(viewKey, themeName) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  entry.view.webContents.send("owui-set-theme", themeName);
  return serializeEntry(entry);
}

async function recreateView(viewKey, url) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }

  const ownerWindowId = entry.ownerWindowId;
  const bounds = entry.bounds;
  const visible = entry.visible;
  const conversationId = entry.conversationId;
  const windowType = entry.windowType;
  const requestedUrl =
    url || entry.currentUrl || entry.requestedUrl || OPEN_WEBUI_HOME_URL;

  clearFindInPageSessionsForView(viewKey);
  clearActiveViewForView(viewKey);
  chatRuntimeRegistry.removeView(getChatRuntimeObservationKey(entry));
  detachFromWindow(entry);
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }

  const replacement = createOwuiEntry({
    viewKey,
    ownerWindowId,
    bounds,
    visible,
    conversationId,
    windowType,
    url: requestedUrl,
  });
  attachToWindow(replacement, ownerWindowId);
  await maybeLoadUrl(replacement, requestedUrl);
  return serializeEntry(replacement);
}

function destroyView(viewKey, expectedWebContentsId) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return false;
  }

  const normalizedExpectedId = Number(expectedWebContentsId);
  if (
    Number.isFinite(normalizedExpectedId) &&
    normalizedExpectedId > 0 &&
    entry.view.webContents.id !== normalizedExpectedId
  ) {
    console.warn(
      `[OWUI] Ignoring stale destroy for ${viewKey}: expected webContents ${normalizedExpectedId}, current ${entry.view.webContents.id}`,
    );
    return false;
  }

  clearFindInPageSessionsForView(viewKey);
  clearActiveViewForView(viewKey);
  chatRuntimeRegistry.removeView(getChatRuntimeObservationKey(entry));
  detachFromWindow(entry);
  viewEntries.delete(viewKey);
  contentsIdToViewKey.delete(entry.view.webContents.id);
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }
  broadcastChatActivitySnapshot();
  return true;
}

function destroyViewsForWindow(windowId) {
  const normalizedWindowId = Number(windowId);
  const keysToDestroy = [];
  for (const [viewKey, entry] of viewEntries.entries()) {
    if (
      entry.ownerWindowId === normalizedWindowId ||
      entry.attachedWindowId === normalizedWindowId
    ) {
      keysToDestroy.push(viewKey);
    }
  }

  keysToDestroy.forEach((viewKey) => {
    destroyView(viewKey);
  });
  activeViewKeys.delete(normalizedWindowId);
}

function listViews() {
  return Array.from(viewEntries.values()).map((entry) => serializeEntry(entry));
}

async function focusView(viewKey) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  entry.view.webContents.focus();
  return serializeEntry(entry);
}

async function capturePage(viewKey) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  return entry.view.webContents.capturePage();
}

async function sendInputEvent(viewKey, input) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown OWUI view: ${viewKey}`);
  }
  entry.view.webContents.sendInputEvent(input);
  return serializeEntry(entry);
}

function broadcastToViews(channel, payload) {
  for (const entry of viewEntries.values()) {
    try {
      if (!entry.view?.webContents?.isDestroyed()) {
        entry.view.webContents.send(channel, payload);
      }
    } catch (error) {
      console.warn("[OWUI Views] Failed to broadcast event:", channel, error.message);
    }
  }
}

function broadcastToOwnerViews(ownerWindowId, channel, payload) {
  for (const entry of viewEntries.values()) {
    if (entry.ownerWindowId !== ownerWindowId) {
      continue;
    }
    try {
      if (!entry.view?.webContents?.isDestroyed()) {
        entry.view.webContents.send(channel, payload);
      }
    } catch (error) {
      console.warn(
        "[OWUI Views] Failed to broadcast owner-scoped event:",
        channel,
        error.message,
      );
    }
  }
}

function getChatActivitySnapshot() {
  return chatRuntimeRegistry.getSnapshot();
}

function broadcastChatActivitySnapshot() {
  const snapshot = getChatActivitySnapshot();
  broadcastToViews("owui-chat-activity-snapshot", snapshot);
  return snapshot;
}

function reportChatRuntimeActivity(payload = {}) {
  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
  const previousState = chatRuntimeRegistry.getChatState(chatId);
  const changed = chatRuntimeRegistry.reportActivity(payload);
  const nextState = chatRuntimeRegistry.getChatState(chatId);
  if (changed && typeof chatRuntimeTransitionListener === "function") {
    try {
      chatRuntimeTransitionListener({
        chatId,
        previousState,
        nextState,
        payload,
      });
    } catch (error) {
      console.warn(
        "[OWUI Views] Chat runtime transition listener failed:",
        error?.message || error,
      );
    }
  }
  return changed;
}

function setChatRuntimeTransitionListener(listener) {
  chatRuntimeTransitionListener = typeof listener === "function" ? listener : null;
}

function updateChatActivityForContents(contents, payload = {}) {
  const viewKey = getViewKeyForContents(contents);
  if (!viewKey) {
    return null;
  }

  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return null;
  }

  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
  entry.currentChatId = chatId;
  // Multi-chat tiling: remembered per view so shell artifact routing can
  // force windowed-only opens for THAT tab (queried via
  // isMultiChatActiveForChatId — per-tab, never any-view).
  entry.multiChatActive = payload?.multiChat === true;
  chatRuntimeRegistry.setViewState(getChatRuntimeObservationKey(entry), {
    chatId,
    visible: entry.visible !== false,
  });
  reportChatRuntimeActivity(payload);
  return broadcastChatActivitySnapshot();
}

// Multi-chat tiling: is the view CURRENTLY SHOWING this chat tiled? Artifact
// attach/dock decisions are per-tab — a tiled workflow in one tab must not
// affect artifacts belonging to chats in other, untiled tabs.
function isMultiChatActiveForChatId(chatId) {
  const normalized = typeof chatId === "string" ? chatId.trim() : "";
  if (!normalized) {
    return false;
  }
  for (const entry of viewEntries.values()) {
    if (entry?.currentChatId === normalized && entry?.multiChatActive === true) {
      return true;
    }
  }
  return false;
}

// Runtime-only reconciliation deliberately does not emit the owner window's
// `tab-activity-changed` event. It is used when the visible OWUI sidebar checks
// a previously active chat after navigating elsewhere; settling chat A must
// not clear chat B's top-tab loader.
function reconcileChatRuntimeForContents(contents, payload = {}) {
  if (!getViewKeyForContents(contents)) {
    return null;
  }
  reportChatRuntimeActivity(payload);
  return broadcastChatActivitySnapshot();
}

function patchChatRuntimeForContents(contents, payload = {}) {
  if (!getViewKeyForContents(contents)) {
    return null;
  }
  chatRuntimeRegistry.patchChatState(payload);
  return broadcastChatActivitySnapshot();
}

function acknowledgeChatRuntimeForContents(contents, chatId) {
  const viewKey = getViewKeyForContents(contents);
  if (!viewKey) {
    return null;
  }
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return null;
  }
  entry.currentChatId = typeof chatId === "string" ? chatId.trim() : "";
  chatRuntimeRegistry.setViewState(getChatRuntimeObservationKey(entry), {
    chatId: entry.currentChatId,
    visible: entry.visible !== false,
  });
  return broadcastChatActivitySnapshot();
}

function getChatActivitySnapshotForContents(contents) {
  if (!getViewKeyForContents(contents)) {
    return null;
  }
  return getChatActivitySnapshot();
}

function getViewKeyForContents(contents) {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return contentsIdToViewKey.get(contents.id) || null;
}

function sendToOwnerWindowForContents(contents, channel, payload = {}) {
  const viewKey = getViewKeyForContents(contents);
  if (!viewKey) {
    return false;
  }

  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return false;
  }

  const ownerWindow = getOwuiWindowById(entry.ownerWindowId);
  if (!ownerWindow) {
    return false;
  }

  try {
    ownerWindow.webContents.send(channel, {
      viewKey,
      conversationId: entry.conversationId || null,
      ...payload,
    });
    return true;
  } catch (error) {
    console.warn(
      "[OWUI Views] Failed to send owner-window event:",
      channel,
      error.message,
    );
    return false;
  }
}

function forwardArtifactAction(contents, payload) {
  const viewKey = getViewKeyForContents(contents);
  if (!viewKey) {
    return false;
  }

  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return false;
  }

  emitToOwner(entry, "artifact-action", {
    ...serializeEntry(entry),
    payload,
  });
  return true;
}

function getActiveViewKey() {
  for (const [key, entry] of viewEntries.entries()) {
    if (entry.visible !== false && !entry.view?.webContents?.isDestroyed()) {
      return key;
    }
  }
  return null;
}

const activeViewKeys = new Map();
const _findInPageSessions = new Map();
const GLOBAL_FIND_IN_PAGE_SESSION_KEY = "__global__";

function clearActiveViewForView(viewKey) {
  for (const [windowId, activeViewKey] of activeViewKeys.entries()) {
    if (activeViewKey === viewKey) {
      activeViewKeys.delete(windowId);
    }
  }
}

function isWindowOwnedViewEntry(entry, windowId) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return false;
  }

  if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) {
    return false;
  }

  const ownerId = Number(entry.attachedWindowId || entry.ownerWindowId);
  return ownerId === normalizedWindowId;
}

function isEligibleActiveViewEntry(entry, windowId) {
  return isWindowOwnedViewEntry(entry, windowId) && entry.visible !== false;
}

function getFindInPageSessionKey(windowId) {
  const normalizedWindowId = Number(windowId);
  return Number.isFinite(normalizedWindowId) ? normalizedWindowId : GLOBAL_FIND_IN_PAGE_SESSION_KEY;
}

function clearFindInPageSessionsForView(viewKey) {
  for (const [sessionKey, session] of _findInPageSessions.entries()) {
    if (session?.viewKey === viewKey) {
      _findInPageSessions.delete(sessionKey);
    }
  }
}

function setActiveViewForWindow(windowId, viewKey) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return false;
  }

  if (!viewKey) {
    activeViewKeys.delete(normalizedWindowId);
    return true;
  }

  const entry = viewEntries.get(viewKey);
  if (!isEligibleActiveViewEntry(entry, normalizedWindowId)) {
    activeViewKeys.delete(normalizedWindowId);
    return false;
  }

  activeViewKeys.set(normalizedWindowId, viewKey);
  if (
    entry.currentChatId &&
    chatRuntimeRegistry.markViewed(entry.currentChatId)
  ) {
    broadcastChatActivitySnapshot();
  }
  return true;
}

function getActiveViewKeyForWindow(windowId) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return null;
  }

  const explicit = activeViewKeys.get(normalizedWindowId);
  if (explicit) {
    const entry = viewEntries.get(explicit);
    if (isEligibleActiveViewEntry(entry, normalizedWindowId)) {
      return explicit;
    }
    activeViewKeys.delete(normalizedWindowId);
  }
  for (const [key, entry] of viewEntries.entries()) {
    if (isEligibleActiveViewEntry(entry, normalizedWindowId)) {
      return key;
    }
  }
  return null;
}

function sendToActiveViewForWindow(windowId, channel, payload) {
  const viewKey = getActiveViewKeyForWindow(windowId);
  if (!viewKey) return;
  const entry = viewEntries.get(viewKey);
  if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) return;
  try {
    entry.view.webContents.send(channel, payload);
  } catch (error) {
    console.warn("[OWUI Views] sendToActiveViewForWindow failed:", channel, error.message);
  }
}

function sendToView(viewKey, channel, payload) {
  const entry = viewEntries.get(viewKey);
  if (!entry?.view?.webContents || entry.view.webContents.isDestroyed()) return false;
  try {
    entry.view.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function sendToWindowViews(windowId, channel, payload) {
  for (const entry of viewEntries.values()) {
    const ownerId = entry.attachedWindowId || entry.ownerWindowId;
    if (ownerId !== windowId) continue;
    try {
      if (!entry.view?.webContents?.isDestroyed()) {
        entry.view.webContents.send(channel, payload);
      }
    } catch (error) {
      console.warn("[OWUI Views] Failed to send to window view:", channel, error.message);
    }
  }
}

function nativeFindInPage(entry, text, options) {
  return entry.view.webContents.findInPage(text, options);
}

function deliverFindResult(entry, payload) {
  const hostWindow = getOwuiHostWindow(entry);
  if (!hostWindow) return;
  try {
    hostWindow.webContents.send("found-in-page-result", payload);
  } catch (error) {
    console.warn(
      "[OWUI] Failed to forward in-page-result to shell:",
      error.message,
    );
  }
}

async function runHighlightAction(entry, action, params) {
  const script = owuiLocalFindController.buildActionScript(action, params);
  try {
    return await entry.view.webContents.executeJavaScript(script, true);
  } catch (error) {
    console.warn(
      "[OWUI] Highlight-API local-find script failed; falling back to native:",
      error.message,
    );
    return null;
  }
}

function resolveSessionViewForWindow(normalizedWindowId) {
  const sessionKey = getFindInPageSessionKey(normalizedWindowId);
  const session = _findInPageSessions.get(sessionKey);
  let viewKey = null;
  if (session?.viewKey) {
    const sessionEntry = viewEntries.get(session.viewKey);
    if (isEligibleActiveViewEntry(sessionEntry, normalizedWindowId)) {
      viewKey = session.viewKey;
    } else {
      _findInPageSessions.delete(sessionKey);
    }
  }
  if (!viewKey) {
    viewKey = getActiveViewKeyForWindow(normalizedWindowId);
  }
  return { sessionKey, viewKey };
}

function findInPage(text, options = {}, windowId) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return null;
  }

  const viewKey = getActiveViewKeyForWindow(normalizedWindowId);
  if (!viewKey) return null;

  const entry = viewEntries.get(viewKey);
  if (!isEligibleActiveViewEntry(entry, normalizedWindowId)) return null;

  const sessionKey = getFindInPageSessionKey(normalizedWindowId);
  const existingSession = _findInPageSessions.get(sessionKey);
  const isContinuation =
    options.findNext === false && existingSession?.engine === "highlight";

  // PORTICO PATCH (B1 fix): once a session has fallen back to native — either
  // because the env flag forces it, or because runHighlightAction reported
  // unsupported / threw — stay on native for the rest of that session. The
  // Custom Highlight API support flag is a property of the WebContentsView and
  // doesn't flip mid-session, so retrying the highlight engine on every
  // keystroke just costs an executeJavaScript round-trip we know will fail.
  // Critically, it also means deliverHighlightUpdateForContents would never
  // forward streaming updates because session.engine would still read "native"
  // while we kept relabeling it back to "highlight" pre-result.
  if (NATIVE_FIND_FORCED || existingSession?.engine === "native") {
    _findInPageSessions.set(sessionKey, {
      viewKey,
      windowId: normalizedWindowId,
      engine: "native",
    });
    return nativeFindInPage(entry, text, options);
  }

  _findInPageSessions.set(sessionKey, {
    viewKey,
    windowId: normalizedWindowId,
    engine: "highlight",
  });

  // Highlight API path. We resolve the dispatch synchronously for the IPC
  // caller, then forward the result to the host window's existing
  // found-in-page-result channel — same shape as the native path so find-bar.js
  // is unchanged.
  const action = isContinuation
    ? options.forward === false
      ? "prev"
      : "next"
    : "search";

  runHighlightAction(entry, action, {
    query: text,
    matchCase: options.matchCase === true,
    regex: options.regex === true,
    findNext: options.findNext !== false,
  }).then((result) => {
    if (!result) {
      // Highlight API not supported on this platform — degrade to native and
      // let `found-in-page` events flow naturally.
      _findInPageSessions.set(sessionKey, {
        viewKey,
        windowId: normalizedWindowId,
        engine: "native",
      });
      try {
        nativeFindInPage(entry, text, options);
      } catch (error) {
        console.warn(
          "[OWUI] Native findInPage fallback failed:",
          error.message,
        );
      }
      return;
    }

    if (result.supported === false) {
      _findInPageSessions.set(sessionKey, {
        viewKey,
        windowId: normalizedWindowId,
        engine: "native",
      });
      try {
        nativeFindInPage(entry, text, options);
      } catch (error) {
        console.warn(
          "[OWUI] Native findInPage fallback failed:",
          error.message,
        );
      }
      return;
    }

    deliverFindResult(entry, {
      activeMatchOrdinal: result.activeOrdinal || 0,
      matches: result.totalMatches || 0,
      finalUpdate: true,
    });
  });

  return true;
}

function stopFindInPage(action = "clearSelection", windowId) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return;
  }

  const { sessionKey, viewKey } = resolveSessionViewForWindow(normalizedWindowId);
  if (!viewKey) return;

  const entry = viewEntries.get(viewKey);
  if (!isEligibleActiveViewEntry(entry, normalizedWindowId)) {
    _findInPageSessions.delete(sessionKey);
    return;
  }

  // Always stop the native session — harmless if it was never started, and
  // necessary if we ever fell back to the native engine.
  try {
    entry.view.webContents.stopFindInPage(action);
  } catch (_e) {
    /* swallow */
  }

  // And tear down the in-page controller's highlights / observer.
  runHighlightAction(entry, "stop", {}).catch(() => {});

  _findInPageSessions.delete(sessionKey);
}

function deliverHighlightUpdateForContents(contents, payload) {
  if (!contents || contents.isDestroyed()) return false;
  const viewKey = getViewKeyForContents(contents);
  if (!viewKey) return false;
  const entry = viewEntries.get(viewKey);
  if (!entry) return false;

  // Only forward updates while a Highlight-API session is active for this
  // view's owner window. This prevents stray events from a background tab
  // from poisoning the foreground counter.
  const ownerWindowId = entry.attachedWindowId || entry.ownerWindowId;
  const sessionKey = getFindInPageSessionKey(ownerWindowId);
  const session = _findInPageSessions.get(sessionKey);
  if (!session || session.viewKey !== viewKey || session.engine !== "highlight") {
    return false;
  }

  deliverFindResult(entry, {
    activeMatchOrdinal: Math.max(0, Number(payload?.activeOrdinal) || 0),
    matches: Math.max(0, Number(payload?.totalMatches) || 0),
    finalUpdate: payload?.finalUpdate !== false,
  });
  return true;
}

function setupFindInPageForwarding(ownerWindow) {
  void ownerWindow;
  for (const entry of viewEntries.values()) {
    bindWebContentsEvents(entry);
  }
}

function getOpenConversationTabs() {
  const tabs = [];
  for (const [key, entry] of viewEntries.entries()) {
    if (entry.view?.webContents?.isDestroyed()) continue;
    try {
      const url = entry.view.webContents.getURL();
      const match = url.match(/\/c\/([a-f0-9-]+)/i);
      if (match) {
        tabs.push({
          viewKey: key,
          conversationId: match[1],
          visible: entry.visible !== false,
          ownerWindowId: entry.attachedWindowId || entry.ownerWindowId,
        });
      }
    } catch {}
  }
  return tabs;
}

module.exports = {
  OPEN_WEBUI_HOME_URL,
  createOrAdoptView,
  getViewState,
  setBounds,
  setVisible,
  loadUrl,
  reloadView,
  recreateView,
  destroyView,
  destroyViewsForWindow,
  executeJavaScript,
  insertCss,
  sendArtifactsUpdate,
  setTheme,
  listViews,
  focusView,
  capturePage,
  sendInputEvent,
  broadcastToViews,
  broadcastToOwnerViews,
  updateChatActivityForContents,
  reconcileChatRuntimeForContents,
  patchChatRuntimeForContents,
  acknowledgeChatRuntimeForContents,
  getChatActivitySnapshotForContents,
  isMultiChatActiveForChatId,
  setChatRuntimeTransitionListener,
  getViewKeyForContents,
  sendToOwnerWindowForContents,
  forwardArtifactAction,
  getActiveViewKey,
  getActiveViewKeyForWindow,
  setActiveViewForWindow,
  sendToActiveViewForWindow,
  sendToView,
  sendToWindowViews,
  emitEventForView,
  findInPage,
  stopFindInPage,
  deliverHighlightUpdateForContents,
  setupFindInPageForwarding,
  getOpenConversationTabs,
};
