const CHAT_WORKSPACE_CONSENT_OPENAI_SHORT_CODE_PATTERN = /(^|\s)(o1|o3|o4)(?:[\s-]|$)/;

let chatWorkspaceConsentTemplateLoaded = false;
// PORTICO-348: every pending consent request, keyed by the chat that owns it. The
// grant stays a NATIVE modal -- permission UI must not be spoofable by page
// content -- but is scoped per chat: only one is presented at a time
// (`chatWorkspaceConsentState` points at it, the same object held here), and a
// request pending in another chat neither blocks this one nor stays hidden.
const chatWorkspaceConsentFlows = new Map();
let chatWorkspaceConsentState = createInitialChatWorkspaceConsentState();

function hasPresentedChatWorkspaceConsentFlow() {
  return Boolean(chatWorkspaceConsentState.flowId);
}

function createInitialChatWorkspaceConsentState(overrides = {}) {
  return {
    flowId: null,
    chatId: null,
    hostPath: "",
    displayPath: "",
    preamble: "",
    requesterIdentity: buildFallbackChatWorkspaceConsentRequesterIdentity(),
    modalTarget: null,
    presentation: "visible",
    // PORTICO-348: parked by a tab switch, as opposed to an explicit Hide.
    hiddenByNavigation: false,
    resolve: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Chat ownership: chat_id is the durable owner. Tabs and view keys are
// presentation details that can change while a request is pending.
// ---------------------------------------------------------------------------

function extractChatWorkspaceConsentChatIdFromUrl(value) {
  const raw = normalizeChatWorkspaceConsentString(value);
  if (!raw || raw === "about:blank") return null;
  try {
    const url = new URL(raw, "http://localhost:3789");
    const match = url.pathname.replace(/\/+$/, "").match(/^\/c\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function getChatWorkspaceConsentOwnerElement(target) {
  if (!target || typeof target !== "object") return null;
  const conversationId = normalizeChatWorkspaceConsentString(target.conversationId);
  if (conversationId && conversationId !== "chat") {
    const el = document.getElementById(`conversation-webview-${conversationId}`);
    if (el) return el;
  }
  const viewKey = normalizeChatWorkspaceConsentString(target.viewKey);
  if (viewKey.startsWith("conversation:")) {
    const id = viewKey.slice("conversation:".length);
    const el = id ? document.getElementById(`conversation-webview-${id}`) : null;
    if (el) return el;
  }
  return document.getElementById("chat-webview");
}

function getActiveChatWorkspaceConsentOwnerElement(flow = chatWorkspaceConsentState) {
  if (!document.getElementById("tab-strip")) {
    return (
      getChatWorkspaceConsentOwnerElement(flow?.modalTarget) ||
      document.getElementById("chat-webview") ||
      document.getElementById("conversation-webview") ||
      document.querySelector?.('[data-owui-host="true"]') ||
      null
    );
  }
  const activeTab = normalizeChatWorkspaceConsentString(window.appState?.activeTab);
  if (activeTab === "chat") return document.getElementById("chat-webview");
  if (activeTab.startsWith("conversation-")) {
    const id = activeTab.slice("conversation-".length);
    return id ? document.getElementById(`conversation-webview-${id}`) : null;
  }
  return null;
}

function doesChatWorkspaceConsentOwnerDisplayChat(flow = chatWorkspaceConsentState) {
  if (!flow?.chatId) return false;
  const owner = getActiveChatWorkspaceConsentOwnerElement(flow);
  if (!owner || typeof owner.getCommittedURL !== "function") return false;
  try {
    return extractChatWorkspaceConsentChatIdFromUrl(owner.getCommittedURL()) === flow.chatId;
  } catch (_) {
    return false;
  }
}

function getPendingChatWorkspaceConsentFlowForActiveChat() {
  for (const flow of chatWorkspaceConsentFlows.values()) {
    if (doesChatWorkspaceConsentOwnerDisplayChat(flow)) return flow;
  }
  return null;
}

function bindPresentedChatWorkspaceConsentFlow(flow) {
  chatWorkspaceConsentState = flow || createInitialChatWorkspaceConsentState();
  return chatWorkspaceConsentState;
}

function forgetChatWorkspaceConsentFlow(flow) {
  if (!flow) return;
  const chatId = normalizeChatWorkspaceConsentString(flow.chatId);
  if (chatId && chatWorkspaceConsentFlows.get(chatId) === flow) {
    chatWorkspaceConsentFlows.delete(chatId);
  }
  if (chatWorkspaceConsentState === flow) bindPresentedChatWorkspaceConsentFlow(null);
}

function findChatWorkspaceConsentFlowById(flowId) {
  const normalized = normalizeChatWorkspaceConsentString(flowId);
  if (!normalized) return null;
  if (chatWorkspaceConsentState.flowId === normalized) return chatWorkspaceConsentState;
  for (const flow of chatWorkspaceConsentFlows.values()) {
    if (flow.flowId === normalized) return flow;
  }
  return null;
}

async function suspendChatWorkspaceConsentFlowForNavigation(flow) {
  if (!flow?.flowId) return false;
  flow.presentation = "hidden";
  flow.hiddenByNavigation = true;
  const setPresentation = window.electronAPI?.setNativeInputPresentation;
  if (typeof setPresentation !== "function") return false;
  try {
    const result = await setPresentation({
      kind: "chat_workspace_consent",
      flow_id: flow.flowId,
      presentation: "hidden",
    });
    return Boolean(result?.success);
  } catch (error) {
    console.error("[Workspace Consent] Failed to suspend background request:", error);
    return false;
  }
}

async function syncChatWorkspaceConsentModalForNavigation() {
  const nextFlow = getPendingChatWorkspaceConsentFlowForActiveChat();
  if (hasPresentedChatWorkspaceConsentFlow() && chatWorkspaceConsentState !== nextFlow) {
    await hideChatWorkspaceConsentModal({ navigation: true });
    bindPresentedChatWorkspaceConsentFlow(null);
  }
  if (nextFlow && chatWorkspaceConsentState !== nextFlow) {
    bindPresentedChatWorkspaceConsentFlow(nextFlow);
  }
  if (!hasPresentedChatWorkspaceConsentFlow()) return false;
  // An explicit Hide stays hidden; only navigation-parked requests restore.
  if (
    chatWorkspaceConsentState.presentation === "hidden" &&
    !chatWorkspaceConsentState.hiddenByNavigation
  ) {
    return false;
  }
  chatWorkspaceConsentState.hiddenByNavigation = false;
  return showChatWorkspaceConsentModal();
}

function buildFallbackChatWorkspaceConsentRequesterIdentity(overrides = {}) {
  return {
    displayName: "This chat",
    fallbackText: "AI",
    logoDataUrl: null,
    needsDarkBadge: false,
    ...overrides,
  };
}

function normalizeChatWorkspaceConsentString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildChatWorkspaceConsentFallbackText(value) {
  const normalized = normalizeChatWorkspaceConsentString(value);
  if (!normalized) {
    return "AI";
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }
  return normalized.slice(0, 2).toUpperCase();
}

function getChatWorkspaceConsentBrandFamily(identity = {}) {
  const haystack = [
    normalizeChatWorkspaceConsentString(identity.displayName),
    normalizeChatWorkspaceConsentString(identity.modelId),
    normalizeChatWorkspaceConsentString(identity.ownedBy),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) {
    return "other";
  }

  if (haystack.includes("atlas") || haystack.includes("anthropic")) {
    return "atlas";
  }

  if (
    haystack.includes("openai") ||
    haystack.includes("chatgpt") ||
    haystack.includes("gpt") ||
    CHAT_WORKSPACE_CONSENT_OPENAI_SHORT_CODE_PATTERN.test(haystack)
  ) {
    return "openai";
  }

  return "other";
}

function resolveChatWorkspaceConsentCelestialIdentity(identity = {}) {
  if (Boolean(identity.isDerivedModel)) {
    return null;
  }

  const identifiers = [
    normalizeChatWorkspaceConsentString(identity.modelId),
    normalizeChatWorkspaceConsentString(identity.displayName),
  ];
  for (const identifier of identifiers) {
    const normalized = identifier
      .toLowerCase()
      .replace(/:latest$/i, "")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-");
    if (normalized === "gpt-5.6-sol" || normalized === "gpt-5.6-sol-pro") {
      return "sol";
    }
    if (normalized === "gpt-5.6-terra") {
      return "terra";
    }
    if (normalized === "gpt-5.6-luna") {
      return "luna";
    }
  }

  return null;
}

function chatWorkspaceConsentNeedsDarkLogoBadge(identity = {}) {
  return (
    getChatWorkspaceConsentBrandFamily(identity) === "openai" &&
    resolveChatWorkspaceConsentCelestialIdentity(identity) === null
  );
}

function normalizeChatWorkspaceConsentRequesterIdentity(identity = {}) {
  const displayName =
    normalizeChatWorkspaceConsentString(identity.displayName) ||
    normalizeChatWorkspaceConsentString(identity.modelId) ||
    "This chat";
  const logoDataUrl = normalizeChatWorkspaceConsentString(identity.logoDataUrl) || null;
  const isDerivedModel = Boolean(identity.isDerivedModel);
  // Trust the base-derived celestial identity the resolver already computed (for
  // agents it resolves the base model); only re-derive when absent (fallbacks).
  const providedCelestial = normalizeChatWorkspaceConsentString(identity.celestialIdentity);
  const celestialIdentity =
    providedCelestial === "sol" || providedCelestial === "terra" || providedCelestial === "luna"
      ? providedCelestial
      : resolveChatWorkspaceConsentCelestialIdentity({ ...identity, displayName, isDerivedModel });

  return {
    displayName,
    modelId: normalizeChatWorkspaceConsentString(identity.modelId) || null,
    ownedBy: normalizeChatWorkspaceConsentString(identity.ownedBy) || null,
    brandFamily:
      normalizeChatWorkspaceConsentString(identity.brandFamily) ||
      getChatWorkspaceConsentBrandFamily(identity),
    fallbackText:
      normalizeChatWorkspaceConsentString(identity.fallbackText) ||
      buildChatWorkspaceConsentFallbackText(displayName),
    logoDataUrl,
    // Base-model identity for the animated badge (agent → base model logo).
    logoModelId:
      normalizeChatWorkspaceConsentString(identity.logoModelId) ||
      normalizeChatWorkspaceConsentString(identity.modelId) ||
      null,
    logoName: normalizeChatWorkspaceConsentString(identity.logoName) || displayName,
    isDerivedModel,
    celestialIdentity,
    isCelestialLogo: Boolean(celestialIdentity && logoDataUrl),
    needsDarkBadge:
      celestialIdentity === null &&
      (Boolean(identity.needsDarkBadge) ||
        chatWorkspaceConsentNeedsDarkLogoBadge(identity)),
  };
}

async function loadChatWorkspaceConsentTemplate() {
  if (chatWorkspaceConsentTemplateLoaded || document.getElementById("chat-workspace-consent-modal")) {
    chatWorkspaceConsentTemplateLoaded = true;
    return;
  }
  const container = document.getElementById("chat-workspace-consent-container");
  if (!container) {
    throw new Error("Container #chat-workspace-consent-container not found");
  }
  const response = await fetch("renderer/components/chat-workspace-consent-modal.html");
  container.innerHTML = await response.text();
  chatWorkspaceConsentTemplateLoaded = true;
}

function getChatWorkspaceConsentElements() {
  return {
    modal: document.getElementById("chat-workspace-consent-modal"),
    titleLogoBadge: document.getElementById("chat-workspace-consent-title-logo-badge"),
    titleLogo: document.getElementById("chat-workspace-consent-title-logo"),
    titleLogoFallback: document.getElementById("chat-workspace-consent-title-logo-fallback"),
    preamble: document.getElementById("chat-workspace-consent-preamble"),
    path: document.getElementById("chat-workspace-consent-path"),
    error: document.getElementById("chat-workspace-consent-error"),
    openBtn: document.getElementById("chat-workspace-consent-open-btn"),
    approveBtn: document.getElementById("chat-workspace-consent-approve-btn"),
    cancelBtn: document.getElementById("chat-workspace-consent-cancel-btn"),
    hideBtn: document.getElementById("chat-workspace-consent-hide-btn"),
    closeBtn: document.getElementById("chat-workspace-consent-close-btn"),
  };
}

function setChatWorkspaceConsentInteractionSuppressed(suppressed) {
  window.setOwuiInteractionSuppressed?.("chat-workspace-consent-modal", suppressed);
  window.setNativeOverlayInteractionSuppressed?.("chat-workspace-consent-modal", suppressed);
}

function buildChatWorkspaceConsentLogoBadgeIdentity(identity) {
  return {
    brandFamily: identity.brandFamily,
    celestialIdentity: identity.celestialIdentity,
    isLocal: false,
    logoModelId: identity.logoModelId,
    logoName: identity.logoName,
    logoDataUrl: identity.logoDataUrl,
    needsDarkBadge: identity.needsDarkBadge,
    fallbackText: identity.fallbackText,
  };
}

function renderChatWorkspaceConsentRequesterHeader() {
  const elements = getChatWorkspaceConsentElements();
  const identity = normalizeChatWorkspaceConsentRequesterIdentity(
    chatWorkspaceConsentState.requesterIdentity,
  );
  const hasLogoImage = Boolean(identity.logoDataUrl);

  // Animated model-logo badge (base model when the chat is an agent), matching
  // the inline chat logo. Falls back to the legacy static image when the shared
  // badge renderer is unavailable (e.g. isolated test contexts).
  if (
    elements.titleLogoBadge &&
    typeof window !== "undefined" &&
    typeof window.renderModelLogoBadge === "function"
  ) {
    elements.titleLogoBadge.classList.remove(
      "has-logo-image",
      "celestial-logo",
      "dark-badge-light-mode",
    );
    window.renderModelLogoBadge(
      elements.titleLogoBadge,
      buildChatWorkspaceConsentLogoBadgeIdentity(identity),
      { seed: identity.logoModelId || chatWorkspaceConsentState.chatId || "chat-workspace-consent" },
    );
    return;
  }

  if (elements.titleLogoBadge) {
    elements.titleLogoBadge.classList.toggle("has-logo-image", hasLogoImage);
    elements.titleLogoBadge.classList.toggle(
      "celestial-logo",
      Boolean(identity.isCelestialLogo),
    );
    elements.titleLogoBadge.classList.toggle(
      "dark-badge-light-mode",
      Boolean(identity.needsDarkBadge),
    );
  }

  if (elements.titleLogoFallback) {
    elements.titleLogoFallback.textContent = identity.fallbackText;
    elements.titleLogoFallback.hidden = Boolean(identity.logoDataUrl);
  }

  if (elements.titleLogo) {
    if (identity.logoDataUrl) {
      elements.titleLogo.hidden = false;
      elements.titleLogo.alt = identity.displayName;
      elements.titleLogo.src = identity.logoDataUrl;
      elements.titleLogo.onerror = () => {
        elements.titleLogo.hidden = true;
        elements.titleLogo.removeAttribute("src");
        elements.titleLogoBadge?.classList.remove("has-logo-image");
        elements.titleLogoBadge?.classList.remove("celestial-logo");
        if (elements.titleLogoFallback) {
          elements.titleLogoFallback.hidden = false;
        }
      };
    } else {
      elements.titleLogo.hidden = true;
      elements.titleLogo.removeAttribute("src");
    }
  }
}

function renderChatWorkspaceConsentModal() {
  const elements = getChatWorkspaceConsentElements();
  renderChatWorkspaceConsentRequesterHeader();
  if (elements.preamble) {
    const renderer = window.safeModalMarkdownRenderer || window.sensitiveInfoMarkdownRenderer;
    if (renderer?.renderSafeModalPreamble) {
      renderer.renderSafeModalPreamble(
        elements.preamble,
        chatWorkspaceConsentState.preamble,
      );
    } else {
      elements.preamble.replaceChildren();
      elements.preamble.hidden = !chatWorkspaceConsentState.preamble;
      if (chatWorkspaceConsentState.preamble) {
        elements.preamble.textContent = chatWorkspaceConsentState.preamble;
      }
    }
  }
  if (elements.path) {
    elements.path.textContent =
      chatWorkspaceConsentState.displayPath || chatWorkspaceConsentState.hostPath;
    elements.path.title = chatWorkspaceConsentState.hostPath;
  }
  if (elements.error) {
    elements.error.textContent = "";
    elements.error.classList.remove("visible");
  }
}

function showChatWorkspaceConsentError(message) {
  const { error } = getChatWorkspaceConsentElements();
  if (!error) {
    return;
  }
  error.textContent = message || "Unable to open the requested folder.";
  error.classList.add("visible");
}

// PORTICO-348: settle a specific flow and drop it from the pending map; a request
// can terminate while another chat's modal is the one on screen.
function settleChatWorkspaceConsentFlow(flow, result) {
  if (typeof flow?.resolve === "function") {
    flow.resolve(result);
  }
  forgetChatWorkspaceConsentFlow(flow);
}

function showChatWorkspaceConsentModal() {
  if (!hasPresentedChatWorkspaceConsentFlow()) {
    return false;
  }
  const { modal, approveBtn } = getChatWorkspaceConsentElements();
  if (!modal) {
    return false;
  }
  chatWorkspaceConsentState.presentation = "visible";
  chatWorkspaceConsentState.hiddenByNavigation = false;
  renderChatWorkspaceConsentModal();
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  modal.setAttribute("tabindex", "-1");
  setChatWorkspaceConsentInteractionSuppressed(true);
  setTimeout(() => approveBtn?.focus?.(), 0);
  return true;
}

async function hideChatWorkspaceConsentModal(options = {}) {
  if (!hasPresentedChatWorkspaceConsentFlow()) {
    return false;
  }
  const navigation = options.navigation === true;
  const setPresentation = window.electronAPI?.setNativeInputPresentation;
  if (typeof setPresentation !== "function") {
    return false;
  }
  const { modal } = getChatWorkspaceConsentElements();
  modal?.classList.remove("visible");
  modal?.setAttribute("aria-hidden", "true");
  setChatWorkspaceConsentInteractionSuppressed(false);
  chatWorkspaceConsentState.presentation = "hidden";
  chatWorkspaceConsentState.hiddenByNavigation = navigation;

  try {
    const result = await setPresentation({
      kind: "chat_workspace_consent",
      flow_id: chatWorkspaceConsentState.flowId,
      presentation: "hidden",
    });
    if (!result?.success) {
      throw new Error(result?.error || "Failed to hide workspace permission");
    }
    return true;
  } catch (error) {
    console.error("[Workspace Consent] Failed to hide modal:", error);
    if (!navigation) {
      showChatWorkspaceConsentModal();
    }
    return false;
  }
}

function closeChatWorkspaceConsentModal(options = {}) {
  const { modal } = getChatWorkspaceConsentElements();
  if (modal) {
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
  }
  setChatWorkspaceConsentInteractionSuppressed(false);
  // PORTICO-348: settle and forget only this flow; other chats keep theirs.
  settleChatWorkspaceConsentFlow(
    options.flow || chatWorkspaceConsentState,
    options.result || null,
  );
  void syncChatWorkspaceConsentModalForNavigation();
}

function dismissChatWorkspaceConsentModal() {
  if (chatWorkspaceConsentState.flowId) {
    window.electronAPI?.notifyChatWorkspaceConsentCompleted?.({
      flow_id: chatWorkspaceConsentState.flowId,
      action: "dismissed",
      modal_target: chatWorkspaceConsentState.modalTarget,
    });
  }
  closeChatWorkspaceConsentModal({
    result: {
      action: "dismissed",
    },
  });
}

function approveChatWorkspaceConsentModal() {
  if (chatWorkspaceConsentState.flowId) {
    window.electronAPI?.notifyChatWorkspaceConsentCompleted?.({
      flow_id: chatWorkspaceConsentState.flowId,
      action: "approved",
      modal_target: chatWorkspaceConsentState.modalTarget,
    });
  }
  closeChatWorkspaceConsentModal({
    result: {
      action: "approved",
    },
  });
}

async function openChatWorkspaceConsentPath() {
  const { openBtn } = getChatWorkspaceConsentElements();
  if (openBtn) {
    openBtn.disabled = true;
  }
  try {
    const result = await window.electronAPI?.openChatWorkspaceConsentPath?.({
      flow_id: chatWorkspaceConsentState.flowId,
    });
    if (!result?.success) {
      throw new Error(result?.error || "Unable to open the requested folder.");
    }
  } catch (error) {
    showChatWorkspaceConsentError(error?.message || "Unable to open the requested folder.");
  } finally {
    if (openBtn) {
      openBtn.disabled = false;
    }
  }
}

function resolveChatWorkspaceConsentLanguage() {
  const documentLanguage = normalizeChatWorkspaceConsentString(document.documentElement?.lang);
  if (documentLanguage) {
    return documentLanguage;
  }
  const navigatorLanguage = normalizeChatWorkspaceConsentString(navigator.language);
  return navigatorLanguage || "en";
}

function getChatWorkspaceConsentOwuiViewCandidates(modalTarget = null) {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeChatWorkspaceConsentString(value);
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  pushCandidate(modalTarget?.viewKey);

  const activeTab = String(window.appState?.activeTab || "").trim();
  if (activeTab.startsWith("conversation-")) {
    pushCandidate(`conversation:${activeTab.slice("conversation-".length)}`);
  } else if (activeTab === "chat") {
    pushCandidate("main");
  }

  pushCandidate("main");

  const conversationTabs = window.appState?.conversationTabs || {};
  Object.keys(conversationTabs).forEach((conversationId) => {
    pushCandidate(`conversation:${conversationId}`);
  });

  return candidates;
}

function buildChatWorkspaceConsentRequesterResolutionScript({ chatId, language }) {
  return `(() => {
    const CHAT_ID = ${JSON.stringify(chatId)};
    const LANGUAGE = ${JSON.stringify(language)};
    const OPENAI_SHORT_CODE_PATTERN = /(^|\\s)(o1|o3|o4)(?:[\\s-]|$)/;

    const normalizeValue = (value) => {
      const normalized = String(value ?? "").trim();
      return normalized && normalized !== "null" && normalized !== "undefined"
        ? normalized
        : "";
    };

    const buildFallbackText = (value) => {
      const normalized = normalizeValue(value);
      if (!normalized) {
        return "AI";
      }
      const words = normalized.split(/\\s+/).filter(Boolean);
      if (words.length >= 2) {
        return \`\${words[0][0] || ""}\${words[1][0] || ""}\`.toUpperCase();
      }
      return normalized.slice(0, 2).toUpperCase();
    };

    const getBrandFamily = (candidate = {}) => {
      const haystack = [
        normalizeValue(candidate.displayName),
        normalizeValue(candidate.modelId),
        normalizeValue(candidate.ownedBy),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (!haystack) {
        return "other";
      }

      if (haystack.includes("atlas") || haystack.includes("anthropic")) {
        return "atlas";
      }

      if (
        haystack.includes("openai") ||
        haystack.includes("chatgpt") ||
        haystack.includes("gpt") ||
        OPENAI_SHORT_CODE_PATTERN.test(haystack)
      ) {
        return "openai";
      }

      return "other";
    };

    const getCelestialIdentity = (candidate = {}) => {
      if (Boolean(candidate.isDerivedModel)) {
        return null;
      }

      for (const identifier of [candidate.modelId, candidate.displayName]) {
        const normalized = normalizeValue(identifier)
          .toLowerCase()
          .replace(/:latest$/i, "")
          .split("/")
          .filter(Boolean)
          .pop()
          ?.replace(/[\\s_]+/g, "-")
          .replace(/-+/g, "-");
        if (normalized === "gpt-5.6-sol" || normalized === "gpt-5.6-sol-pro") {
          return "sol";
        }
        if (normalized === "gpt-5.6-terra") {
          return "terra";
        }
        if (normalized === "gpt-5.6-luna") {
          return "luna";
        }
      }

      return null;
    };

    const buildHeaders = () => {
      const token = normalizeValue(window.localStorage?.getItem("token"));
      return token ? { Authorization: \`Bearer \${token}\` } : {};
    };

    const fetchJson = async (url, headers) => {
      const response = await fetch(url, {
        method: "GET",
        headers,
        credentials: "include",
      });

      let body = null;
      try {
        body = await response.json();
      } catch (_) {}

      return {
        ok: response.ok,
        status: response.status,
        body,
      };
    };

    const resolveLogoUrl = (value) => {
      const normalized = normalizeValue(value);
      if (!normalized) {
        return null;
      }

      if (normalized.startsWith("data:")) {
        return normalized;
      }

      try {
        return new URL(normalized, window.location.origin).toString();
      } catch (_) {
        return null;
      }
    };

    const fetchImageDataUrl = async (url, headers) => {
      if (!url) {
        return null;
      }

      if (String(url).startsWith("data:")) {
        return String(url);
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        credentials: "include",
      });
      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(typeof reader.result === "string" ? reader.result : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    };

    return (async () => {
      const headers = buildHeaders();
      const chatResponse = await fetchJson(
        \`/api/v1/chats/\${encodeURIComponent(CHAT_ID)}\`,
        headers,
      );

      if (!chatResponse.ok || !chatResponse.body) {
        return {
          success: false,
          error: \`chat_fetch_\${chatResponse.status || "failed"}\`,
        };
      }

      const chatPayload = chatResponse.body;
      const chatContent =
        chatPayload &&
        typeof chatPayload === "object" &&
        chatPayload.chat &&
        typeof chatPayload.chat === "object"
          ? chatPayload.chat
          : chatPayload;

      let modelIds = [];
      if (Array.isArray(chatContent?.models)) {
        modelIds = chatContent.models;
      } else {
        const singleModelId = normalizeValue(chatContent?.models);
        if (singleModelId) {
          modelIds = [singleModelId];
        }
      }

      const modelId = normalizeValue(modelIds[0]);
      if (!modelId) {
        return {
          success: false,
          error: "missing_model_for_chat",
        };
      }

      const modelDetailUrl = new URL("/api/v1/models/model", window.location.origin);
      modelDetailUrl.searchParams.set("id", modelId);
      const modelResponse = await fetchJson(modelDetailUrl.toString(), headers);
      const modelPayload =
        modelResponse.ok && modelResponse.body && typeof modelResponse.body === "object"
          ? modelResponse.body
          : null;

      const displayName = normalizeValue(modelPayload?.name) || modelId;
      const ownedBy = normalizeValue(modelPayload?.owned_by);
      const baseModelId =
        normalizeValue(modelPayload?.base_model_id) ||
        normalizeValue(modelPayload?.baseModelId) ||
        normalizeValue(modelPayload?.info?.base_model_id) ||
        normalizeValue(modelPayload?.info?.baseModelId);
      const isDerivedModel = Boolean(baseModelId);

      // Resolve the LOGO from the BASE model when this chat is an agent, so the
      // badge shows the base model's animated logo (matching the inline chat
      // logo) instead of the agent's own (usually empty) profile image.
      let logoModelId = modelId;
      let logoName = displayName;
      let logoOwnedBy = ownedBy;
      let logoModelPayload = modelPayload;
      if (baseModelId) {
        const baseModelDetailUrl = new URL("/api/v1/models/model", window.location.origin);
        baseModelDetailUrl.searchParams.set("id", baseModelId);
        const baseModelResponse = await fetchJson(baseModelDetailUrl.toString(), headers);
        const baseModelPayload =
          baseModelResponse.ok && baseModelResponse.body && typeof baseModelResponse.body === "object"
            ? baseModelResponse.body
            : null;
        logoModelId = baseModelId;
        logoName = normalizeValue(baseModelPayload?.name) || baseModelId;
        logoOwnedBy = normalizeValue(baseModelPayload?.owned_by) || ownedBy;
        logoModelPayload = baseModelPayload;
      }

      const brandFamily = getBrandFamily({ displayName: logoName, modelId: logoModelId, ownedBy: logoOwnedBy });
      const celestialIdentity = getCelestialIdentity({
        displayName: logoName,
        modelId: logoModelId,
        isDerivedModel: false,
      });
      const profileImageUrl =
        resolveLogoUrl(logoModelPayload?.info?.meta?.profile_image_url) ||
        resolveLogoUrl(logoModelPayload?.meta?.profile_image_url) ||
        resolveLogoUrl(logoModelPayload?.profile_image_url);

      const fallbackImageUrl = new URL("/models/model/profile/image", window.location.origin);
      fallbackImageUrl.searchParams.set("id", logoModelId);
      fallbackImageUrl.searchParams.set("lang", LANGUAGE);

      let logoDataUrl = await fetchImageDataUrl(profileImageUrl, headers);
      if (!logoDataUrl) {
        logoDataUrl = await fetchImageDataUrl(fallbackImageUrl.toString(), headers);
      }

      return {
        success: true,
        chatId: CHAT_ID,
        modelId,
        ownedBy,
        displayName,
        brandFamily,
        isDerivedModel,
        celestialIdentity,
        logoModelId,
        logoName,
        fallbackText: buildFallbackText(displayName),
        logoDataUrl,
        needsDarkBadge: brandFamily === "openai" && celestialIdentity === null,
      };
    })();
  })()`;
}

async function resolveChatWorkspaceConsentRequesterIdentityFromOwui(chatId, modalTarget = null) {
  const normalizedChatId = normalizeChatWorkspaceConsentString(chatId);
  if (!normalizedChatId || !window.electronAPI?.owui?.executeJavaScript) {
    return buildFallbackChatWorkspaceConsentRequesterIdentity();
  }

  const candidateViewKeys = getChatWorkspaceConsentOwuiViewCandidates(modalTarget);
  if (!candidateViewKeys.length) {
    return buildFallbackChatWorkspaceConsentRequesterIdentity();
  }

  const script = buildChatWorkspaceConsentRequesterResolutionScript({
    chatId: normalizedChatId,
    language: resolveChatWorkspaceConsentLanguage(),
  });

  for (const viewKey of candidateViewKeys) {
    try {
      const identity = await window.electronAPI.owui.executeJavaScript(viewKey, script);
      if (identity?.success) {
        return normalizeChatWorkspaceConsentRequesterIdentity(identity);
      }
    } catch (error) {
      console.warn(
        `[Workspace Consent] Failed to resolve requester identity from OWUI view ${viewKey}:`,
        error?.message || error,
      );
    }
  }

  return buildFallbackChatWorkspaceConsentRequesterIdentity();
}

// PORTICO-348: hydrate the given flow using ITS chat and view target, not whichever
// request happens to be presented.
async function hydrateChatWorkspaceConsentRequesterIdentity(flow) {
  const activeFlowId = normalizeChatWorkspaceConsentString(flow?.flowId);
  const chatId = normalizeChatWorkspaceConsentString(flow?.chatId);
  if (!activeFlowId || !chatId) {
    return;
  }

  const requesterIdentity = await resolveChatWorkspaceConsentRequesterIdentityFromOwui(
    chatId,
    flow.modalTarget,
  );
  // The flow may have settled while the lookup was in flight.
  if (findChatWorkspaceConsentFlowById(activeFlowId) !== flow) {
    return;
  }

  flow.requesterIdentity = requesterIdentity;
  if (flow === chatWorkspaceConsentState) {
    renderChatWorkspaceConsentRequesterHeader();
  }
}

function attachChatWorkspaceConsentModalListeners() {
  const elements = getChatWorkspaceConsentElements();
  if (elements.cancelBtn) {
    elements.cancelBtn.onclick = () => dismissChatWorkspaceConsentModal();
  }
  if (elements.closeBtn) {
    elements.closeBtn.onclick = () => dismissChatWorkspaceConsentModal();
  }
  if (elements.hideBtn) {
    elements.hideBtn.onclick = () => void hideChatWorkspaceConsentModal();
  }
  if (elements.approveBtn) {
    elements.approveBtn.onclick = () => approveChatWorkspaceConsentModal();
  }
  if (elements.openBtn) {
    elements.openBtn.onclick = () => {
      void openChatWorkspaceConsentPath();
    };
  }
  if (elements.modal) {
    elements.modal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissChatWorkspaceConsentModal();
      } else if (event.key === "Enter") {
        event.preventDefault();
        approveChatWorkspaceConsentModal();
      }
    };
  }
}

async function runChatWorkspaceConsentModal(payload = {}) {
  await loadChatWorkspaceConsentTemplate();

  const flowId = normalizeChatWorkspaceConsentString(payload?.flow_id);
  if (!flowId) {
    throw new Error("chat-workspace consent flow_id is required");
  }
  const chatId = normalizeChatWorkspaceConsentString(payload?.chat_id);
  if (!chatId) {
    throw new Error("chat-workspace consent chat_id is required");
  }
  const hostPath = normalizeChatWorkspaceConsentString(payload?.host_path);
  if (!hostPath) {
    throw new Error("chat-workspace consent host_path is required");
  }

  // PORTICO-348: only a second request for the SAME chat is a real conflict.
  const existingFlowForChat = chatWorkspaceConsentFlows.get(chatId);
  if (existingFlowForChat) {
    if (existingFlowForChat.flowId === flowId) {
      void syncChatWorkspaceConsentModalForNavigation();
      return { success: true, reusedExistingFlow: true, flow_id: flowId };
    }
    throw new Error(
      `A different chat-workspace consent flow is already active for this chat (${existingFlowForChat.flowId})`,
    );
  }

  return new Promise((resolve) => {
    const flow = createInitialChatWorkspaceConsentState({
      flowId,
      chatId,
      hostPath,
      displayPath: normalizeChatWorkspaceConsentString(payload?.display_path) || hostPath,
      preamble: normalizeChatWorkspaceConsentString(payload?.preamble),
      requesterIdentity: buildFallbackChatWorkspaceConsentRequesterIdentity(),
      modalTarget: payload?.__modalTarget || payload?.modalTarget || null,
      resolve,
    });

    const { modal } = getChatWorkspaceConsentElements();
    if (!modal) {
      throw new Error("#chat-workspace-consent-modal not found after template load");
    }
    chatWorkspaceConsentFlows.set(chatId, flow);
    attachChatWorkspaceConsentModalListeners();
    void (async () => {
      await syncChatWorkspaceConsentModalForNavigation();
      if (chatWorkspaceConsentState !== flow) {
        await suspendChatWorkspaceConsentFlowForNavigation(flow);
      }
      void hydrateChatWorkspaceConsentRequesterIdentity(flow);
    })();
  });
}

window.runChatWorkspaceConsentModal = runChatWorkspaceConsentModal;
window.closeChatWorkspaceConsentModal = closeChatWorkspaceConsentModal;
window.hideChatWorkspaceConsentModal = hideChatWorkspaceConsentModal;
// PORTICO-348: chat-tab.js switchTab() calls this so the request follows the chat.
window.syncChatWorkspaceConsentModalForNavigation = syncChatWorkspaceConsentModalForNavigation;

window.electronAPI?.onNativeInputReopenRequested?.((payload = {}) => {
  if (payload?.kind !== "chat_workspace_consent") return;
  const flow = findChatWorkspaceConsentFlowById(payload?.flow_id);
  if (!flow) return;
  flow.presentation = "visible";
  flow.hiddenByNavigation = false;
  void syncChatWorkspaceConsentModalForNavigation();
});

window.electronAPI?.onNativeInputTerminal?.((payload = {}) => {
  const flowId = normalizeChatWorkspaceConsentString(payload?.flow_id);
  if (payload?.kind !== "chat_workspace_consent" || !flowId) return;
  // PORTICO-348: settle a background request without disturbing the visible one.
  const flow = findChatWorkspaceConsentFlowById(flowId);
  if (!flow) return;
  const result = {
    success: false,
    status: normalizeChatWorkspaceConsentString(payload?.status) || "completed",
    flow_id: flowId,
  };
  if (flow === chatWorkspaceConsentState) {
    closeChatWorkspaceConsentModal({ result });
  } else {
    settleChatWorkspaceConsentFlow(flow, result);
  }
});
