(() => {
  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get("conversationId");
  const conversationUrl = params.get("url");
  const initialWindowTitle = params.get("title");
  const windowType = params.get("windowType") || "subagent";
  const providedViewKey = params.get("viewKey") || "";

  const OPEN_WEBUI_HOME_URL = "http://localhost:3789";
  const RECONNECT_INTERVAL_MS = 5000;
  const MAX_RECONNECT_ATTEMPTS = 36;
  const WEBVIEW_HEALTH_PROBE_DELAY_MS = 700;
  const MAX_BLANK_RECOVERY_ATTEMPTS = 3;
  const INITIAL_SESSION_LOADING_MIN_MS = 2200;
  const INITIAL_SESSION_SUPPRESSION_REASON = "conversation-initial-loading";
  const WEBVIEW_CONSOLE_LEVEL_MAP = {
    0: "debug",
    1: "info",
    2: "warn",
    3: "error",
  };
  const WEBVIEW_KNOWN_NOISE_PATTERNS = [
    "no token found in localstorage, user-join event not emitted",
    "[tiptap warn]: duplicate extension names found",
    "electron security warning",
  ];
  const WEBVIEW_HEALTH_CHECK_SCRIPT = `(() => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    const trimmedBodyText = bodyText.trim();
    const title = document.title || '';
    const htmlLength = document.documentElement
      ? document.documentElement.innerHTML.length
      : 0;
    const hasAppScript = !!document.querySelector('script[src*="/_app/"]');
    const detachedSubagentState = document
      .querySelector('[data-detached-subagent-state]')
      ?.getAttribute('data-detached-subagent-state') || '';
    return {
      htmlLength,
      hasAppScript,
      title,
      bodyTextLength: trimmedBodyText.length,
      detachedSubagentState,
      sample: bodyText.slice(0, 200)
    };
  })()`;
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
  `;

  if (initialWindowTitle) {
    document.title = initialWindowTitle;
  }

  const detachedWindowDefaultTitle = windowType === "chat" ? "Chat" : "Subagent";
  let detachedWindowTitle = initialWindowTitle || detachedWindowDefaultTitle;

  function syncMacTitlebarSafeArea() {
    if (window.electronAPI?.platform !== "darwin") {
      return;
    }

    document.documentElement.classList.add("platform-darwin");
    let safeAreaPx = 52;

    try {
      const overlay = navigator.windowControlsOverlay;
      if (overlay && typeof overlay.getTitlebarAreaRect === "function") {
        const rect = overlay.getTitlebarAreaRect();
        const height = Number(rect?.height);
        if (Number.isFinite(height) && height > 0) {
          safeAreaPx = Math.ceil(height);
        }
      }
    } catch (error) {
      console.warn(
        "[Conversation Window] Failed to read titlebar safe area:",
        error,
      );
    }

    document.documentElement.style.setProperty(
      "--mac-titlebar-safe-area",
      `${safeAreaPx}px`,
    );
  }

  if (window.electronAPI?.platform === "darwin") {
    syncMacTitlebarSafeArea();
    const overlay = navigator.windowControlsOverlay;
    if (overlay && typeof overlay.addEventListener === "function") {
      overlay.addEventListener("geometrychange", syncMacTitlebarSafeArea);
    }
  }

  const returnToTabBtn = document.getElementById("conversation-return-to-tab-btn");
  const detachedWindowTitleEl = document.getElementById("conversation-window-title-text");
  const chatContainer = document.getElementById("conversation-chat-container");
  const sessionLoadingOverlay = document.getElementById(
    "conversation-session-loading-overlay",
  );

  function applyDetachedWindowTitle(nextTitle, options = {}) {
    const { syncBrowserWindow = false } = options;
    detachedWindowTitle =
      typeof nextTitle === "string" && nextTitle.trim()
        ? nextTitle.trim()
        : detachedWindowDefaultTitle;
    document.title = detachedWindowTitle;

    if (detachedWindowTitleEl) {
      detachedWindowTitleEl.textContent = detachedWindowTitle;
      detachedWindowTitleEl.title = `${detachedWindowTitle} (double-click to rename)`;
    }

    if (syncBrowserWindow && window.electronAPI?.setDetachedConversationWindowTitle) {
      void window.electronAPI.setDetachedConversationWindowTitle(detachedWindowTitle).catch((error) => {
        console.warn("[Conversation Window] Failed to sync detached window title:", error);
      });
    }
  }

  function startDetachedTitleRename() {
    if (!detachedWindowTitleEl || detachedWindowTitleEl.classList.contains("is-editing")) {
      return;
    }

    const currentTitle = detachedWindowTitle || detachedWindowDefaultTitle;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "conversation-window-title-input";
    input.value = currentTitle;
    input.maxLength = 80;

    detachedWindowTitleEl.classList.add("is-editing");
    detachedWindowTitleEl.insertAdjacentElement("afterend", input);
    window.setOwuiInteractionSuppressed?.("detached-title-rename", true);

    let finished = false;
    const finish = (commit = true) => {
      if (finished) {
        return;
      }
      finished = true;
      const nextTitle = commit ? input.value.trim() || currentTitle : currentTitle;
      input.remove();
      detachedWindowTitleEl.classList.remove("is-editing");
      applyDetachedWindowTitle(nextTitle, {
        syncBrowserWindow: nextTitle !== currentTitle,
      });
      window.setOwuiInteractionSuppressed?.("detached-title-rename", false);
    };

    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());

    window.electronAPI?.focusRenderer?.();
    input.focus();
    input.select();
  }

  applyDetachedWindowTitle(detachedWindowTitle);
  if (detachedWindowTitleEl) {
    detachedWindowTitleEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startDetachedTitleRename();
    });
  }

  if (returnToTabBtn && !window.electronAPI?.attachConversationToMain) {
    returnToTabBtn.disabled = true;
    returnToTabBtn.title = "Return to Tab is unavailable";
  }
  let activeWebview = document.getElementById("conversation-webview");
  if (!activeWebview) {
    console.error("[Conversation Window] Webview element missing");
    return;
  }

  const nativeOverlaySuppressionReasons = new Set();
  function syncNativeOverlaySuppression() {
    const suppressed = nativeOverlaySuppressionReasons.size > 0;
    document.body?.classList.toggle("overlay-interaction-suppressed", suppressed);
    window.setOwuiInteractionSuppressed?.("renderer-overlay", suppressed);
    window.syncOwuiHosts?.();
  }

  window.setNativeOverlayInteractionSuppressed = (reason, suppressed) => {
    if (!reason) {
      return;
    }
    if (suppressed) {
      nativeOverlaySuppressionReasons.add(reason);
    } else {
      nativeOverlaySuppressionReasons.delete(reason);
    }
    syncNativeOverlaySuppression();
  };

  if (conversationId) {
    activeWebview.id = `conversation-webview-${conversationId}`;
  }

  const viewKey =
    providedViewKey ||
    (windowType === "chat"
      ? `detached-chat:${conversationId || "main"}`
      : `conversation:${conversationId || "unknown"}`);
  const hostWindowType = viewKey.startsWith("conversation:")
    ? "conversation"
    : windowType;
  function syncDetachedWindowActiveView() {
    if (window.electronAPI?.setActiveViewKey) {
      window.electronAPI.setActiveViewKey(viewKey);
    }
  }
  window.addEventListener("focus", () => {
    syncDetachedWindowActiveView();
    if (window.electronAPI?.owui?.focusView) {
      void window.electronAPI.owui.focusView(viewKey).catch(() => {});
    }
  });
  if (window.ensureOwuiHost) {
    activeWebview = window.ensureOwuiHost(activeWebview, {
      viewKey,
      windowType: hostWindowType,
      conversationId,
    });
  }
  syncDetachedWindowActiveView();
  if (window.electronAPI?.setupFindInPageForwarding) {
    window.electronAPI.setupFindInPageForwarding().catch(() => {});
  }

  let reconnectInterval = null;
  let reconnectAttempts = 0;
  let healthProbeTimer = null;
  let blankRecoveryAttempts = 0;
  let hardRecoveryInProgress = false;
  let initialSessionLoadingStartedAt = 0;
  let initialSessionLoadingVisible = false;
  let initialSessionLoadingCompleted = false;
  let initialSessionLoadingCompletionPromise = null;
  const boundWebviews = new WeakSet();

  function showInitialSessionLoadingOverlay() {
    if (!sessionLoadingOverlay || initialSessionLoadingVisible) {
      return;
    }

    initialSessionLoadingStartedAt = Date.now();
    initialSessionLoadingVisible = true;
    window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, true);
    sessionLoadingOverlay.classList.add("visible");
  }

  async function completeInitialSessionLoading() {
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
      const remainingMs = Math.max(0, INITIAL_SESSION_LOADING_MIN_MS - elapsedMs);
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      initialSessionLoadingCompleted = true;
      initialSessionLoadingVisible = false;
      sessionLoadingOverlay.classList.remove("visible");
      window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, false);
    })().finally(() => {
      initialSessionLoadingCompletionPromise = null;
    });

    return initialSessionLoadingCompletionPromise;
  }

  function resolveConversationUrl() {
    const candidates = [];
    try {
      if (typeof activeWebview.getURL === "function") {
        candidates.push(activeWebview.getURL());
      }
    } catch (error) {
      // Ignore getURL failures and continue.
    }
    if (activeWebview.getAttribute) {
      candidates.push(activeWebview.getAttribute("src"));
    }
    candidates.push(buildConversationTargetUrl());
    candidates.push(conversationUrl);
    candidates.push(OPEN_WEBUI_HOME_URL);

    const valid = candidates.find((candidate) => {
      return Boolean(candidate && candidate !== "about:blank");
    });
    return valid || OPEN_WEBUI_HOME_URL;
  }

  function buildAttachTargetUrl() {
    const rawUrl =
      resolveConversationUrl() ||
      buildConversationTargetUrl() ||
      conversationUrl ||
      OPEN_WEBUI_HOME_URL;

    try {
      const normalized = new URL(rawUrl, window.location.origin);
      if (windowType === "subagent") {
        normalized.searchParams.set("subagent-view", "1");
      }
      normalized.searchParams.delete("portico-target-message");
      normalized.searchParams.delete("detached-window");
      return normalized.toString();
    } catch (_error) {
      return rawUrl;
    }
  }

  function normalizeComparableConversationUrl(rawUrl) {
    if (!rawUrl) {
      return "";
    }

    try {
      const normalized = new URL(rawUrl, window.location.origin);
      normalized.searchParams.delete("portico-target-message");
      normalized.searchParams.delete("detached-window");
      normalized.hash = "";
      const search = normalized.searchParams.toString();
      return `${normalized.origin}${normalized.pathname}${search ? `?${search}` : ""}`;
    } catch (_error) {
      return String(rawUrl || "").trim();
    }
  }

  function areConversationUrlsEquivalent(a, b) {
    if (!a || !b) {
      return false;
    }

    return normalizeComparableConversationUrl(a) === normalizeComparableConversationUrl(b);
  }

  function buildConversationAttachPayload() {
    return {
      conversationId,
      url: buildAttachTargetUrl(),
      title:
        detachedWindowTitle ||
        document.title ||
        (windowType === "chat" ? "Chat" : "Subagent"),
      windowType,
      viewKey,
    };
  }

  async function returnToMainTab() {
    if (!window.electronAPI?.attachConversationToMain) {
      return;
    }

    if (returnToTabBtn) {
      returnToTabBtn.disabled = true;
      returnToTabBtn.classList.add("is-busy");
    }

    try {
      const result = await window.electronAPI.attachConversationToMain(
        buildConversationAttachPayload(),
      );

      if (!result?.success) {
        throw new Error(result?.error || "Failed to return detached window to tab");
      }
    } catch (error) {
      console.error("[Conversation Window] Failed to return to tab:", error);
      if (returnToTabBtn) {
        returnToTabBtn.disabled = false;
        returnToTabBtn.classList.remove("is-busy");
      }
    }
  }

  async function attachExistingOwuiView() {
    if (typeof activeWebview?.attachOwuiView !== "function") {
      return null;
    }

    try {
      const attachedState = await activeWebview.attachOwuiView();
      syncDetachedWindowActiveView();
      return attachedState;
    } catch (error) {
      console.warn("[Conversation Window] Failed to attach OWUI view:", error);
      return null;
    }
  }

  function shouldLoadConversationUrl(targetUrl, attachedState = null) {
    const candidates = [
      attachedState?.currentUrl,
      attachedState?.requestedUrl,
    ];

    try {
      if (typeof activeWebview?.getURL === "function") {
        candidates.push(activeWebview.getURL());
      }
    } catch (error) {
      // Ignore getURL failures and continue with other candidates.
    }

    if (activeWebview?.getAttribute) {
      candidates.push(activeWebview.getAttribute("src"));
    }

    const currentUrl = candidates.find((candidate) => {
      return Boolean(candidate && candidate !== "about:blank");
    });

    return !currentUrl || !areConversationUrlsEquivalent(currentUrl, targetUrl);
  }

  async function ensureWebviewPreload(targetWebview) {
    return targetWebview;
  }

  function buildConversationTargetUrl() {
    if (!conversationUrl) {
      return conversationUrl;
    }

    try {
      const url = new URL(conversationUrl, window.location.origin);
      if (windowType === "subagent") {
        url.searchParams.set("subagent-view", "1");
        url.searchParams.set("detached-window", "subagent");
      }
      return url.toString();
    } catch (error) {
      return conversationUrl;
    }
  }

  function syncThemeToWebview() {
    const currentTheme =
      document.documentElement.getAttribute("data-theme") ||
      localStorage.getItem("theme") ||
      "dark";
    if (window.syncThemeToAllWebviews) {
      window.syncThemeToAllWebviews(currentTheme);
    }
  }

  function ensureReconnectOverlay() {
    let overlay = document.getElementById("conversation-reconnect-overlay");
    if (overlay || !chatContainer) {
      return overlay;
    }

    chatContainer.style.position = "relative";
    overlay = document.createElement("div");
    overlay.id = "conversation-reconnect-overlay";
    overlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(20, 20, 20, 0.86);
      color: #e5e7eb;
      font-size: 14px;
      z-index: 1000;
      text-align: center;
      padding: 24px;
    `;
    overlay.innerHTML = `
      <div>
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">Reconnecting conversation...</div>
        <div id="conversation-reconnect-status" style="opacity: 0.86;">Waiting for Open WebUI</div>
      </div>
    `;
    chatContainer.appendChild(overlay);
    return overlay;
  }

  function showReconnectOverlay(message, options = {}) {
    const overlay = ensureReconnectOverlay();
    if (!overlay) return;
    const suppressOwuiHost = options.suppressOwuiHost !== false;
    if (suppressOwuiHost) {
      activeWebview?.classList.add("owui-suppressed");
    } else {
      activeWebview?.classList.remove("owui-suppressed");
    }
    window.syncOwuiHosts?.();
    const statusEl = document.getElementById("conversation-reconnect-status");
    if (statusEl) {
      statusEl.textContent = message;
    }
    overlay.style.display = "flex";
  }

  function hideReconnectOverlay() {
    const overlay = document.getElementById("conversation-reconnect-overlay");
    activeWebview?.classList.remove("owui-suppressed");
    window.syncOwuiHosts?.();
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  async function checkOpenWebuiReady() {
    if (window.electronAPI?.checkOpenWebuiReady) {
      const result = await window.electronAPI.checkOpenWebuiReady();
      return result?.ready === true;
    }

    try {
      await fetch(resolveConversationUrl(), { method: "HEAD", mode: "no-cors" });
      return true;
    } catch (error) {
      return false;
    }
  }

  function stopReconnect() {
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
    reconnectAttempts = 0;
    hideReconnectOverlay();
  }

  function reloadActiveWebview() {
    const targetWebview = activeWebview;
    if (!targetWebview) {
      return;
    }
    ensureWebviewListenersAttached(targetWebview);
    const url = resolveConversationUrl();
    try {
      if (typeof targetWebview.loadURL === "function") {
        targetWebview.loadURL(url);
      } else {
        targetWebview.src = url;
      }
    } catch (error) {
      console.warn("[Conversation Window] Failed to reload webview:", error);
    }
  }

  function startReconnect(reason = "unknown") {
    if (reconnectInterval) {
      return;
    }

    reconnectAttempts = 0;
    showReconnectOverlay("Waiting for Open WebUI...");
    console.warn(`[Conversation Window] Starting reconnect loop (${reason})`);

    reconnectInterval = setInterval(async () => {
      reconnectAttempts += 1;
      showReconnectOverlay(
        `Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} to reconnect`,
      );

      try {
        const ready = await checkOpenWebuiReady();
        if (!ready) {
          throw new Error("Open WebUI not ready");
        }

        stopReconnect();
        reloadActiveWebview();
        scheduleWebviewHealthProbe(1200);
        return;
      } catch (error) {
        // Keep retrying.
      }

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        stopReconnect();
        showReconnectOverlay("Open WebUI is still unavailable. Please try again.");
      }
    }, RECONNECT_INTERVAL_MS);
  }

  function isWebviewSnapshotHealthy(snapshot) {
    const titleLower = (snapshot?.title || "").toLowerCase();
    const sampleLower = (snapshot?.sample || "").toLowerCase();
    const bodyTextLength = Number(snapshot?.bodyTextLength || 0);
    const detachedSubagentState = String(
      snapshot?.detachedSubagentState || "",
    ).toLowerCase();
    const hasDetachedSubagentState = [
      "loading",
      "ready",
      "pending",
      "error",
    ].includes(detachedSubagentState);
    const hasVisibleText = bodyTextLength > 0 || sampleLower.trim().length > 0;
    const looksLikeError =
      titleLower.includes("internal error") ||
      titleLower.startsWith("500") ||
      sampleLower.includes("internal error");

    if (looksLikeError) {
      return false;
    }
    if (windowType === "subagent") {
      return hasDetachedSubagentState && hasVisibleText;
    }
    return hasVisibleText;
  }

  async function executeHealthProbe(targetWebview) {
    try {
      const snapshot = await targetWebview.executeJavaScript(WEBVIEW_HEALTH_CHECK_SCRIPT);
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function rebuildWebview(reason) {
    if (hardRecoveryInProgress || !activeWebview || !activeWebview.parentNode) {
      return;
    }

    hardRecoveryInProgress = true;
    try {
      if (
        activeWebview.dataset?.owuiHost === "true" &&
        typeof activeWebview.recreateOwuiView === "function"
      ) {
        await activeWebview.recreateOwuiView(resolveConversationUrl());
        scheduleWebviewHealthProbe(1200);
        console.warn(
          `[Conversation Window] Hard OWUI host recovery completed (${reason})`,
        );
        return;
      }
      throw new Error(
        "Detached conversation window lost its OWUI host recovery hooks",
      );
    } catch (error) {
      console.error("[Conversation Window] Hard webview recovery failed:", error);
    } finally {
      hardRecoveryInProgress = false;
    }
  }

  function scheduleWebviewHealthProbe(delayMs = WEBVIEW_HEALTH_PROBE_DELAY_MS) {
    if (healthProbeTimer) {
      clearTimeout(healthProbeTimer);
      healthProbeTimer = null;
    }

    healthProbeTimer = setTimeout(async () => {
      const targetWebview = activeWebview;
      if (!targetWebview) {
        return;
      }

      const probeResult = await executeHealthProbe(targetWebview);
      if (!probeResult.ok || !isWebviewSnapshotHealthy(probeResult.snapshot)) {
        blankRecoveryAttempts += 1;
        if (blankRecoveryAttempts <= MAX_BLANK_RECOVERY_ATTEMPTS) {
          console.warn(
            `[Conversation Window] Webview probe unhealthy (${blankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS}), reloading`,
          );
          startReconnect("unhealthy-probe");
          reloadActiveWebview();
        } else {
          await rebuildWebview("unhealthy-probe");
          startReconnect("hard-recovery");
        }
        return;
      }

      blankRecoveryAttempts = 0;
      stopReconnect();
      void completeInitialSessionLoading();
    }, delayMs);
  }

  function getWebviewConsoleLevelName(eventLevel) {
    const level = Number(eventLevel);
    if (Number.isFinite(level) && WEBVIEW_CONSOLE_LEVEL_MAP[level]) {
      return WEBVIEW_CONSOLE_LEVEL_MAP[level];
    }
    return "info";
  }

  function shouldEchoWebviewConsoleMessage(event) {
    const message = String(event?.message || "").toLowerCase();
    if (WEBVIEW_KNOWN_NOISE_PATTERNS.some((pattern) => message.includes(pattern))) {
      return false;
    }

    const level = Number(event?.level ?? 0);
    if (level >= 2) {
      return true;
    }

    return (
      message.includes("error") ||
      message.includes("exception") ||
      message.includes("uncaught") ||
      message.includes("failed")
    );
  }

  function forwardWebviewConsoleMessage(event) {
    if (!window.electronAPI?.logToMain) {
      return;
    }

    const level = Number(event?.level ?? 1);
    window.electronAPI.logToMain(
      getWebviewConsoleLevelName(level),
      `[DETACHED CONVERSATION WEBVIEW] ${String(event?.message ?? "")}`,
      {
        webviewConsole: true,
        detachedConversationWindow: true,
        conversationId: conversationId || null,
        level,
        sourceId: event?.sourceId || null,
        line: Number.isFinite(Number(event?.line)) ? Number(event.line) : null,
      },
    );
  }

  function ensureWebviewListenersAttached(targetWebview) {
    if (!targetWebview || boundWebviews.has(targetWebview)) {
      return;
    }
    bindWebviewListeners(targetWebview);
  }

  function bindWebviewListeners(targetWebview) {
    if (!targetWebview || boundWebviews.has(targetWebview)) {
      return;
    }
    boundWebviews.add(targetWebview);

    targetWebview.addEventListener("dom-ready", () => {
      if (targetWebview.dataset?.owuiHost !== "true") {
        try {
          const webviewId = targetWebview.getWebContentsId();
          if (window.electronAPI?.setupWebviewLinkHandler) {
            window.electronAPI.setupWebviewLinkHandler(webviewId);
          }
        } catch (error) {
          console.error("[Conversation Window] Link handler setup failed:", error);
        }
      }

      targetWebview.insertCSS(CHAT_CURSOR_FIX_CSS);
      syncThemeToWebview();
      scheduleWebviewHealthProbe();
    });

    targetWebview.addEventListener("new-window", (e) => {
      e.preventDefault();
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(e.url);
      }
    });

    targetWebview.addEventListener("did-fail-load", (event) => {
      // ERR_ABORTED during in-flight navigation is expected and not actionable.
      if (event?.errorCode === -3) {
        return;
      }
      console.error("[Conversation Window] Webview failed to load:", event);
      startReconnect(`did-fail-load:${event?.errorCode ?? "unknown"}`);
      scheduleWebviewHealthProbe(300);
    });

    targetWebview.addEventListener("did-finish-load", () => {
      stopReconnect();
      scheduleWebviewHealthProbe();
    });

    targetWebview.addEventListener("render-process-gone", (event) => {
      console.error("[Conversation Window] Render process gone:", event);
      startReconnect("render-process-gone");
      void rebuildWebview("render-process-gone");
    });

    targetWebview.addEventListener("console-message", (event) => {
      forwardWebviewConsoleMessage(event);

      if (!shouldEchoWebviewConsoleMessage(event)) {
        return;
      }

      const level = Number(event?.level ?? 0);
      if (level >= 2) {
        console.error("[CONVERSATION WEBVIEW]", event.message);
      } else {
        console.warn("[CONVERSATION WEBVIEW]", event.message);
      }
    });
  }

  if (window.electronAPI?.onForceWebviewRecovery) {
    window.electronAPI.onForceWebviewRecovery((payload = {}) => {
      console.warn("[Conversation Window] Force recovery signal received:", payload);
      void rebuildWebview(payload.reason || "force-webview-recovery");
    });
  }

  if (returnToTabBtn) {
    returnToTabBtn.addEventListener("click", () => {
      void returnToMainTab();
    });
  }

  if (!conversationUrl) {
    console.error("[Conversation Window] Missing conversation url");
    return;
  }

  showInitialSessionLoadingOverlay();
  ensureWebviewListenersAttached(activeWebview);

  window.addEventListener("beforeunload", () => {
    window.setOwuiInteractionSuppressed?.(INITIAL_SESSION_SUPPRESSION_REASON, false);
    window.disposeOwuiHost?.(activeWebview, { destroyView: false });
  });

  void ensureWebviewPreload(activeWebview).finally(async () => {
    syncDetachedWindowActiveView();
    showReconnectOverlay("Starting Open WebUI...", {
      suppressOwuiHost: false,
    });
    const attachedState = await attachExistingOwuiView();
    const targetUrl = buildConversationTargetUrl();

    if (!shouldLoadConversationUrl(targetUrl, attachedState)) {
      hideReconnectOverlay();
      scheduleWebviewHealthProbe(1200);
      return;
    }

    const waitForReady = async () => {
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
        try {
          const ready = await checkOpenWebuiReady();
          if (ready) {
            hideReconnectOverlay();
            activeWebview.src = targetUrl;
            scheduleWebviewHealthProbe(1200);
            return;
          }
        } catch (e) {
          // keep trying
        }
        showReconnectOverlay(
          `Starting Open WebUI... (${i + 1}/${MAX_RECONNECT_ATTEMPTS})`,
          {
            suppressOwuiHost: false,
          },
        );
        await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));
      }
      // Fallback: load anyway, let existing reconnect logic handle it
      activeWebview.src = targetUrl;
      scheduleWebviewHealthProbe(1200);
    };

    waitForReady();
  });
})();
