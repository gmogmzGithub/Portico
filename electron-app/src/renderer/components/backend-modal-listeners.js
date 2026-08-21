(function () {
  let backendModalListenersRegistered = false;
  let pendingBackendModalSequence = 0;
  let activeBackendModalLaunch = null;
  const pendingBackendModalsByTabId = new Map();
  const pendingBackendModalsByChatId = new Map();
  // One record per backend modal kind — the single place a new kind is
  // registered. Everything else (the chat-keyed set, the native-input kind
  // mapping, the notification type, and the listener wiring) is derived from
  // this, so a kind can no longer be half-registered and fail silently.
  // Runners are hoisted function declarations defined further down.
  const BACKEND_MODAL_KINDS = Object.freeze([
    {
      kind: "oauth",
      event: "onOAuthFlowRequested",
      notificationType: "mcp-oauth",
      runner: runBackendOAuthFlow,
    },
    {
      kind: "user-question",
      event: "onUserQuestionRequested",
      notificationType: "user-question",
      // The only kind whose notification carries a count.
      itemCount: (payload) =>
        Array.isArray(payload?.questions) ? payload.questions.length : undefined,
    },
    {
      kind: "sensitive-info",
      event: "onSensitiveInfoRequested",
      nativeInputKind: "sensitive_info",
      notificationType: "sensitive-info",
      chatKeyed: true,
      runner: runSensitiveInfoFlow,
    },
    {
      kind: "chat-workspace-consent",
      event: "onChatWorkspaceConsentRequested",
      nativeInputKind: "chat_workspace_consent",
      notificationType: "workspace-consent",
      chatKeyed: true,
      runner: runChatWorkspaceConsentFlow,
    },
    {
      kind: "ai-marketplace-publish",
      event: "onAiMarketplacePublishConfirmRequested",
      nativeInputKind: "marketplace_publish",
      // Publish confirmation is modal-only: no chat notification.
      runner: runAiMarketplacePublishConfirmFlow,
    },
    {
      kind: "guided-setup",
      event: "onGuidedSetupRequested",
      notificationType: "mcp-configuration",
      runner: runGuidedSetup,
    },
  ]);

  const CHAT_KEYED_NATIVE_INPUT_KINDS = new Set(
    BACKEND_MODAL_KINDS.filter((spec) => spec.chatKeyed).map((spec) => spec.kind),
  );
  const BACKEND_KIND_BY_NATIVE_INPUT_KIND = Object.freeze(
    Object.fromEntries(
      BACKEND_MODAL_KINDS.filter((spec) => spec.nativeInputKind).map((spec) => [
        spec.nativeInputKind,
        spec.kind,
      ]),
    ),
  );
  const BACKEND_MODAL_KIND_SPECS = Object.freeze(
    Object.fromEntries(BACKEND_MODAL_KINDS.map((spec) => [spec.kind, spec])),
  );

  function logPrefix(options = {}) {
    return options.label || "Backend Modal";
  }

  function normalizeModalString(value) {
    const normalized = String(value || "").trim();
    return normalized || null;
  }

  function extractChatIdFromOwuiUrl(value) {
    const raw = normalizeModalString(value);
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

  function ensureAppState() {
    if (!window.appState || typeof window.appState !== "object") {
      window.appState = {
        servers: [],
        toggles: {},
        activeTab: "chat",
        conversationTabs: {},
      };
    }
    if (!Array.isArray(window.appState.servers)) {
      window.appState.servers = [];
    }
    if (!window.appState.toggles || typeof window.appState.toggles !== "object") {
      window.appState.toggles = {};
    }
    return window.appState;
  }

  function hasMainTabShell() {
    return Boolean(
      window.tabBar &&
        window.appState?.tabOrder &&
        document.getElementById("tab-strip"),
    );
  }

  function getFullTabId(tabId) {
    return tabId === "chat" || tabId === "control"
      ? tabId
      : `conversation-${tabId}`;
  }

  function getActiveModalTabId() {
    const activeTab = normalizeModalString(window.appState?.activeTab) || "chat";
    return activeTab.startsWith("conversation-")
      ? activeTab.slice("conversation-".length)
      : activeTab;
  }

  function getElementOwuiUrl(element) {
    if (!element) {
      return null;
    }

    try {
      if (typeof element.getCommittedURL === "function") {
        return normalizeModalString(element.getCommittedURL());
      }
      if (typeof element.getURL === "function") {
        return normalizeModalString(element.getURL());
      }
    } catch (_) {}

    return normalizeModalString(
      element.getAttribute?.("src") || element.src || "",
    );
  }

  function tabMatchesChatId(tabId, chatId) {
    const normalizedTabId = normalizeModalString(tabId);
    const normalizedChatId = normalizeModalString(chatId);
    if (!normalizedTabId || !normalizedChatId) {
      return false;
    }

    const hostElement =
      normalizedTabId === "chat"
        ? document.getElementById("chat-webview")
        : document.getElementById(
            `conversation-webview-${normalizedTabId}`,
          );
    if (hostElement) {
      return (
        extractChatIdFromOwuiUrl(getElementOwuiUrl(hostElement)) ===
        normalizedChatId
      );
    }

    if (normalizedTabId === normalizedChatId) {
      return true;
    }

    const state = ensureAppState();
    const tabMeta = state.tabMeta?.[normalizedTabId] || {};
    if (normalizeModalString(tabMeta.currentChatId) === normalizedChatId) {
      return true;
    }

    const conversation = state.conversationTabs?.[normalizedTabId] || {};
    if (tabMeta.conversationId === normalizedChatId) {
      return true;
    }
    return [conversation.url, tabMeta.url].some(
      (candidate) => extractChatIdFromOwuiUrl(candidate) === normalizedChatId,
    );
  }

  function resolveTabIdFromModalTarget(modalTarget = {}) {
    modalTarget = modalTarget || {};
    const state = ensureAppState();
    const conversationId = normalizeModalString(modalTarget.conversationId);
    if (
      conversationId &&
      (conversationId === "chat" ||
        state.tabMeta?.[conversationId] ||
        state.conversationTabs?.[conversationId])
    ) {
      return conversationId;
    }

    const viewKey = normalizeModalString(modalTarget.viewKey);
    if (viewKey === "main" || modalTarget.windowType === "main") {
      return "chat";
    }
    if (viewKey?.startsWith("conversation:")) {
      const tabId = normalizeModalString(viewKey.slice("conversation:".length));
      if (tabId && (state.tabMeta?.[tabId] || state.conversationTabs?.[tabId])) {
        return tabId;
      }
    }

    return null;
  }

  function resolveTabIdForModalPayload(payload = {}) {
    const chatId = normalizeModalString(payload.chat_id);
    const targetTabId = resolveTabIdFromModalTarget(payload.__modalTarget);
    if (targetTabId && (!chatId || tabMatchesChatId(targetTabId, chatId))) {
      return targetTabId;
    }

    if (!chatId) {
      return null;
    }

    const activeTabId = getActiveModalTabId();
    if (tabMatchesChatId(activeTabId, chatId)) {
      return activeTabId;
    }

    const state = ensureAppState();
    for (const tabId of Object.keys(state.conversationTabs || {})) {
      if (tabMatchesChatId(tabId, chatId)) {
        return tabId;
      }
    }

    for (const tabId of Object.keys(state.tabMeta || {})) {
      if (tabId !== "control" && tabMatchesChatId(tabId, chatId)) {
        return tabId;
      }
    }

    if (tabMatchesChatId("chat", chatId)) {
      return "chat";
    }

    return null;
  }

  function getBackendNotificationTitleForTab(tabId) {
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedTabId || normalizedTabId === "chat" || normalizedTabId === "control") {
      return null;
    }
    const state = ensureAppState();
    const meta = state.tabMeta?.[normalizedTabId] || {};
    const conversation = state.conversationTabs?.[normalizedTabId] || {};
    for (const candidate of [
      meta.customTitle,
      meta.autoTitle,
      meta.title,
      conversation.title,
    ]) {
      const title = normalizeModalString(candidate);
      if (title) {
        return title;
      }
    }
    return null;
  }

  function buildBackendNotificationContextScript(chatId) {
    return `(() => {
      const CHAT_ID = ${JSON.stringify(chatId)};
      const normalizeValue = (value) => {
        const normalized = String(value ?? "").trim();
        return normalized && normalized !== "null" && normalized !== "undefined"
          ? normalized
          : "";
      };
      const fetchJson = async (url, headers) => {
        try {
          const response = await fetch(url, {
            method: "GET",
            headers,
            credentials: "include",
          });
          if (!response.ok) {
            return null;
          }
          const body = await response.json();
          return body && typeof body === "object" && body.data && typeof body.data === "object"
            ? body.data
            : body;
        } catch (_) {
          return null;
        }
      };
      const resolveLatestModelId = (chatContent) => {
        const history = chatContent?.history ?? {};
        const messages = history?.messages ?? {};
        let messageId = normalizeValue(history?.currentId);
        const visited = new Set();
        while (messageId && messages?.[messageId] && !visited.has(messageId)) {
          visited.add(messageId);
          const message = messages[messageId];
          if (message?.role === "assistant") {
            const modelId = normalizeValue(message?.model);
            if (modelId) {
              return modelId;
            }
          }
          messageId = normalizeValue(message?.parentId);
        }
        const configuredModels = Array.isArray(chatContent?.models)
          ? chatContent.models
          : [chatContent?.models];
        return configuredModels.map(normalizeValue).find(Boolean) || normalizeValue(chatContent?.model);
      };
      const buildIdentity = (modelId, model, baseModelId, baseModel) => {
        if (!modelId) {
          return null;
        }
        const identity = { id: modelId };
        const name = normalizeValue(model?.name);
        const ownedBy = normalizeValue(model?.owned_by);
        const baseName = normalizeValue(baseModel?.name);
        const baseOwnedBy = normalizeValue(baseModel?.owned_by);
        if (name) identity.name = name;
        if (ownedBy) identity.ownedBy = ownedBy;
        if (baseModelId) identity.baseModelId = baseModelId;
        if (baseName) identity.baseModelName = baseName;
        if (baseOwnedBy) identity.baseModelOwnedBy = baseOwnedBy;
        return identity;
      };

      return (async () => {
        const token = window.localStorage?.getItem("token") || window.localStorage?.token;
        if (!token) {
          return { success: false, error: "missing-token" };
        }
        const headers = { Authorization: \`Bearer \${token}\` };
        const chatPayload = await fetchJson(
          \`/api/v1/chats/\${encodeURIComponent(CHAT_ID)}\`,
          headers,
        );
        if (!chatPayload) {
          return { success: false, error: "chat-fetch-failed" };
        }
        const chatContent =
          chatPayload?.chat && typeof chatPayload.chat === "object"
            ? chatPayload.chat
            : chatPayload;
        const chatTitle =
          normalizeValue(chatPayload?.title) ||
          normalizeValue(chatContent?.title) ||
          "New Chat";
        const modelId = resolveLatestModelId(chatContent);
        if (!modelId) {
          return { success: true, chatTitle, modelIdentity: null };
        }

        const modelUrl = new URL("/api/v1/models/model", window.location.origin);
        modelUrl.searchParams.set("id", modelId);
        const model = await fetchJson(modelUrl.toString(), headers);
        const baseModelId = normalizeValue(
          model?.base_model_id ??
          model?.baseModelId ??
          model?.info?.base_model_id ??
          model?.info?.baseModelId,
        );
        let baseModel = null;
        if (baseModelId) {
          const baseModelUrl = new URL("/api/v1/models/model", window.location.origin);
          baseModelUrl.searchParams.set("id", baseModelId);
          baseModel = await fetchJson(baseModelUrl.toString(), headers);
        }
        return {
          success: true,
          chatTitle,
          modelIdentity: buildIdentity(modelId, model, baseModelId, baseModel),
        };
      })();
    })()`;
  }

  async function getBackendNotificationViewCandidates(payload = {}) {
    const candidates = [];
    const pushCandidate = (value) => {
      const normalized = normalizeModalString(value);
      if (normalized && !candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    pushCandidate(payload?.__modalTarget?.viewKey);
    const tabId = resolveTabIdForModalPayload(payload);
    if (tabId === "chat") {
      pushCandidate("main");
    } else if (tabId) {
      pushCandidate(`conversation:${tabId}`);
    }
    const activeTabId = getActiveModalTabId();
    if (activeTabId === "chat") {
      pushCandidate("main");
    } else if (activeTabId) {
      pushCandidate(`conversation:${activeTabId}`);
    }
    pushCandidate("main");
    Object.keys(ensureAppState().conversationTabs || {}).forEach((conversationId) => {
      pushCandidate(`conversation:${conversationId}`);
    });

    try {
      const views = await window.electronAPI?.owui?.listViews?.();
      for (const view of Array.isArray(views) ? views : []) {
        pushCandidate(view?.viewKey);
      }
    } catch (error) {
      console.warn(
        "[Chat Notifications] Failed to enumerate OWUI views:",
        error?.message || error,
      );
    }
    return candidates;
  }

  async function resolveBackendNotificationContext(payload = {}) {
    const chatId = normalizeModalString(payload?.chat_id);
    const tabId = resolveTabIdForModalPayload(payload);
    const visibleChatTitle = getBackendNotificationTitleForTab(tabId);
    const fallback = {
      chatTitle: visibleChatTitle || "New Chat",
      modelIdentity: null,
    };
    if (!chatId || !window.electronAPI?.owui?.executeJavaScript) {
      return fallback;
    }

    const script = buildBackendNotificationContextScript(chatId);
    const candidates = await getBackendNotificationViewCandidates(payload);
    for (const viewKey of candidates) {
      try {
        const context = await window.electronAPI.owui.executeJavaScript(viewKey, script);
        if (context?.success) {
          const persistedChatTitle = normalizeModalString(context.chatTitle);
          return {
            chatTitle:
              visibleChatTitle && visibleChatTitle !== "New Chat"
                ? visibleChatTitle
                : persistedChatTitle || fallback.chatTitle,
            modelIdentity:
              context.modelIdentity && typeof context.modelIdentity === "object"
                ? context.modelIdentity
                : null,
          };
        }
      } catch (error) {
        console.warn(
          `[Chat Notifications] Failed to resolve chat context from ${viewKey}:`,
          error?.message || error,
        );
      }
    }
    return fallback;
  }

  async function resolveBackendNotificationServerDisplayName(payload = {}) {
    const serverId = normalizeModalString(payload?.server_id);
    if (!serverId) {
      return null;
    }
    try {
      await ensureServersLoaded("Chat Notifications");
    } catch (_) {}
    const server = findServerForModal(serverId);
    return (
      normalizeModalString(server?.display_name) ||
      normalizeModalString(server?.name) ||
      serverId
    );
  }

  async function notifyBackendModalAttention(kind, payload = {}) {
    const spec = BACKEND_MODAL_KIND_SPECS[kind];
    const type = spec?.notificationType;
    const chatId = normalizeModalString(payload?.chat_id);
    const notify = window.electronAPI?.notifyChatStatus;
    if (!type || !chatId || typeof notify !== "function") {
      return;
    }

    try {
      const [context, serverDisplayName] = await Promise.all([
        resolveBackendNotificationContext(payload),
        resolveBackendNotificationServerDisplayName(payload),
      ]);
      const flowId = normalizeModalString(payload?.flow_id);
      const serverId = normalizeModalString(payload?.server_id);
      await notify({
        type,
        chatId,
        chatTitle: context.chatTitle,
        modelIdentity: context.modelIdentity,
        itemCount: spec.itemCount ? spec.itemCount(payload) : undefined,
        serverId,
        serverDisplayName,
        forceAuth: payload?.force_auth === true,
        configurationReason: normalizeModalString(payload?.reason),
        notificationKey: flowId
          ? `${kind}:${flowId}`
          : `${kind}:${chatId}:${serverId || "request"}`,
      });
    } catch (error) {
      console.warn(
        `[Chat Notifications] Failed to show ${kind} notification:`,
        error?.message || error,
      );
    }
  }

  function setTabAttentionRequired(tabId, required, kind = null, payload = {}) {
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedTabId) {
      return;
    }

    if (typeof window.setChatTabAttentionRequired === "function") {
      window.setChatTabAttentionRequired(normalizedTabId, required === true, {
        kind,
        chatId: normalizeModalString(payload?.chat_id),
        notificationKey:
          normalizeModalString(payload?.flow_id) && kind
            ? `${kind}:${normalizeModalString(payload.flow_id)}`
            : "",
      });
      return;
    }

    const state = ensureAppState();
    if (state.tabMeta?.[normalizedTabId]) {
      state.tabMeta[normalizedTabId].attentionRequired = required === true;
    }
    window.tabBar?.setAttentionRequired?.(normalizedTabId, required === true);
  }

  function getPendingModalQueue(tabId, create = false) {
    let tabQueue = pendingBackendModalsByTabId.get(tabId);
    if (!tabQueue && create) {
      tabQueue = [];
      pendingBackendModalsByTabId.set(tabId, tabQueue);
    }
    return tabQueue || null;
  }

  function getPendingChatModalQueue(chatId, create = false) {
    let chatQueue = pendingBackendModalsByChatId.get(chatId);
    if (!chatQueue && create) {
      chatQueue = [];
      pendingBackendModalsByChatId.set(chatId, chatQueue);
    }
    return chatQueue || null;
  }

  function createPendingBackendModalEntry(kind, payload, options, runner) {
    return {
      kind,
      payload,
      options,
      runner,
      sequence: ++pendingBackendModalSequence,
    };
  }

  function enqueueBackendModalForTab(tabId, kind, payload, options, runner) {
    const tabQueue = getPendingModalQueue(tabId, true);
    tabQueue.push(createPendingBackendModalEntry(kind, payload, options, runner));
    setTabAttentionRequired(tabId, true, kind, payload);
  }

  function enqueueBackendModalForChat(chatId, kind, payload, options, runner) {
    const chatQueue = getPendingChatModalQueue(chatId, true);
    chatQueue.push(createPendingBackendModalEntry(kind, payload, options, runner));
  }

  function hasOutstandingAttentionForTab(tabId) {
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedTabId) {
      return false;
    }
    const queued = Boolean(getPendingModalQueue(normalizedTabId)?.length);
    const active =
      activeBackendModalLaunch?.tabId === normalizedTabId &&
      activeBackendModalLaunch?.terminalReceived !== true;
    return queued || active;
  }

  function launchNextBackendModalForTab(tabId) {
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedTabId || activeBackendModalLaunch) {
      return false;
    }

    if (window.appState?.activeTab !== getFullTabId(normalizedTabId)) {
      return false;
    }

    const tabQueue = getPendingModalQueue(normalizedTabId);
    if (!tabQueue || tabQueue.length === 0) {
      pendingBackendModalsByTabId.delete(normalizedTabId);
      setTabAttentionRequired(normalizedTabId, false);
      return false;
    }

    tabQueue.sort((a, b) => a.sequence - b.sequence);
    while (tabQueue.length > 0) {
      const candidate = tabQueue[0];
      const chatId = normalizeModalString(candidate.payload?.chat_id);
      if (
        !chatId ||
        !CHAT_KEYED_NATIVE_INPUT_KINDS.has(candidate.kind) ||
        tabMatchesChatId(normalizedTabId, chatId)
      ) {
        break;
      }
      getPendingChatModalQueue(chatId, true).push(tabQueue.shift());
    }
    if (tabQueue.length === 0) {
      pendingBackendModalsByTabId.delete(normalizedTabId);
      setTabAttentionRequired(normalizedTabId, false);
      return false;
    }
    const entry = tabQueue.shift();
    if (tabQueue.length === 0) {
      pendingBackendModalsByTabId.delete(normalizedTabId);
    }
    // Keep attention asserted for the full modal lifetime. Popping the final
    // queued entry means it is now visible, not that the user has handled it.
    setTabAttentionRequired(normalizedTabId, true);

    activeBackendModalLaunch = {
      tabId: normalizedTabId,
      kind: entry.kind,
      flowId: normalizeModalString(entry.payload?.flow_id),
      sequence: entry.sequence,
      terminalReceived: false,
    };

    Promise.resolve()
      .then(() => entry.runner(entry.payload, entry.options))
      .catch((error) => {
        console.error(
          `[${logPrefix(entry.options)}] Failed to launch ${entry.kind} modal for ${normalizedTabId}:`,
          error,
        );
      })
      .finally(() => {
        activeBackendModalLaunch = null;
        setTabAttentionRequired(
          normalizedTabId,
          hasOutstandingAttentionForTab(normalizedTabId),
        );
        const activeTabId = getActiveModalTabId();
        if (getPendingModalQueue(activeTabId)?.length) {
          launchNextBackendModalForTab(activeTabId);
        }
      });

    return true;
  }

  function claimPendingBackendModalsForChat(chatId, tabId) {
    const normalizedChatId = normalizeModalString(chatId);
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedChatId || !normalizedTabId) {
      return false;
    }
    if (window.appState?.activeTab !== getFullTabId(normalizedTabId)) {
      return false;
    }
    if (!tabMatchesChatId(normalizedTabId, normalizedChatId)) {
      return false;
    }

    const chatQueue = getPendingChatModalQueue(normalizedChatId);
    if (!chatQueue?.length) {
      return false;
    }

    pendingBackendModalsByChatId.delete(normalizedChatId);
    const tabQueue = getPendingModalQueue(normalizedTabId, true);
    tabQueue.push(...chatQueue);
    tabQueue.sort((a, b) => a.sequence - b.sequence);
    const firstEntry = chatQueue.slice().sort((a, b) => a.sequence - b.sequence)[0];
    setTabAttentionRequired(
      normalizedTabId,
      true,
      firstEntry?.kind || null,
      firstEntry?.payload || {},
    );
    launchNextBackendModalForTab(normalizedTabId);
    return true;
  }

  function releasePendingBackendModalsForTab(tabId) {
    const normalizedTabId = normalizeModalString(tabId);
    const tabQueue = normalizedTabId
      ? getPendingModalQueue(normalizedTabId)
      : null;
    if (!tabQueue?.length) {
      return false;
    }

    let released = false;
    const retained = [];
    for (const entry of tabQueue) {
      const chatId = normalizeModalString(entry.payload?.chat_id);
      if (chatId && CHAT_KEYED_NATIVE_INPUT_KINDS.has(entry.kind)) {
        getPendingChatModalQueue(chatId, true).push(entry);
        released = true;
      } else {
        retained.push(entry);
      }
    }

    if (retained.length > 0) {
      pendingBackendModalsByTabId.set(normalizedTabId, retained);
    } else {
      pendingBackendModalsByTabId.delete(normalizedTabId);
    }
    setTabAttentionRequired(normalizedTabId, false);
    return released;
  }

  function pendingEntryMatchesTerminal(entry, backendKind, flowId) {
    return (
      entry?.kind === backendKind &&
      normalizeModalString(entry?.payload?.flow_id) === flowId
    );
  }

  function handleNativeInputTerminal(payload = {}) {
    const backendKind = BACKEND_KIND_BY_NATIVE_INPUT_KIND[payload?.kind];
    const flowId = normalizeModalString(payload?.flow_id);
    if (!backendKind || !flowId) {
      return false;
    }

    let removed = false;
    for (const [tabId, queue] of pendingBackendModalsByTabId.entries()) {
      const remaining = queue.filter(
        (entry) => !pendingEntryMatchesTerminal(entry, backendKind, flowId),
      );
      if (remaining.length === queue.length) {
        continue;
      }
      removed = true;
      if (remaining.length > 0) {
        pendingBackendModalsByTabId.set(tabId, remaining);
      } else {
        pendingBackendModalsByTabId.delete(tabId);
      }
      setTabAttentionRequired(tabId, hasOutstandingAttentionForTab(tabId));
    }

    for (const [chatId, queue] of pendingBackendModalsByChatId.entries()) {
      const remaining = queue.filter(
        (entry) => !pendingEntryMatchesTerminal(entry, backendKind, flowId),
      );
      if (remaining.length === queue.length) {
        continue;
      }
      removed = true;
      if (remaining.length > 0) {
        pendingBackendModalsByChatId.set(chatId, remaining);
      } else {
        pendingBackendModalsByChatId.delete(chatId);
      }
    }

    if (
      activeBackendModalLaunch?.kind === backendKind &&
      activeBackendModalLaunch?.flowId === flowId
    ) {
      removed = true;
      activeBackendModalLaunch.terminalReceived = true;
      setTabAttentionRequired(
        activeBackendModalLaunch.tabId,
        hasOutstandingAttentionForTab(activeBackendModalLaunch.tabId),
      );
    }

    return removed;
  }

  function enqueueBackendModalForViewport(kind, payload, options, runner) {
    if (!hasMainTabShell()) {
      return false;
    }

    const tabId = resolveTabIdForModalPayload(payload);
    if (!tabId) {
      const chatId = normalizeModalString(payload?.chat_id);
      if (chatId && CHAT_KEYED_NATIVE_INPUT_KINDS.has(kind)) {
        enqueueBackendModalForChat(chatId, kind, payload, options, runner);
        console.log(
          `[${logPrefix(options)}] Deferred ${kind} modal for unopened chat ${chatId}`,
        );
        return true;
      }
      return false;
    }

    const isActiveTab = window.appState?.activeTab === getFullTabId(tabId);
    enqueueBackendModalForTab(
      tabId,
      kind,
      payload,
      options,
      runner,
    );
    if (isActiveTab) {
      launchNextBackendModalForTab(tabId);
    }

    console.log(
      `[${logPrefix(options)}] ${isActiveTab ? "Queued" : "Deferred"} ${kind} modal for ${isActiveTab ? "active" : "background"} tab ${tabId}`,
    );
    return true;
  }

  function handleCommittedOwuiUrl(detail = {}) {
    if (!hasMainTabShell()) {
      return false;
    }
    const chatId = extractChatIdFromOwuiUrl(detail?.currentUrl);
    if (!chatId) {
      return false;
    }
    const tabId = resolveTabIdFromModalTarget({
      viewKey: detail?.viewKey,
      conversationId: detail?.conversationId,
      windowType: detail?.windowType,
    });
    return tabId ? claimPendingBackendModalsForChat(chatId, tabId) : false;
  }

  function runOrDeferBackendModal(kind, payload, options, runner) {
    const normalizedPayload = payload && typeof payload === "object" ? payload : {};
    if (enqueueBackendModalForViewport(kind, normalizedPayload, options, runner)) {
      return;
    }
    void runner(normalizedPayload, options);
  }

  function drainPendingBackendModalsForTab(tabId) {
    const normalizedTabId = normalizeModalString(tabId);
    if (!normalizedTabId) {
      return false;
    }

    const tabQueue = getPendingModalQueue(normalizedTabId);
    const isActiveLaunchForTab = activeBackendModalLaunch?.tabId === normalizedTabId;
    if (!tabQueue || tabQueue.length === 0) {
      if (isActiveLaunchForTab) {
        return true;
      }
      setTabAttentionRequired(normalizedTabId, false);
      return false;
    }

    launchNextBackendModalForTab(normalizedTabId);
    return true;
  }

  async function ensureServersLoaded(prefix) {
    const state = ensureAppState();
    if (state.servers.length > 0 || !window.electronAPI?.loadMcpServers) {
      return state.servers;
    }

    console.log(`[${prefix}] appState.servers not loaded, reloading...`);
    const serversResult = await window.electronAPI.loadMcpServers();
    if (serversResult?.success && Array.isArray(serversResult.data)) {
      state.servers = serversResult.data;
    }
    return state.servers;
  }

  function findServerForModal(serverId) {
    const normalizedServerId = String(serverId || "").trim();
    return (
      ensureAppState().servers.find((server) => server?.id === normalizedServerId) ||
      null
    );
  }

  function buildBackendOAuthServer(serverId, forceAuth) {
    const server = findServerForModal(serverId);
    const requirements =
      window.McpServerRequirements?.getControlPlaneRequirements?.(server) || {};
    return {
      id: server?.id || serverId,
      server_name: server?.id || serverId,
      name: server?.name || server?.display_name || serverId,
      display_name: server?.display_name || server?.name || serverId,
      description: server?.description,
      icon: server?.icon,
      logoKind: server?.logoKind || server?.logo_kind || null,
      state: "active",
      forceAuth: Boolean(forceAuth),
      configurationPending:
        requirements.requiresConfig === true && server?.isConfigured !== true,
    };
  }

  async function runBackendOAuthFlow(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const { server_id, force_auth, resume_existing } = payload;
    if (!server_id) {
      return;
    }

    console.log(
      `[${prefix}] LLM requested OAuth flow for ${server_id} (force_auth=${Boolean(force_auth)}, resume_existing=${Boolean(resume_existing)})`,
    );

    if (window.refreshServerAfterOperation) {
      Promise.resolve()
        .then(() =>
          window.refreshServerAfterOperation(server_id, {
            waitForHealthy: false,
            maxWait: 1000,
          }),
        )
        .catch((error) => {
          console.warn(
            `[${prefix}] Failed to refresh local readiness for ${server_id}:`,
            error,
          );
        });
    }

    try {
      if (window.runOAuthFlowForServer) {
        await window.runOAuthFlowForServer(server_id, {
          flowSource: "backend-requested",
          requestedServerId: server_id,
          forceAuth: Boolean(force_auth),
          resumeExisting: Boolean(resume_existing),
          showNotifications: false,
        });
        return;
      }

      await ensureServersLoaded(prefix);

      if (window.runOAuthWizard) {
        await window.runOAuthWizard(
          [buildBackendOAuthServer(server_id, force_auth)],
          {
            preferredServerId: server_id,
            forceAuthServerIds: force_auth ? [server_id] : [],
            flowSource: "backend-requested",
            resumeExisting: Boolean(resume_existing),
            requestedServerId: server_id,
            backendManagedServerIds: [server_id],
          },
        );
        return;
      }

      if (window.runOAuthFlowForSingleServer) {
        await window.runOAuthFlowForSingleServer(
          server_id,
          (message) => console.log(`[${prefix}] ${message}`),
          {
            backendManagedFinalization: true,
            resumeExisting: Boolean(resume_existing),
            requestedServerId: server_id,
          },
        );
        return;
      }

      console.error(`[${prefix}] OAuth modal runtime is not available`);
    } catch (error) {
      console.error(`[${prefix}] Failed to launch OAuth flow for ${server_id}:`, error);
    }
  }

  async function handleOAuthCompleted(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const { server_id, success, reason } = payload;
    if (!server_id) {
      return;
    }

    console.log(
      `[${prefix}] OAuth flow completed for ${server_id}: ${success ? "success" : "failed"}${reason ? ` (${reason})` : ""}`,
    );

    window.closeOAuthModal?.();
    if (reason !== "contractor_denied") {
      window.closeWizardModal?.();
    }

    if (reason === "contractor_denied") {
      window.hideLoading?.();
      if (document.body?.style) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        requestAnimationFrame(() => {
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        });
      }
    }

    if (success) {
      try {
        const serversResult = await window.electronAPI?.loadMcpServers?.();
        if (serversResult?.success && Array.isArray(serversResult.data)) {
          ensureAppState().servers = serversResult.data;
          await window.loadMcpToggles?.();
          await window.checkHostModeSupport?.();
          window.updateMcpServersList?.();
        }
      } catch (error) {
        console.warn(`[${prefix}] Failed to refresh servers after OAuth:`, error);
      }
      try {
        await window.McpOperationOverlayController?.reconcileOAuthCompletion?.(server_id);
      } catch (error) {
        console.warn(`[${prefix}] Failed to reconcile MCP operation after OAuth:`, error);
      }
    } else if (reason === "timeout") {
      window.showNotification?.(
        `Authentication session for ${server_id} expired. Please retry authentication.`,
        "error",
      );
    } else if (reason === "failed") {
      window.showNotification?.(
        `Authentication failed for ${server_id}. Please try again.`,
        "error",
      );
    }
  }

  async function runSensitiveInfoFlow(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const {
      flow_id,
      chat_id,
      prompt,
      preamble,
      label,
      placeholder,
      timeout_seconds,
      visual_aids,
    } = payload;
    console.log(
      `[${prefix}] Backend requested sensitive-info flow ${flow_id}`,
    );

    if (!window.runSensitiveInfoModal) {
      console.error(`[${prefix}] runSensitiveInfoModal is not available`);
      window.electronAPI?.notifySensitiveInfoCompleted?.({
        flow_id,
        action: "error",
        error: "Sensitive information modal is not available",
      });
      return;
    }

    try {
      await window.runSensitiveInfoModal({
        flow_id,
        chat_id,
        prompt,
        preamble,
        label,
        placeholder,
        timeout_seconds,
        visual_aids,
        launchSource: "backend-requested",
      });
    } catch (error) {
      console.error(`[${prefix}] Failed to launch sensitive-info flow ${flow_id}:`, error);
      window.electronAPI?.notifySensitiveInfoCompleted?.({
        flow_id,
        action: "error",
        error: error?.message || "Failed to open sensitive information modal",
      });
    }
  }

  async function runChatWorkspaceConsentFlow(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const { flow_id, chat_id, host_path, display_path, preamble, timeout_seconds } = payload;
    console.log(
      `[${prefix}] Backend requested chat-workspace consent flow ${flow_id}`,
    );

    if (!window.runChatWorkspaceConsentModal) {
      console.error(`[${prefix}] runChatWorkspaceConsentModal is not available`);
      window.electronAPI?.notifyChatWorkspaceConsentCompleted?.({
        flow_id,
        action: "error",
        error: "Chat workspace consent modal is not available",
      });
      return;
    }

    try {
      await window.runChatWorkspaceConsentModal({
        flow_id,
        chat_id,
        host_path,
        display_path,
        preamble,
        timeout_seconds,
        __modalTarget: payload.__modalTarget || null,
        launchSource: "backend-requested",
      });
    } catch (error) {
      console.error(`[${prefix}] Failed to launch chat-workspace consent flow ${flow_id}:`, error);
      window.electronAPI?.notifyChatWorkspaceConsentCompleted?.({
        flow_id,
        action: "error",
        error: error?.message || "Failed to open chat workspace consent modal",
      });
    }
  }

  async function runAiMarketplacePublishConfirmFlow(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const { flow_id } = payload;
    console.log(
      `[${prefix}] Backend requested AI Marketplace publish confirmation ${flow_id}`,
    );

    // Every chat-initiated confirmation — agents included — goes through the
    // BATCHING modal: concurrent publish requests (the LLM fires them in one
    // parallel tool block) aggregate/live-append into ONE dialog instead of
    // the first mounting the consolidated agents.js modal and the rest
    // fast-failing publish_ui_busy. On approve, agent items execute in the
    // renderer via AgentsTabModule.executeBackendAgentPublish. The
    // consolidated single-flow modal remains as the degraded fallback when
    // the batch runner is missing.
    if (
      payload?.mode === "publish-agent" &&
      !window.runAiMarketplacePublishModal &&
      typeof window.AgentsTabModule?.publishAgentFromBackendRequest === "function" &&
      payload?.agent?.id
    ) {
      try {
        await window.AgentsTabModule.publishAgentFromBackendRequest({
          ...payload,
          launchSource: "backend-requested",
        });
      } catch (error) {
        console.error(
          `[${prefix}] Consolidated agent-publish flow failed for ${flow_id}:`,
          error,
        );
        window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
          flow_id,
          action: "error",
          error: error?.message || "Failed to open the agent publish modal",
        });
      }
      return;
    }

    if (!window.runAiMarketplacePublishModal) {
      console.error(`[${prefix}] runAiMarketplacePublishModal is not available`);
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id,
        action: "error",
        error: "AI Marketplace publish modal is not available",
      });
      return;
    }

    try {
      await window.runAiMarketplacePublishModal({
        ...payload,
        launchSource: "backend-requested",
      });
    } catch (error) {
      console.error(
        `[${prefix}] Failed to launch AI Marketplace publish confirmation ${flow_id}:`,
        error,
      );
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id,
        action: "error",
        error: error?.message || "Failed to open the AI Marketplace publish modal",
      });
    }
  }

  async function runGuidedSetup(payload = {}, options = {}) {
    const prefix = logPrefix(options);
    const { server_id, reason, flow_id } = payload;
    if (!server_id) {
      return;
    }

    console.log(
      `[${prefix}] LLM requested guided setup for ${server_id}${reason ? ` (reason: ${reason})` : ""}`,
    );

    try {
      await ensureServersLoaded(prefix);

      if (!window.openMcpConfigModal) {
        console.error(`[${prefix}] openMcpConfigModal is not available`);
        window.electronAPI?.notifyGuidedSetupCompleted?.(
          server_id,
          "test_failed",
          flow_id,
          { message: "The configuration form could not be opened." },
        );
        return;
      }

      await window.openMcpConfigModal(server_id, null, {
        flowId: flow_id,
        reason,
        launchSource: "backend-requested",
        waitForClose: true,
      });
    } catch (error) {
      console.error(`[${prefix}] openMcpConfigModal error for ${server_id}:`, error);
      window.electronAPI?.notifyGuidedSetupCompleted?.(
        server_id,
        "test_failed",
        flow_id,
        { message: "The configuration form could not be opened." },
      );
    }
  }

  function setupBackendModalListeners(options = {}) {
    if (backendModalListenersRegistered) {
      return;
    }
    backendModalListenersRegistered = true;

    console.log(`[${logPrefix(options)}] Setting up backend modal listeners...`);

    for (const spec of BACKEND_MODAL_KINDS) {
      window.electronAPI?.[spec.event]?.((payload) => {
        if (spec.notificationType) {
          void notifyBackendModalAttention(spec.kind, payload);
        }
        if (spec.runner) {
          runOrDeferBackendModal(spec.kind, payload, options, spec.runner);
        }
      });
    }
    window.electronAPI?.onOAuthFlowCompleted?.((payload) => {
      void handleOAuthCompleted(payload, options);
    });
    window.electronAPI?.onNativeInputTerminal?.((payload) => {
      handleNativeInputTerminal(payload);
    });
    window.addEventListener?.("owui-committed-url-changed", (event) => {
      handleCommittedOwuiUrl(event?.detail || {});
    });
  }

  window.backendModalAttention = {
    claimForChat: claimPendingBackendModalsForChat,
    drainForTab: drainPendingBackendModalsForTab,
    releaseTab: releasePendingBackendModalsForTab,
    getPendingCountForChat(chatId) {
      return pendingBackendModalsByChatId.get(chatId)?.length || 0;
    },
    getPendingCountForTab(tabId) {
      return pendingBackendModalsByTabId.get(tabId)?.length || 0;
    },
    handleNativeInputTerminal,
    handleCommittedOwuiUrl,
    resolveTabIdForPayload: resolveTabIdForModalPayload,
  };
  window.drainPendingBackendModalsForTab = drainPendingBackendModalsForTab;
  window.setupBackendModalListeners = setupBackendModalListeners;
})();
