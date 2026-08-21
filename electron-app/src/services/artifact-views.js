const { BrowserWindow, WebContentsView, session } = require("electron");

const ARTIFACT_PARTITION = "persist:artifacts";
const ARTIFACT_VIEW_EVENT_CHANNEL = "artifact-view-event";
// See owui-views.js for full explanation: on macOS, hidden WebContentsViews must
// stay "visible" to the native NSView hierarchy to prevent the native titlebar
// hit-test zone from expanding and eating header button clicks.
const IS_MAC = process.platform === "darwin";
const HIDDEN_VIEW_BOUNDS = Object.freeze(
  IS_MAC
    ? { x: -1, y: -1, width: 1, height: 1 }
    : { x: 0, y: 0, width: 0, height: 0 },
);

const viewEntries = new Map();
const contentsIdToViewKey = new Map();
const windowTracking = new Map();

function getArtifactWindowById(windowId) {
  if (!Number.isFinite(Number(windowId))) {
    return null;
  }

  const windowRef = BrowserWindow.fromId(Number(windowId));
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  return windowRef;
}

function getArtifactSession() {
  const artifactSession = session.fromPartition(ARTIFACT_PARTITION);
  if (artifactSession.__porticoArtifactViewsConfigured) {
    return artifactSession;
  }

  artifactSession.__porticoArtifactViewsConfigured = true;
  const isClipboardPermission = (permission) =>
    permission === "clipboard-read" ||
    permission === "clipboard-write" ||
    permission === "clipboard-sanitized-write";

  artifactSession.setPermissionCheckHandler((_contents, permission) => {
    return isClipboardPermission(permission);
  });

  artifactSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isClipboardPermission(permission));
  });

  artifactSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    if (
      details.url.includes("://localhost:") ||
      details.url.includes("://127.0.0.1:")
    ) {
      responseHeaders["Permissions-Policy"] = [
        "clipboard-read=*, clipboard-write=*",
      ];
    }
    callback({ responseHeaders });
  });

  return artifactSession;
}

