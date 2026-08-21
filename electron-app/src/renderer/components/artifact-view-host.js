(() => {
  if (window.__porticoArtifactViewHostInitialized) {
    return;
  }
  window.__porticoArtifactViewHostInitialized = true;

  const hostStateByElement = new WeakMap();
  const hostStateByViewKey = new Map();

  function dispatchHostEvent(element, type, props = {}) {
    const event = new Event(type);
    Object.assign(event, props);
    element.dispatchEvent(event);
  }

  function isElementArtifactVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    if (
      element.classList.contains("hidden") ||
      element.classList.contains("artifact-view-suppressed")
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
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
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
  }

  function getDesiredVisibility(state) {
    if (!state || !state.created) {
      return false;
    }

    return isElementArtifactVisible(state.element);
  }

  async function syncBounds(state) {
    if (!state || !state.created || !window.electronAPI?.artifactView?.setBounds) {
      return;
    }

    const bounds = buildBounds(state.element);
    state.bounds = bounds;
    if (boundsEqual(state.lastSentBounds, bounds)) {
      return;
    }

    const payload = await window.electronAPI.artifactView.setBounds(
      state.viewKey,
      bounds,
    );
    state.lastSentBounds = bounds;
    updateStateFromPayload(state, payload);
  }

  function scheduleBoundsSync(state) {
    if (!state || state.boundsRaf !== null) {
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
    if (!state || !state.created || !window.electronAPI?.artifactView?.setVisible) {
      return;
    }

    const visible = getDesiredVisibility(state);
    if (state.lastVisible !== visible) {
      state.lastVisible = visible;
      await window.electronAPI.artifactView.setVisible(state.viewKey, visible);
    }

    if (visible) {
      scheduleBoundsSync(state);
    }
  }

  async function createOrAdopt(state, options = {}) {
    if (!state || !window.electronAPI?.artifactView?.createOrAdoptView) {
      return null;
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
        (
          options.forceLoad ||
          explicitUrl !== currentUrl ||
          explicitUrl !== requestedUrl
        ) &&
        window.electronAPI?.artifactView?.loadUrl
      ) {
        const loadPayload = await window.electronAPI.artifactView.loadUrl(
          state.viewKey,
          explicitUrl,
          {
            forceLoad: Boolean(options.forceLoad),
            bypassCache: Boolean(options.bypassCache),
          },
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
    const lifecycleToken = state.lifecycleToken;

    const viewOptions = {
      viewKey: state.viewKey,
      bounds: buildBounds(state.element),
      visible: isElementArtifactVisible(state.element),
    };
    if (requestedUrl !== undefined) {
      viewOptions.url = requestedUrl;
    }
    if (options.forceLoad) {
      viewOptions.forceLoad = true;
    }
    if (options.bypassCache) {
      viewOptions.bypassCache = true;
    }

    const createPromise = window.electronAPI.artifactView
      .createOrAdoptView(viewOptions)
      .then((payload) => {
        if (lifecycleToken !== state.lifecycleToken) {
          if (window.electronAPI?.artifactView?.destroyView) {
            void window.electronAPI.artifactView.destroyView(state.viewKey).catch(() => {});
          }
          return payload;
        }
        state.created = true;
        updateStateFromPayload(state, payload);
        return payload;
      })
      .finally(() => {
        if (state.createPromise === createPromise) {
          state.createPromise = null;
        }
        scheduleBoundsSync(state);
        void syncVisibility(state);
      });

    state.createPromise = createPromise;
    return createPromise;
  }

  async function loadUrl(state, url, options = {}) {
    state.src = typeof url === "string" ? url : "";
    state.isLoading = Boolean(state.src);
    state.element.setAttribute("src", state.src);

    if (!state.src && !state.created) {
      return "";
    }

    const payload = await createOrAdopt(state, {
      url: state.src || "about:blank",
      forceLoad: Boolean(options.forceLoad),
      bypassCache: Boolean(options.bypassCache),
    });
    updateStateFromPayload(state, payload);
    return payload?.currentUrl || payload?.requestedUrl || state.currentUrl || "";
  }

  function bindElementFacade(state) {
    const { element } = state;

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

    element.loadURL = (url, options = {}) => loadUrl(state, url, options);
    element.getURL = () => state.currentUrl || state.src || "";
    element.getWebContentsId = () => state.webContentsId || 0;
    element.isLoading = () => Boolean(state.isLoading);
    element.stop = () => {};
    element.reload = async () => {
      await createOrAdopt(state);
      state.isLoading = true;
      return window.electronAPI?.artifactView?.reloadView
        ? window.electronAPI.artifactView.reloadView(state.viewKey)
        : null;
    };
    element.attachArtifactView = () => createOrAdopt(state);
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

  function ensureArtifactViewHost(element, options = {}) {
    if (!element) {
      return null;
    }

    let state = hostStateByElement.get(element);
    if (!state) {
      state = {
        element,
        viewKey: options.viewKey || element.dataset.artifactViewKey || "",
        src: options.url || element.getAttribute("src") || "",
        currentUrl: "",
        webContentsId: 0,
        bounds: null,
        created: false,
        createPromise: null,
        lifecycleToken: 0,
        resizeObserver: null,
        mutationObserver: null,
        boundsRaf: null,
        lastVisible: null,
        lastSentBounds: null,
        isLoading: false,
      };
      hostStateByElement.set(element, state);
    } else {
      state.viewKey = options.viewKey || state.viewKey;
      if (options.url !== undefined) {
        state.src = options.url;
      }
    }

    if (!state.viewKey) {
      throw new Error("Artifact host requires a viewKey");
    }

    hostStateByViewKey.set(state.viewKey, state);
    element.dataset.artifactViewHost = "true";
    element.dataset.artifactViewKey = state.viewKey;

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

  function createArtifactViewHostElement(options = {}) {
    const element = document.createElement("div");
    element.className = options.className || "artifact-webview-host";
    if (options.id) {
      element.id = options.id;
    }
    if (options.url) {
      element.setAttribute("src", options.url);
    }
    return ensureArtifactViewHost(element, options);
  }

  function disposeArtifactViewHost(element, options = {}) {
    const state = hostStateByElement.get(element);
    if (!state) {
      return;
    }

    state.lifecycleToken += 1;
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

    hostStateByElement.delete(element);
    if (hostStateByViewKey.get(state.viewKey) === state) {
      hostStateByViewKey.delete(state.viewKey);
    }

    if (state.created && window.electronAPI?.artifactView) {
      if (options.destroyView && window.electronAPI.artifactView.destroyView) {
        void window.electronAPI.artifactView.destroyView(state.viewKey);
      } else if (window.electronAPI.artifactView.setVisible) {
        void window.electronAPI.artifactView.setVisible(state.viewKey, false);
      }
    }
  }

  function handleArtifactViewEvent(payload = {}) {
    const state = hostStateByViewKey.get(payload.viewKey);
    if (!state || !state.element) {
      return;
    }

    updateStateFromPayload(state, payload);

    switch (payload.type) {
      case "did-start-loading":
        state.isLoading = true;
        break;
      case "did-stop-loading":
      case "did-finish-load":
      case "did-fail-load":
      case "render-process-gone":
        state.isLoading = false;
        break;
      default:
        break;
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

  if (window.electronAPI?.artifactView?.onEvent) {
    window.electronAPI.artifactView.onEvent((payload) => {
      handleArtifactViewEvent(payload);
    });
  }

  window.ensureArtifactViewHost = ensureArtifactViewHost;
  window.createArtifactViewHostElement = createArtifactViewHostElement;
  window.disposeArtifactViewHost = disposeArtifactViewHost;
  window.syncArtifactViewHosts = syncAllHosts;
})();
