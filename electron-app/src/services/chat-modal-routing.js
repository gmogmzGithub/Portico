function normalizeChatId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function extractChatIdFromOwuiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "about:blank") {
    return null;
  }

  try {
    const url = new URL(raw, "http://localhost:3789");
    const pathname = url.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/c\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function extractDisplayedChatIdFromView(view) {
  const currentUrl = String(view?.currentUrl || "").trim();
  if (!currentUrl || currentUrl === "about:blank") {
    return null;
  }
  return extractChatIdFromOwuiUrl(currentUrl);
}

function findOwuiViewForChatId(chatId, views = []) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId || !Array.isArray(views)) {
    return null;
  }

  return (
    views.find(
      (view) => extractDisplayedChatIdFromView(view) === normalizedChatId,
    ) || null
  );
}

function getLiveWindowById(BrowserWindow, windowId) {
  if (!BrowserWindow || !Number.isFinite(Number(windowId))) {
    return null;
  }
  const windowRef = BrowserWindow.fromId(Number(windowId));
  if (!windowRef || windowRef.isDestroyed?.()) {
    return null;
  }
  return windowRef;
}

function getFallbackWindow(
  BrowserWindow,
  mainWindow,
  allowAlternateFallback = true,
) {
  if (mainWindow && !mainWindow.isDestroyed?.()) {
    return mainWindow;
  }
  if (!allowAlternateFallback) {
    return null;
  }

  const windows =
    typeof BrowserWindow?.getAllWindows === "function"
      ? BrowserWindow.getAllWindows()
      : [];
  return windows.find((windowRef) => windowRef && !windowRef.isDestroyed?.()) || null;
}

function resolveModalTargetWindow({
  chatId,
  BrowserWindow,
  mainWindow,
  owuiViews,
  allowAlternateFallback = true,
} = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (normalizedChatId && owuiViews?.listViews) {
    const matchedView = findOwuiViewForChatId(
      normalizedChatId,
      owuiViews.listViews(),
    );
    const matchedWindow =
      getLiveWindowById(BrowserWindow, matchedView?.ownerWindowId) ||
      getLiveWindowById(BrowserWindow, matchedView?.attachedWindowId);
    if (matchedWindow) {
      return {
        window: matchedWindow,
        reason: "chat-window",
        chatId: normalizedChatId,
        matchedView,
      };
    }
  }

  return {
    window: getFallbackWindow(
      BrowserWindow,
      mainWindow,
      allowAlternateFallback,
    ),
    reason: "fallback-main-window",
    chatId: normalizedChatId,
    matchedView: null,
  };
}

function sendModalRequestToChatWindow({
  channel,
  payload = {},
  chatId,
  BrowserWindow,
  mainWindow,
  owuiViews,
  app,
  activateFallback = true,
  allowAlternateFallback = true,
  logger = console,
} = {}) {
  const target = resolveModalTargetWindow({
    chatId,
    BrowserWindow,
    mainWindow,
    owuiViews,
    allowAlternateFallback,
  });

  if (!target.window) {
    logger.warn?.(`[ModalRouting] No live window available for ${channel}`);
    return { sent: false, reason: "no-window", chatId: target.chatId };
  }

  const modalTarget = target.matchedView
    ? {
        viewKey: target.matchedView.viewKey || null,
        conversationId: target.matchedView.conversationId || null,
        windowType: target.matchedView.windowType || null,
      }
    : null;
  const deliveryPayload = modalTarget
    ? { ...payload, __modalTarget: modalTarget }
    : payload;
  const shouldActivateWindow =
    target.reason !== "chat-window" && activateFallback !== false;

  target.window.webContents.send(channel, deliveryPayload);
  if (shouldActivateWindow) {
    target.window.show?.();
    target.window.focus?.();
  }

  if (shouldActivateWindow && process.platform === "darwin") {
    try {
      app?.dock?.bounce?.("critical");
    } catch (_) {}
  }

  return {
    sent: true,
    reason: target.reason,
    chatId: target.chatId,
    windowId: target.window.id || null,
    matchedViewKey: target.matchedView?.viewKey || null,
    activatedWindow: shouldActivateWindow,
  };
}

module.exports = {
  extractChatIdFromOwuiUrl,
  extractDisplayedChatIdFromView,
  findOwuiViewForChatId,
  resolveModalTargetWindow,
  sendModalRequestToChatWindow,
};
