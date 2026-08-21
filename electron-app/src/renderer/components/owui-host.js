(() => {
  if (window.__porticoOwuiHostInitialized) {
    return;
  }
  window.__porticoOwuiHostInitialized = true;

  const hostStateByElement = new WeakMap();
  const hostStateByViewKey = new Map();
  const pendingViewDisposals = new Map();
  // Multi-chat tiling: viewKey -> boolean, fed by tab-activity events.
  // Artifact routing must gate on the state of the TAB that owns the
  // artifact (isActiveForViewKey) — a tiled workflow in one tab must not
  // force windowed-only artifacts on other, untiled tabs. anyActive() stays
  // as the conservative fallback when a target tab cannot be resolved.
  const multiChatActiveByViewKey = new Map();
  function recordMultiChatActivity(viewKey, active) {
    if (typeof viewKey !== 'string' || !viewKey) {
      return;
    }
    if (active) {
      multiChatActiveByViewKey.set(viewKey, true);
    } else {
      multiChatActiveByViewKey.delete(viewKey);
    }
  }
  window.owuiMultiChat = {
    anyActive: () => multiChatActiveByViewKey.size > 0,
    isActiveForViewKey: (viewKey) =>
      typeof viewKey === 'string' && viewKey !== '' && multiChatActiveByViewKey.has(viewKey),
  };
  const interactionSuppressionReasons = new Set();
  const viewportInsetReasons = new Map();
  const OVERLAY_SNAPSHOT_TIMEOUT_MS = 1000;
  let interactionSuppressionGeneration = 0;

  function getViewportInsets() {
    const combined = {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };

    for (const insets of viewportInsetReasons.values()) {
      if (!insets) {
        continue;
      }
      combined.left = Math.max(combined.left, Number(insets.left) || 0);
      combined.top = Math.max(combined.top, Number(insets.top) || 0);
      combined.right = Math.max(combined.right, Number(insets.right) || 0);
      combined.bottom = Math.max(combined.bottom, Number(insets.bottom) || 0);
    }

    return combined;
  }

  function dispatchHostEvent(element, type, props = {}) {
    const event = new Event(type);
    Object.assign(event, props);
    element.dispatchEvent(event);
  }

  function isElementOwuiVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    if (
      element.classList.contains("hidden") ||
      element.classList.contains("owui-suppressed")
    ) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buildBounds(element) {
    const rect = element.getBoundingClientRect();
    const insets = getViewportInsets();
    const width = Math.max(0, rect.width - insets.left - insets.right);
    const height = Math.max(0, rect.height - insets.top - insets.bottom);
    return {
      x: Math.round(rect.x + insets.left),
      y: Math.round(rect.y + insets.top),
      width: Math.round(width),
      height: Math.round(height),
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

  function updateStateFromPayload(state, payload = {}) {
    if (!state) {
      return;
    }

    const previousCurrentUrl = state.currentUrl || "";
    if (Number.isFinite(Number(payload.webContentsId))) {
      state.webContentsId = Number(payload.webContentsId);
    }
    if (typeof payload.currentUrl === "string") {
      state.currentUrl = payload.currentUrl;
    }
    if (typeof payload.url === "string") {
      state.currentUrl = payload.url;
    }
    if (typeof payload.requestedUrl === "string") {
      state.src = payload.requestedUrl;
    }
    if (payload.bounds) {
      state.bounds = payload.bounds;
      state.lastSentBounds = payload.bounds;
    }
    if (typeof payload.visible === "boolean") {
      state.lastVisible = payload.visible;
    }

    const currentUrl = state.currentUrl || "";
    if (
      currentUrl !== previousCurrentUrl &&
      typeof window.dispatchEvent === "function"
    ) {
      const event = new Event("owui-committed-url-changed");
      event.detail = {
        viewKey: state.viewKey,
        windowType: state.windowType,
        conversationId: state.conversationId,
        previousUrl: previousCurrentUrl,
        currentUrl,
      };
      window.dispatchEvent(event);
    }
  }

  function normalizeComparableOwuiUrl(rawUrl) {
    if (!rawUrl) {
      return "";
    }

    try {
      const normalized = new URL(rawUrl, window.location.origin);
      normalized.searchParams.delete("detached-window");
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

  function showOverlaySnapshot(state) {
    if (!state?.overlaySnapshotUrl || !state.element) {
      return false;
    }

    state.element.style.backgroundImage = state.overlaySnapshotUrl;
    state.element.style.backgroundSize = "100% 100%";
    state.element.style.backgroundPosition = "center";
    state.element.style.backgroundRepeat = "no-repeat";
    return true;
  }

  function invalidateOverlaySnapshotRequest(state) {
    if (!state) {
      return;
    }

    state.overlaySnapshotRequestGeneration += 1;
    state.overlaySnapshotPromise = null;
  }

  function ensureOverlaySnapshot(state) {
    if (
      !state ||
      !state.created ||
      !window.electronAPI?.owui?.capturePage
    ) {
      return state?.overlaySnapshotUrl || null;
    }

    const hasCachedSnapshot = showOverlaySnapshot(state);
    if (hasCachedSnapshot && !state.overlaySnapshotDirty) {
      return state.overlaySnapshotUrl;
    }

    if (state.overlaySnapshotPromise) {
      return hasCachedSnapshot ? state.overlaySnapshotUrl : state.overlaySnapshotPromise;
    }

    const requestGeneration = state.overlaySnapshotRequestGeneration + 1;
    const suppressionGeneration = interactionSuppressionGeneration;
    state.overlaySnapshotRequestGeneration = requestGeneration;

    let timeoutId = null;
    const captureOutcome = Promise.resolve()
      .then(() => window.electronAPI.owui.capturePage(state.viewKey))
      .then(
        (pngBase64) => ({ status: "captured", pngBase64 }),
        (error) => ({ status: "failed", error }),
      );
    const timeoutOutcome = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ status: "timeout" });
      }, OVERLAY_SNAPSHOT_TIMEOUT_MS);
    });

    const snapshotPromise = Promise.race([captureOutcome, timeoutOutcome])
      .then((outcome) => {
        if (state.overlaySnapshotRequestGeneration !== requestGeneration) {
          return state.overlaySnapshotUrl || null;
        }

        if (outcome.status === "timeout") {
          console.warn(
            `[OWUI] Overlay snapshot capture timed out for ${state.viewKey}; continuing without a fresh snapshot`,
          );
          return state.overlaySnapshotUrl || null;
        }

        if (outcome.status === "failed") {
          console.warn("[OWUI] Failed to capture overlay snapshot:", outcome.error);
          return state.overlaySnapshotUrl || null;
        }

        if (
          !outcome.pngBase64 ||
          !state.element?.isConnected
        ) {
          return state.overlaySnapshotUrl || null;
        }

        state.overlaySnapshotUrl = `url(data:image/png;base64,${outcome.pngBase64})`;
        state.overlaySnapshotDirty = false;
        if (
          interactionSuppressionGeneration === suppressionGeneration &&
          interactionSuppressionReasons.size > 0 &&
          isElementOwuiVisible(state.element)
        ) {
          showOverlaySnapshot(state);
        }
        return state.overlaySnapshotUrl;
      })
      .finally(() => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (state.overlaySnapshotPromise === snapshotPromise) {
          state.overlaySnapshotPromise = null;
        }
      });
    state.overlaySnapshotPromise = snapshotPromise;

    return hasCachedSnapshot ? state.overlaySnapshotUrl : state.overlaySnapshotPromise;
  }

  function hideOverlaySnapshot(state) {
    if (!state) {
      return;
    }

    if (state.element) {
      state.element.style.backgroundImage = "";
      state.element.style.backgroundSize = "";
      state.element.style.backgroundPosition = "";
      state.element.style.backgroundRepeat = "";
    }
  }

  function resetOverlaySnapshot(state) {
    if (!state) {
      return;
    }

    invalidateOverlaySnapshotRequest(state);
    state.overlaySnapshotUrl = null;
    state.overlaySnapshotDirty = false;
    hideOverlaySnapshot(state);
  }

  function invalidateOverlaySnapshot(state) {
    if (!state) {
      return;
    }

    state.overlaySnapshotDirty = true;
  }

  function getDesiredVisibility(state) {
    if (!state || !state.created) {
      return false;
    }
    if (interactionSuppressionReasons.size > 0) {
      return false;
    }
    return isElementOwuiVisible(state.element);
  }

  async function syncBounds(state) {
    if (
      !state ||
      state.disposed ||
      !state.created ||
      !window.electronAPI?.owui?.setBounds
    ) {
      return;
    }

    const bounds = buildBounds(state.element);
    state.bounds = bounds;
    if (boundsEqual(state.lastSentBounds, bounds)) {
      return;
    }

    const payload = await window.electronAPI.owui.setBounds(state.viewKey, bounds);
    state.lastSentBounds = bounds;
    updateStateFromPayload(state, payload);
  }

  function scheduleBoundsSync(state) {
    if (!state || state.disposed || state.boundsRaf !== null) {
      return;
    }

    state.boundsRaf = window.requestAnimationFrame(() => {
      state.boundsRaf = null;
      if (getDesiredVisibility(state)) {
        void syncBounds(state);
      }
    });
  }

  async function syncVisibility(state) {
    if (
      !state ||
      state.disposed ||
      !state.created ||
      !window.electronAPI?.owui?.setVisible
    ) {
      return;
    }

    const visibilityGeneration = state.visibilityGeneration + 1;
    state.visibilityGeneration = visibilityGeneration;
    const isSuppressed =
      interactionSuppressionReasons.size > 0 && isElementOwuiVisible(state.element);

    if (isSuppressed) {
      // A native WebContentsView always paints above renderer DOM. Snapshot
      // capture is only a visual enhancement for translucent overlays, so it
      // must never delay moving the native view out of the modal's way.
      void ensureOverlaySnapshot(state);
    }

    const visible = getDesiredVisibility(state);
    if (state.lastVisible !== visible) {
      state.lastVisible = visible;
      await window.electronAPI.owui.setVisible(state.viewKey, visible);
    }

    if (state.visibilityGeneration !== visibilityGeneration) {
      return;
    }

    if (visible) {
      scheduleBoundsSync(state);
      window.requestAnimationFrame(() => {
        if (getDesiredVisibility(state)) {
          hideOverlaySnapshot(state);
        }
      });
    } else if (!isSuppressed) {
      hideOverlaySnapshot(state);
    }
  }

  async function createOrAdopt(state, options = {}) {
    if (
      !state ||
      state.disposed ||
      !window.electronAPI?.owui?.createOrAdoptView
    ) {
      return null;
    }

    const pendingDisposal = pendingViewDisposals.get(state.viewKey);
    if (pendingDisposal) {
      await pendingDisposal;
      if (state.disposed) {
        return null;
      }
    }

    if (state.createPromise) {
      const payload = await state.createPromise;
      updateStateFromPayload(state, payload);

      const explicitUrl =
        typeof options.url === "string" && options.url !== ""
          ? options.url
          : undefined;
      const currentUrl = state.currentUrl || "";
      const requestedUrl = state.src || "";
      if (
        explicitUrl &&
        !areOwuiUrlsEquivalent(explicitUrl, currentUrl) &&
        !areOwuiUrlsEquivalent(explicitUrl, requestedUrl) &&
        window.electronAPI?.owui?.loadUrl
      ) {
        const loadPayload = await window.electronAPI.owui.loadUrl(
          state.viewKey,
          explicitUrl,
        );
        updateStateFromPayload(state, loadPayload);
        return loadPayload;
      }

      return payload;
    }

    const requestedUrl =
      options.url !== undefined
        ? options.url
        : state.created
          ? undefined
          : state.src || state.currentUrl || undefined;

    const viewOptions = {
      viewKey: state.viewKey,
      windowType: state.windowType,
      conversationId: state.conversationId,
      bounds: buildBounds(state.element),
      visible: getDesiredVisibility({
        ...state,
        created: true,
      }),
    };
    if (requestedUrl !== undefined) {
      viewOptions.url = requestedUrl;
    }

    state.createPromise = window.electronAPI.owui
      .createOrAdoptView(viewOptions)
      .then((payload) => {
        state.created = true;
        updateStateFromPayload(state, payload);
        return payload;
      })
      .finally(() => {
        state.createPromise = null;
        if (!state.disposed) {
          scheduleBoundsSync(state);
          void syncVisibility(state);
        }
      });

    return state.createPromise;
  }

  async function loadUrl(state, url) {
    state.src = typeof url === "string" ? url : "";
    state.element.setAttribute("src", state.src);

    if (!state.src && !state.created) {
      return "";
    }

    const payload = await createOrAdopt(state, {
      url: state.src || "about:blank",
    });
    updateStateFromPayload(state, payload);
    return payload?.currentUrl || payload?.requestedUrl || state.currentUrl || "";
  }

  function isUnknownOwuiViewError(error) {
    return String(error?.message || error || "").includes("Unknown OWUI view:");
  }

  async function runOwuiOperationWithRecovery(state, operationName, operation) {
    await createOrAdopt(state);
    if (state.disposed) {
      throw new Error(`OWUI host disposed: ${state.viewKey}`);
    }
    try {
      return await operation();
    } catch (error) {
      if (state.disposed || !isUnknownOwuiViewError(error)) {
        throw error;
      }

      console.warn(
        `[OWUI] Native view ${state.viewKey} disappeared during ${operationName}; recreating it`,
      );
      state.created = false;
      state.webContentsId = 0;
      state.lastVisible = null;
      state.lastSentBounds = null;
      await createOrAdopt(state, {
        url: state.currentUrl || state.src || undefined,
      });
      return operation();
    }
  }

  function bindElementFacade(state) {
    const { element } = state;

    if (element.__owuiFacadeBound) {
      return;
    }
    element.__owuiFacadeBound = true;

    Object.defineProperty(element, "src", {
      configurable: true,
      enumerable: true,
      get() {
        return state.src || "";
      },
      set(value) {
        void loadUrl(state, value);
      },
    });

    element.loadURL = (url) => loadUrl(state, url);
    element.getURL = () => state.currentUrl || state.src || "";
    element.getCommittedURL = () => state.currentUrl || "";
    element.getWebContentsId = () => state.webContentsId || 0;
    element.insertCSS = async (css) => {
      return window.electronAPI?.owui?.insertCss
        ? runOwuiOperationWithRecovery(state, "insertCSS", () =>
            window.electronAPI.owui.insertCss(state.viewKey, css),
          )
        : null;
    };
    element.executeJavaScript = async (script) => {
      return window.electronAPI?.owui?.executeJavaScript
        ? runOwuiOperationWithRecovery(state, "executeJavaScript", () =>
            window.electronAPI.owui.executeJavaScript(state.viewKey, script),
          )
        : null;
    };
    element.reload = async () => {
      return window.electronAPI?.owui?.reloadView
        ? runOwuiOperationWithRecovery(state, "reload", () =>
            window.electronAPI.owui.reloadView(state.viewKey),
          )
        : null;
    };
    element.recreateOwuiView = async (url) => {
      if (!window.electronAPI?.owui?.recreateView) {
        return null;
      }
      const payload = await runOwuiOperationWithRecovery(
        state,
        "recreate",
        () => window.electronAPI.owui.recreateView(
          state.viewKey,
          url || state.currentUrl || state.src || "",
        ),
      );
      state.created = true;
      updateStateFromPayload(state, payload);
      scheduleBoundsSync(state);
      await syncVisibility(state);
      return payload;
    };
    element.attachOwuiView = () => createOrAdopt(state);
  }

  function observeElementState(state) {
    if (state.resizeObserver || state.mutationObserver) {
      return;
    }

    state.resizeObserver = new ResizeObserver(() => {
      scheduleBoundsSync(state);
      void syncVisibility(state);
    });
    state.resizeObserver.observe(state.element);

    state.mutationObserver = new MutationObserver(() => {
      scheduleBoundsSync(state);
      void syncVisibility(state);
    });
    state.mutationObserver.observe(state.element, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
  }

  function ensureOwuiHost(element, options = {}) {
    if (!element) {
      return null;
    }

    let state = hostStateByElement.get(element);
    if (!state) {
      state = {
        element,
        viewKey: options.viewKey || element.dataset.owuiViewKey || "",
        windowType: options.windowType || element.dataset.owuiWindowType || "main",
        conversationId:
          options.conversationId || element.dataset.owuiConversationId || null,
        src: options.url || element.getAttribute("src") || "",
        currentUrl: "",
        webContentsId: 0,
        bounds: null,
        created: false,
        disposed: false,
        createPromise: null,
        resizeObserver: null,
        mutationObserver: null,
        boundsRaf: null,
        lastVisible: null,
        lastSentBounds: null,
        visibilityGeneration: 0,
        overlaySnapshotUrl: null,
        overlaySnapshotPromise: null,
        overlaySnapshotDirty: false,
        overlaySnapshotRequestGeneration: 0,
      };
      hostStateByElement.set(element, state);
    } else {
      const previousViewKey = state.viewKey;
      state.viewKey = options.viewKey || state.viewKey;
      state.windowType = options.windowType || state.windowType;
      state.conversationId =
        options.conversationId !== undefined
          ? options.conversationId
          : state.conversationId;
      if (options.url !== undefined) {
        state.src = options.url;
      }
      if (
        previousViewKey &&
        previousViewKey !== state.viewKey &&
        hostStateByViewKey.get(previousViewKey) === state
      ) {
        hostStateByViewKey.delete(previousViewKey);
        multiChatActiveByViewKey.delete(previousViewKey);
      }
    }

    if (!state.viewKey) {
      throw new Error("OWUI host requires a viewKey");
    }

    hostStateByViewKey.set(state.viewKey, state);
    element.dataset.owuiHost = "true";
    element.dataset.owuiViewKey = state.viewKey;
    element.dataset.owuiWindowType = state.windowType;
    if (state.conversationId) {
      element.dataset.owuiConversationId = state.conversationId;
    }

    bindElementFacade(state);
    observeElementState(state);

    const initialRequestedUrl =
      options.url !== undefined
        ? options.url
        : state.created
          ? undefined
          : state.src || undefined;

    if (options.createImmediately || initialRequestedUrl !== undefined) {
      const createOptions = {};
      if (initialRequestedUrl !== undefined) {
        createOptions.url = initialRequestedUrl;
      }
      void createOrAdopt(state, createOptions);
    }

    return element;
  }

  function createOwuiHostElement(options = {}) {
    const element = document.createElement("div");
    element.className = options.className || "chat-webview";
    if (options.id) {
      element.id = options.id;
    }
    if (options.url) {
      element.setAttribute("src", options.url);
    }
    return ensureOwuiHost(element, options);
  }

  function disposeOwuiHost(element, options = {}) {
    const state = hostStateByElement.get(element);
    if (!state) {
      return Promise.resolve(false);
    }

    state.disposed = true;

    if (state.boundsRaf !== null) {
      window.cancelAnimationFrame(state.boundsRaf);
      state.boundsRaf = null;
    }
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
    resetOverlaySnapshot(state);

    hostStateByElement.delete(element);
    if (hostStateByViewKey.get(state.viewKey) === state) {
      hostStateByViewKey.delete(state.viewKey);
    }
    multiChatActiveByViewKey.delete(state.viewKey);
    element.__owuiFacadeBound = false;

    const previousDisposal = pendingViewDisposals.get(state.viewKey);
    const disposalPromise = Promise.resolve(previousDisposal)
      .catch(() => {})
      .then(async () => {
        if (state.createPromise) {
          try {
            await state.createPromise;
          } catch (_error) {
            return false;
          }
        }

        if (!state.created || !window.electronAPI?.owui) {
          return false;
        }
        if (options.destroyView && window.electronAPI.owui.destroyView) {
          return window.electronAPI.owui.destroyView(
            state.viewKey,
            state.webContentsId || undefined,
          );
        }
        if (window.electronAPI.owui.setVisible) {
          await window.electronAPI.owui.setVisible(state.viewKey, false);
          return true;
        }
        return false;
      })
      .catch((error) => {
        console.warn(
          `[OWUI] Failed to dispose native view ${state.viewKey}:`,
          error?.message || error,
        );
        return false;
      })
      .finally(() => {
        if (pendingViewDisposals.get(state.viewKey) === disposalPromise) {
          pendingViewDisposals.delete(state.viewKey);
        }
      });
    pendingViewDisposals.set(state.viewKey, disposalPromise);
    return disposalPromise;
  }

  function handleOwuiEvent(payload = {}) {
    const state = hostStateByViewKey.get(payload.viewKey);
    if (!state || !state.element) {
      return;
    }

    updateStateFromPayload(state, payload);
    if (
      payload.type === "did-finish-load" ||
      payload.type === "did-navigate" ||
      payload.type === "did-navigate-in-page"
    ) {
      invalidateOverlaySnapshot(state);
    }
    if (payload.type === "artifact-action") {
      const event = new Event("ipc-message");
      event.channel = "artifact-action";
      event.args = [payload.payload];
      state.element.dispatchEvent(event);
      return;
    }

    const props = {};
    switch (payload.type) {
      case "did-fail-load":
        props.errorCode = payload.errorCode;
        props.errorDescription = payload.errorDescription;
        props.validatedURL = payload.validatedURL;
        props.isMainFrame = payload.isMainFrame;
        break;
      case "did-navigate":
      case "did-navigate-in-page":
        props.url = payload.url;
        break;
      case "console-message":
        props.level = payload.level;
        props.message = payload.message;
        props.line = payload.line;
        props.sourceId = payload.sourceId;
        break;
      case "render-process-gone":
        props.details = payload.details;
        break;
      case "page-title-updated":
        props.title = payload.title;
        props.explicitSet = payload.explicitSet;
        break;
      case "focus":
        props.viewKey = payload.viewKey;
        break;
      case "tab-activity-changed":
        props.busy = payload.busy === true;
        props.phase = payload.phase || "idle";
        props.chatId = typeof payload.chatId === "string" ? payload.chatId : "";
        props.multiChat = payload.multiChat === true;
        props.modelIdentity =
          payload.modelIdentity && typeof payload.modelIdentity === "object"
            ? payload.modelIdentity
            : null;
        // Multi-chat tiling: shell-wide registry consulted by artifact
        // routing (artifact-panel/artifact-indicator) to force windowed-only
        // opens while any OWUI view shows a tiled layout. No new IPC — this
        // piggybacks the existing tab-activity fanout.
        recordMultiChatActivity(payload.viewKey, payload.multiChat === true);
        break;
      default:
        break;
    }

    dispatchHostEvent(state.element, payload.type, props);
  }

  function syncAllHosts() {
    for (const state of hostStateByViewKey.values()) {
      scheduleBoundsSync(state);
      void syncVisibility(state);
    }
  }

  function setOwuiInteractionSuppressed(reason, suppressed) {
    if (!reason) {
      return;
    }

    const wasSuppressed = interactionSuppressionReasons.size > 0;
    if (suppressed) {
      interactionSuppressionReasons.add(reason);
    } else {
      interactionSuppressionReasons.delete(reason);
    }
    const isSuppressed = interactionSuppressionReasons.size > 0;

    if (wasSuppressed !== isSuppressed) {
      interactionSuppressionGeneration += 1;
    }
    if (wasSuppressed && !isSuppressed) {
      for (const state of hostStateByViewKey.values()) {
        invalidateOverlaySnapshotRequest(state);
      }
    }

    syncAllHosts();
  }

  function isOwuiInteractionSuppressed() {
    return interactionSuppressionReasons.size > 0;
  }

  function setOwuiViewportInset(reason, insets = {}) {
    if (!reason) {
      return;
    }

    const normalized = {
      left: Math.max(0, Number(insets.left) || 0),
      top: Math.max(0, Number(insets.top) || 0),
      right: Math.max(0, Number(insets.right) || 0),
      bottom: Math.max(0, Number(insets.bottom) || 0),
    };

    if (
      normalized.left === 0 &&
      normalized.top === 0 &&
      normalized.right === 0 &&
      normalized.bottom === 0
    ) {
      viewportInsetReasons.delete(reason);
    } else {
      viewportInsetReasons.set(reason, normalized);
    }

    syncAllHosts();
  }

  if (window.electronAPI?.owui?.onEvent) {
    window.electronAPI.owui.onEvent((payload) => {
      handleOwuiEvent(payload);
    });
  }

  window.addEventListener("resize", syncAllHosts);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncAllHosts);
  }

  window.ensureOwuiHost = ensureOwuiHost;
  window.createOwuiHostElement = createOwuiHostElement;
  window.disposeOwuiHost = disposeOwuiHost;
  window.syncOwuiHosts = syncAllHosts;
  window.setOwuiInteractionSuppressed = setOwuiInteractionSuppressed;
  window.isOwuiInteractionSuppressed = isOwuiInteractionSuppressed;
  window.setOwuiViewportInset = setOwuiViewportInset;
})();