async function clearArtifactSessionCache() {
  const artifactSession = getArtifactSession();
  if (typeof artifactSession.clearCache !== "function") {
    return;
  }

  try {
    await artifactSession.clearCache();
  } catch (error) {
    console.warn("[Artifacts] Failed to clear artifact view cache:", error.message);
  }
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

function getInsetsForBounds(bounds, contentSize) {
  if (!bounds || !contentSize) {
    return null;
  }

  return {
    left: bounds.x,
    top: bounds.y,
    right: contentSize.width - (bounds.x + bounds.width),
    bottom: contentSize.height - (bounds.y + bounds.height),
  };
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

function safeGetUrl(contents) {
  if (!contents || contents.isDestroyed()) {
    return "";
  }

  try {
    return contents.getURL() || "";
  } catch (_error) {
    return "";
  }
}

function serializeEntry(entry) {
  const currentUrl = safeGetUrl(entry.view.webContents);
  if (currentUrl) {
    entry.currentUrl = currentUrl;
  }

  return {
    viewKey: entry.viewKey,
    ownerWindowId: entry.ownerWindowId,
    attachedWindowId: entry.attachedWindowId,
    webContentsId: entry.view.webContents.id,
    currentUrl: entry.currentUrl || "",
    requestedUrl: entry.requestedUrl || "",
    visible: entry.visible !== false,
    bounds: entry.bounds || null,
  };
}

function emitToOwner(entry, type, payload = {}) {
  const ownerWindow = getArtifactWindowById(entry.ownerWindowId);
  if (!ownerWindow) {
    return;
  }

  try {
    ownerWindow.webContents.send(ARTIFACT_VIEW_EVENT_CHANNEL, {
      viewKey: entry.viewKey,
      type,
      ...payload,
    });
  } catch (error) {
    console.warn(
      `[Artifacts] Failed to emit artifact view event ${type} for ${entry.viewKey}:`,
      error.message
    );
  }
}

function bindWebContentsEvents(entry) {
  const contents = entry.view.webContents;
  if (contents.__porticoArtifactViewEventsBound) {
    return;
  }

  contents.__porticoArtifactViewEventsBound = true;
  contents.on("dom-ready", () => {
    emitToOwner(entry, "dom-ready", serializeEntry(entry));
  });

  contents.on("did-finish-load", () => {
    entry.currentUrl = safeGetUrl(contents);
    emitToOwner(entry, "did-finish-load", {
      ...serializeEntry(entry),
      url: entry.currentUrl,
    });
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
      frameRoutingId
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
    }
  );

  contents.on("did-navigate", (_event, url, httpResponseCode, httpStatusText) => {
    entry.currentUrl = url;
    emitToOwner(entry, "did-navigate", {
      ...serializeEntry(entry),
      url,
      httpResponseCode,
      httpStatusText,
    });
  });

  contents.on(
    "did-navigate-in-page",
    (_event, url, isMainFrame, frameProcessId, frameRoutingId) => {
      entry.currentUrl = url;
      emitToOwner(entry, "did-navigate-in-page", {
        ...serializeEntry(entry),
        url,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      });
    }
  );

  contents.on("console-message", (_event, level, message, line, sourceId) => {
    emitToOwner(entry, "console-message", {
      ...serializeEntry(entry),
      level,
      message,
      line,
      sourceId,
    });
  });

  contents.on("render-process-gone", (_event, details) => {
    emitToOwner(entry, "render-process-gone", {
      ...serializeEntry(entry),
      details,
    });
  });

  contents.on("destroyed", () => {
    contentsIdToViewKey.delete(contents.id);
  });
}

function updateEntryInsets(entry, windowRef = getArtifactWindowById(entry?.attachedWindowId || entry?.ownerWindowId)) {
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

  entry.view.setBounds(HIDDEN_VIEW_BOUNDS);
  if (!IS_MAC) {
    entry.view.setVisible(false);
  }
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
    if (!entry || entry.attachedWindowId !== windowRef.id || !entry.contentInsets) {
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

function createArtifactEntry(options = {}) {
  getArtifactSession();

  const view = new WebContentsView({
    webPreferences: {
      partition: ARTIFACT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });

  const entry = {
    viewKey: options.viewKey,
    ownerWindowId: Number(options.ownerWindowId),
    attachedWindowId: null,
    requestedUrl: options.url || "",
    currentUrl: "",
    bounds: normalizeBounds(options.bounds || {}),
    visible: options.visible !== false,
    view,
    contentInsets: null,
  };

  contentsIdToViewKey.set(view.webContents.id, entry.viewKey);
  viewEntries.set(entry.viewKey, entry);
  bindWebContentsEvents(entry);

  return entry;
}

function detachFromWindow(entry) {
  removeTrackedView(entry.attachedWindowId, entry.viewKey);

  const currentWindow = getArtifactWindowById(entry.attachedWindowId);
  if (!currentWindow) {
    entry.attachedWindowId = null;
    return;
  }

  try {
    currentWindow.contentView.removeChildView(entry.view);
  } catch (error) {
    console.warn(`[Artifacts] Failed to detach artifact view ${entry.viewKey}:`, error.message);
  }

  entry.attachedWindowId = null;
}

function attachToWindow(entry, ownerWindowId) {
  const targetWindow = getArtifactWindowById(ownerWindowId);
  if (!targetWindow) {
    throw new Error(`Window ${ownerWindowId} not available for artifact view ${entry.viewKey}`);
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

async function maybeLoadUrl(entry, url, options = {}) {
  const targetUrl = url ?? entry.requestedUrl;
  if (!targetUrl) {
    return;
  }

  entry.requestedUrl = targetUrl;
  if (options.bypassCache) {
    await clearArtifactSessionCache();
  }

  try {
    await entry.view.webContents.loadURL(targetUrl);
  } catch (_error) {
    // did-fail-load is the normal signal path for unavailable artifact previews.
  }
}

async function createOrAdoptView(options = {}, ownerWindowId) {
  const normalizedWindowId = Number(ownerWindowId);
  let entry = viewEntries.get(options.viewKey);
  if (!entry) {
    entry = createArtifactEntry({
      ...options,
      ownerWindowId: normalizedWindowId,
    });
  } else {
    entry.ownerWindowId = normalizedWindowId;
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
    (
      options.forceLoad ||
      !currentUrl ||
      targetUrl !== currentUrl ||
      targetUrl !== entry.requestedUrl
    )
  ) {
    await maybeLoadUrl(entry, targetUrl, options);
  }

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

  const windowRef = getArtifactWindowById(entry.attachedWindowId || entry.ownerWindowId);
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
    syncNativeViewVisibility(entry, nextVisible, {
      updateInsets: false,
      windowRef: getArtifactWindowById(entry.attachedWindowId || entry.ownerWindowId),
    });
  }
  return serializeEntry(entry);
}

async function loadUrl(viewKey, url, options = {}) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown artifact view: ${viewKey}`);
  }

  await maybeLoadUrl(entry, url || "about:blank", options);
  return serializeEntry(entry);
}

async function reloadView(viewKey) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    throw new Error(`Unknown artifact view: ${viewKey}`);
  }

  entry.view.webContents.reload();
  return serializeEntry(entry);
}

function destroyView(viewKey) {
  const entry = viewEntries.get(viewKey);
  if (!entry) {
    return false;
  }

  detachFromWindow(entry);
  viewEntries.delete(viewKey);
  contentsIdToViewKey.delete(entry.view.webContents.id);
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }
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
}

function listViews() {
  return Array.from(viewEntries.values()).map((entry) => serializeEntry(entry));
}

module.exports = {
  ARTIFACT_PARTITION,
  ARTIFACT_VIEW_EVENT_CHANNEL,
  clearArtifactSessionCache,
  createOrAdoptView,
  getViewState,
  setBounds,
  setVisible,
  loadUrl,
  reloadView,
  destroyView,
  destroyViewsForWindow,
  listViews,
};
