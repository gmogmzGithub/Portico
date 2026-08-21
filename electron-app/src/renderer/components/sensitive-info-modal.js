const SENSITIVE_INFO_OPENAI_SHORT_CODE_PATTERN = /(^|\s)(o1|o3|o4)(?:[\s-]|$)/;
const SENSITIVE_INFO_FIXED_DISCLOSURE_TEXT =
  "It will be stored securely, automatically deleted after 15 minutes, and will not be shown in the chat or shown to the model.";
const SENSITIVE_INFO_INPUT_PLACEHOLDER =
  "Type or paste the requested information here";
const SENSITIVE_INFO_PROMPT_DISCLOSURE_PATTERNS = [
  /\s*(?:It|The value|This value|The submitted value)\s+will\s+be\s+(?:stored|saved)[^.?!]*(?:chat|model|displayed|deleted|temporary|workspace file|code execution)[^.?!]*[.?!]?\s*$/i,
  /\s*The file expires and is deleted after 15 minutes[^.?!]*[.?!]?\s*$/i,
];
const SENSITIVE_INFO_INTERNAL_PROMPT_PATTERNS = [
  /\s+for\s+use\s+in\s+(?:the\s+)?(?:code execution|Agent VM|sandbox|\/work)\b/gi,
  /\s+to\s+be\s+used\s+(?:by|in|inside|within)\s+(?:the\s+)?(?:code execution|Agent VM|sandbox|\/work)\b/gi,
  /\s+(?:for|to|in|inside|within|from|into|under)\s+(?:the\s+)?(?:code execution|Agent VM|sandbox|\/work)\b/gi,
  /\s+(?:for|to|in|inside|within|from|into)\s+(?:a\s+|the\s+)?(?:temporary\s+)?workspace file\b/gi,
  /\s+used\s+by\s+code execution\b/gi,
  /\b(?:code execution|Agent VM|sandbox|\/work|workspace file)\b/gi,
];

// PORTICO-348: every pending flow, keyed by the chat that owns it. The secure
// prompt stays a NATIVE modal (credentials must never be typed into the OWUI
// page), but it is now scoped per chat: only one flow is presented at a time --
// `sensitiveInfoState` points at that flow, the same object held here -- and a
// prompt pending in another chat neither blocks this one nor stays hidden.
const sensitiveInfoFlows = new Map();
let sensitiveInfoState = createInitialSensitiveInfoState();

function hasPresentedSensitiveInfoFlow() {
  return Boolean(sensitiveInfoState.flowId);
}

function createInitialSensitiveInfoState(overrides = {}) {
  return {
    flowId: null,
    chatId: null,
    prompt: "",
    preamble: "",
    label: "",
    placeholder: SENSITIVE_INFO_INPUT_PLACEHOLDER,
    presentation: "visible",
    // PORTICO-348: which view owns this prompt, and whether it was parked by a tab
    // switch (as opposed to the user explicitly minimizing it).
    modalTarget: null,
    hiddenByNavigation: false,
    requesterIdentity: buildFallbackSensitiveInfoRequesterIdentity(),
    visualAids: [],
    resolve: null,
    ...overrides,
  };
}

// Visual-aid images may only come from the chat workspace served by the local
// Electron API (skills_get_skill_assets download URLs) — never remote hosts.
// This mirrors the main-process allowlist in sensitive-info-flows.js as
// defense in depth; the renderer never trusts the payload.
const SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES = [
  "http://localhost:9876/workspace/",
  "http://127.0.0.1:9876/workspace/",
];

function normalizeRendererSensitiveInfoVisualAids(rawList) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const normalized = [];
  for (const item of rawList) {
    if (normalized.length >= 8) {
      break;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const step = item.step;
    const imageUrl =
      typeof item.image_url === "string" ? item.image_url.trim() : "";
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      step > 20 ||
      !imageUrl ||
      imageUrl.length > 500 ||
      !SENSITIVE_INFO_VISUAL_AID_URL_PREFIXES.some((prefix) =>
        imageUrl.startsWith(prefix),
      )
    ) {
      continue;
    }
    normalized.push({
      step,
      imageUrl,
      alt:
        typeof item.alt === "string" && item.alt.trim()
          ? item.alt.trim().slice(0, 200)
          : "",
      dataUrl: null,
      dataUrlPromise: null,
      naturalSizePromise: null,
      naturalWidth: 0,
      naturalHeight: 0,
      loadFailed: false,
    });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Chat ownership: chat_id is the durable owner. Tabs and view keys are
// presentation details that can change while a prompt is pending.
// ---------------------------------------------------------------------------

function normalizeSensitiveInfoModalTarget(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const target = {
    viewKey: normalizeSensitiveInfoString(value.viewKey) || null,
    conversationId: normalizeSensitiveInfoString(value.conversationId) || null,
    windowType: normalizeSensitiveInfoString(value.windowType) || null,
  };
  return target.viewKey || target.conversationId || target.windowType ? target : null;
}

function extractSensitiveInfoChatIdFromUrl(value) {
  const raw = normalizeSensitiveInfoString(value);
  if (!raw || raw === "about:blank") {
    return null;
  }
  try {
    const url = new URL(raw, "http://localhost:3789");
    const match = url.pathname.replace(/\/+$/, "").match(/^\/c\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function getSensitiveInfoOwnerElement(target) {
  const normalizedTarget = normalizeSensitiveInfoModalTarget(target);
  if (!normalizedTarget) {
    return null;
  }
  const conversationId = normalizedTarget.conversationId;
  if (conversationId && conversationId !== "chat") {
    const element = document.getElementById(`conversation-webview-${conversationId}`);
    if (element) return element;
  }
  if (normalizedTarget.viewKey?.startsWith("conversation:")) {
    const targetId = normalizeSensitiveInfoString(
      normalizedTarget.viewKey.slice("conversation:".length),
    );
    const element = targetId
      ? document.getElementById(`conversation-webview-${targetId}`)
      : null;
    if (element) return element;
  }
  return document.getElementById("chat-webview");
}

function getActiveSensitiveInfoOwnerElement(flow = sensitiveInfoState) {
  if (!document.getElementById("tab-strip")) {
    return (
      getSensitiveInfoOwnerElement(flow?.modalTarget) ||
      document.getElementById("chat-webview") ||
      document.getElementById("conversation-webview") ||
      document.querySelector?.('[data-owui-host="true"]') ||
      null
    );
  }
  const activeTab = normalizeSensitiveInfoString(window.appState?.activeTab);
  if (activeTab === "chat") {
    return document.getElementById("chat-webview");
  }
  if (activeTab.startsWith("conversation-")) {
    const conversationId = normalizeSensitiveInfoString(
      activeTab.slice("conversation-".length),
    );
    return conversationId
      ? document.getElementById(`conversation-webview-${conversationId}`)
      : null;
  }
  return null;
}

function doesSensitiveInfoOwnerDisplayChat(flow = sensitiveInfoState) {
  if (!flow?.chatId) {
    return false;
  }
  const ownerElement = getActiveSensitiveInfoOwnerElement(flow);
  if (!ownerElement || typeof ownerElement.getCommittedURL !== "function") {
    return false;
  }
  try {
    return extractSensitiveInfoChatIdFromUrl(ownerElement.getCommittedURL()) === flow.chatId;
  } catch (_) {
    return false;
  }
}

function getPendingSensitiveInfoFlowForActiveChat() {
  for (const flow of sensitiveInfoFlows.values()) {
    if (doesSensitiveInfoOwnerDisplayChat(flow)) {
      return flow;
    }
  }
  return null;
}

function bindPresentedSensitiveInfoFlow(flow) {
  sensitiveInfoState = flow || createInitialSensitiveInfoState();
  return sensitiveInfoState;
}

function forgetSensitiveInfoFlow(flow) {
  if (!flow) return;
  const chatId = normalizeSensitiveInfoString(flow.chatId);
  if (chatId && sensitiveInfoFlows.get(chatId) === flow) {
    sensitiveInfoFlows.delete(chatId);
  }
  if (sensitiveInfoState === flow) {
    bindPresentedSensitiveInfoFlow(null);
  }
}

function findSensitiveInfoFlowById(flowId) {
  const normalized = normalizeSensitiveInfoString(flowId);
  if (!normalized) return null;
  if (sensitiveInfoState.flowId === normalized) return sensitiveInfoState;
  for (const flow of sensitiveInfoFlows.values()) {
    if (flow.flowId === normalized) return flow;
  }
  return null;
}

// Park a flow that is not on screen without touching the shared modal.
async function suspendSensitiveInfoFlowForNavigation(flow) {
  if (!flow?.flowId) return false;
  flow.presentation = "hidden";
  flow.hiddenByNavigation = true;
  const setPresentation = window.electronAPI?.setNativeInputPresentation;
  if (typeof setPresentation !== "function") return false;
  try {
    const result = await setPresentation({
      kind: "sensitive_info",
      flow_id: flow.flowId,
      presentation: "hidden",
    });
    return Boolean(result?.success);
  } catch (error) {
    console.error("[Sensitive Info] Failed to suspend background prompt:", error);
    return false;
  }
}

// The active chat decides which pending prompt the shared modal shows.
async function syncSensitiveInfoModalForNavigation() {
  const nextFlow = getPendingSensitiveInfoFlowForActiveChat();
  if (hasPresentedSensitiveInfoFlow() && sensitiveInfoState !== nextFlow) {
    await hideSensitiveInfoModal({ navigation: true });
    bindPresentedSensitiveInfoFlow(null);
  }
  if (nextFlow && sensitiveInfoState !== nextFlow) {
    bindPresentedSensitiveInfoFlow(nextFlow);
  }
  if (!hasPresentedSensitiveInfoFlow()) {
    return false;
  }
  // An explicit Hide must stay hidden; only navigation-parked prompts restore.
  if (sensitiveInfoState.presentation === "hidden" && !sensitiveInfoState.hiddenByNavigation) {
    return false;
  }
  sensitiveInfoState.hiddenByNavigation = false;
  return showSensitiveInfoModal();
}

function buildFallbackSensitiveInfoRequesterIdentity(overrides = {}) {
  return {
    displayName: "This chat",
    fallbackText: "AI",
    logoDataUrl: null,
    needsDarkBadge: false,
    ...overrides,
  };
}

function normalizeSensitiveInfoString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildSensitiveInfoFallbackText(value) {
  const normalized = normalizeSensitiveInfoString(value);
  if (!normalized) {
    return "AI";
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }
  return normalized.slice(0, 2).toUpperCase();
}

function stripSensitiveInfoPromptDisclosure(prompt) {
  let cleaned = normalizeSensitiveInfoString(prompt).replace(/\s+/g, " ");
  let changed = true;

  while (changed) {
    changed = false;
    for (const pattern of SENSITIVE_INFO_PROMPT_DISCLOSURE_PATTERNS) {
      const next = cleaned.replace(pattern, "").trim();
      if (next !== cleaned) {
        cleaned = next;
        changed = true;
      }
    }
  }

  return cleaned;
}

function stripSensitiveInfoInternalPromptText(prompt) {
  let cleaned = normalizeSensitiveInfoString(prompt).replace(/\s+/g, " ");
  for (const pattern of SENSITIVE_INFO_INTERNAL_PROMPT_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned
    .replace(/\s+([.,?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildSensitiveInfoFallbackPrompt(label) {
  const labelText = normalizeSensitiveInfoString(label) || "the requested sensitive value";
  return `Please enter ${labelText}.`;
}

function buildSensitiveInfoDisplayPrompt(prompt, label) {
  return (
    stripSensitiveInfoInternalPromptText(stripSensitiveInfoPromptDisclosure(prompt)) ||
    buildSensitiveInfoFallbackPrompt(label)
  );
}

function getSensitiveInfoBrandFamily(identity = {}) {
  const haystack = [
    normalizeSensitiveInfoString(identity.displayName),
    normalizeSensitiveInfoString(identity.modelId),
    normalizeSensitiveInfoString(identity.ownedBy),
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
    SENSITIVE_INFO_OPENAI_SHORT_CODE_PATTERN.test(haystack)
  ) {
    return "openai";
  }

  return "other";
}

function resolveSensitiveInfoCelestialIdentity(identity = {}) {
  if (Boolean(identity.isDerivedModel)) {
    return null;
  }

  const identifiers = [
    normalizeSensitiveInfoString(identity.modelId),
    normalizeSensitiveInfoString(identity.displayName),
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

function sensitiveInfoNeedsDarkLogoBadge(identity = {}) {
  return (
    getSensitiveInfoBrandFamily(identity) === "openai" &&
    resolveSensitiveInfoCelestialIdentity(identity) === null
  );
}

function normalizeResolvedSensitiveInfoRequesterIdentity(identity = {}) {
  const displayName =
    normalizeSensitiveInfoString(identity.displayName) ||
    normalizeSensitiveInfoString(identity.modelId) ||
    "This chat";
  const logoDataUrl = normalizeSensitiveInfoString(identity.logoDataUrl) || null;
  const isDerivedModel = Boolean(identity.isDerivedModel);
  // Trust the base-derived celestial identity the resolver already computed (for
  // agents it resolves the base model); only re-derive when absent (fallbacks).
  const providedCelestial = normalizeSensitiveInfoString(identity.celestialIdentity);
  const celestialIdentity =
    providedCelestial === "sol" || providedCelestial === "terra" || providedCelestial === "luna"
      ? providedCelestial
      : resolveSensitiveInfoCelestialIdentity({ ...identity, displayName, isDerivedModel });

  return {
    displayName,
    modelId: normalizeSensitiveInfoString(identity.modelId) || null,
    ownedBy: normalizeSensitiveInfoString(identity.ownedBy) || null,
    brandFamily:
      normalizeSensitiveInfoString(identity.brandFamily) ||
      getSensitiveInfoBrandFamily(identity),
    fallbackText:
      normalizeSensitiveInfoString(identity.fallbackText) ||
      buildSensitiveInfoFallbackText(displayName),
    logoDataUrl,
    // Base-model identity for the animated badge (agent → base model logo).
    logoModelId: normalizeSensitiveInfoString(identity.logoModelId) || normalizeSensitiveInfoString(identity.modelId) || null,
    logoName: normalizeSensitiveInfoString(identity.logoName) || displayName,
    isDerivedModel,
    celestialIdentity,
    isCelestialLogo: Boolean(celestialIdentity && logoDataUrl),
    needsDarkBadge:
      celestialIdentity === null &&
      (Boolean(identity.needsDarkBadge) || sensitiveInfoNeedsDarkLogoBadge(identity)),
  };
}

async function loadSensitiveInfoTemplate() {
  if (document.getElementById("sensitive-info-modal")) {
    return;
  }
  const container = document.getElementById("sensitive-info-container");
  if (!container) {
    throw new Error("Container #sensitive-info-container not found");
  }
  const response = await fetch("renderer/components/sensitive-info-modal.html");
  container.innerHTML = await response.text();
}

function getSensitiveInfoElements() {
  return {
    modal: document.getElementById("sensitive-info-modal"),
    titleText: document.getElementById("sensitive-info-title"),
    titleLogoBadge: document.getElementById("sensitive-info-title-logo-badge"),
    titleLogo: document.getElementById("sensitive-info-title-logo"),
    titleLogoFallback: document.getElementById("sensitive-info-title-logo-fallback"),
    headerTag: document.getElementById("sensitive-info-header-tag"),
    preamble: document.getElementById("sensitive-info-preamble"),
    prompt: document.getElementById("sensitive-info-prompt"),
    disclosure: document.getElementById("sensitive-info-disclosure"),
    label: document.getElementById("sensitive-info-label"),
    input: document.getElementById("sensitive-info-input"),
    submitBtn: document.getElementById("sensitive-info-submit-btn"),
    cancelBtn: document.getElementById("sensitive-info-cancel-btn"),
    hideBtn: document.getElementById("sensitive-info-hide-btn"),
    closeBtn: document.getElementById("sensitive-info-close-btn"),
  };
}

function setSensitiveInfoInteractionSuppressed(suppressed) {
  window.setOwuiInteractionSuppressed?.("sensitive-info-modal", suppressed);
  window.setNativeOverlayInteractionSuppressed?.("sensitive-info-modal", suppressed);
}

function buildSensitiveInfoLogoBadgeIdentity(identity) {
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

function renderSensitiveInfoRequesterHeader() {
  const elements = getSensitiveInfoElements();
  const identity = normalizeResolvedSensitiveInfoRequesterIdentity(
    sensitiveInfoState.requesterIdentity,
  );
  const hasLogoImage = Boolean(identity.logoDataUrl);

  if (elements.titleText) {
    elements.titleText.textContent = "Sensitive information requested";
  }

  // Animated model-logo badge (base model when the chat is an agent), matching
  // the inline chat logo. Falls back to the legacy static image if the shared
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
      buildSensitiveInfoLogoBadgeIdentity(identity),
      { seed: identity.logoModelId || sensitiveInfoState.chatId || "sensitive-info" },
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
        if (elements.titleLogoBadge) {
          elements.titleLogoBadge.classList.remove("has-logo-image");
          elements.titleLogoBadge.classList.remove("celestial-logo");
        }
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

function renderSensitiveInfoModal() {
  const elements = getSensitiveInfoElements();
  renderSensitiveInfoRequesterHeader();
  if (elements.headerTag) {
    elements.headerTag.textContent = "Sensitive info";
  }
  if (elements.preamble) {
    const renderer = window.safeModalMarkdownRenderer || window.sensitiveInfoMarkdownRenderer;
    if (renderer?.renderSafeModalPreamble) {
      renderer.renderSafeModalPreamble(
        elements.preamble,
        sensitiveInfoState.preamble,
      );
    } else {
      elements.preamble.replaceChildren();
      elements.preamble.hidden = !sensitiveInfoState.preamble;
      if (sensitiveInfoState.preamble) {
        elements.preamble.textContent = sensitiveInfoState.preamble;
      }
    }
    decorateSensitiveInfoPreambleVisualAids();
  }
  elements.prompt.textContent = buildSensitiveInfoDisplayPrompt(
    sensitiveInfoState.prompt,
    sensitiveInfoState.label,
  );
  if (elements.disclosure) {
    elements.disclosure.textContent = SENSITIVE_INFO_FIXED_DISCLOSURE_TEXT;
  }
  elements.label.textContent = sensitiveInfoState.label || "Sensitive value";
  elements.input.placeholder = SENSITIVE_INFO_INPUT_PLACEHOLDER;
  elements.submitBtn.disabled = elements.input.value.length === 0;
}

// PORTICO-348: settle a specific flow and drop it from the pending map. Callers
// pass the flow explicitly because it can terminate while another chat's
// prompt is the one on screen.
function settleSensitiveInfoFlow(flow, result) {
  if (typeof flow?.resolve === "function") {
    flow.resolve(result);
  }
  forgetSensitiveInfoFlow(flow);
}

const SENSITIVE_INFO_MAGNIFIER_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="11" cy="11" r="7"></circle>' +
  '<line x1="21" y1="21" x2="16" y2="16"></line>' +
  '<line x1="11" y1="8" x2="11" y2="14"></line>' +
  '<line x1="8" y1="11" x2="14" y2="11"></line>' +
  "</svg>";

let sensitiveInfoVisualAidTooltip = null;
let sensitiveInfoVisualAidShowToken = null;

// Retina (2x) skill screenshots wider than this render unreadably small in the
// default 380px tooltip, so they get the --large size-adaptive variant.
const SENSITIVE_INFO_VISUAL_AID_LARGE_MIN_NATURAL_WIDTH = 600;

async function fetchSensitiveInfoVisualAidDataUrl(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("Visual aid is not an image");
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read visual aid image"));
    reader.readAsDataURL(blob);
  });
}

function measureSensitiveInfoVisualAidNaturalSize(dataUrl) {
  return new Promise((resolve) => {
    if (typeof Image !== "function") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || 0,
        height: image.naturalHeight || 0,
      });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

// Fire-and-forget preload kicked off at decoration time: warms the data-URL
// cache so hover is instant, captures natural dimensions for the
// size-adaptive tooltip, and removes the magnifier for screenshots that can
// never load (instead of leaving a permanently dead-looking icon). No timers —
// a single fetch per aid, cached on the aid across re-renders.
function preloadSensitiveInfoVisualAid(aid, button) {
  if (!aid.dataUrlPromise) {
    aid.dataUrlPromise = fetchSensitiveInfoVisualAidDataUrl(aid.imageUrl);
  }
  aid.dataUrlPromise
    .then((dataUrl) => {
      aid.dataUrl = dataUrl;
      if (!aid.naturalSizePromise) {
        aid.naturalSizePromise = measureSensitiveInfoVisualAidNaturalSize(
          dataUrl,
        ).then((size) => {
          aid.naturalWidth = size?.width || 0;
          aid.naturalHeight = size?.height || 0;
        });
      }
      return aid.naturalSizePromise;
    })
    .catch((error) => {
      if (!aid.loadFailed) {
        aid.loadFailed = true;
        console.warn("[Sensitive Info] Failed to load visual aid image:", error);
      }
      // The modal may have been re-rendered mid-flight; a detached button
      // needs no cleanup.
      if (button.isConnected) {
        button.remove();
      }
    });
}

function ensureSensitiveInfoVisualAidTooltip() {
  const { modal } = getSensitiveInfoElements();
  if (!modal) {
    return null;
  }
  if (
    sensitiveInfoVisualAidTooltip &&
    modal.contains(sensitiveInfoVisualAidTooltip)
  ) {
    return sensitiveInfoVisualAidTooltip;
  }
  const tooltip = document.createElement("div");
  tooltip.className = "sensitive-info-visual-aid-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  tooltip.appendChild(document.createElement("img"));
  modal.appendChild(tooltip);
  sensitiveInfoVisualAidTooltip = tooltip;
  return tooltip;
}

function positionSensitiveInfoVisualAidTooltip(button) {
  const tooltip = sensitiveInfoVisualAidTooltip;
  if (!tooltip || tooltip.hidden || !button.isConnected) {
    return;
  }
  const margin = 12;
  const rect = button.getBoundingClientRect();
  // The tooltip always opens to the RIGHT of its magnifier. When the window
  // leaves too little room there, the tooltip shrinks (the img scales with
  // max-width:100%) instead of flipping to the left side. The fit constraint
  // joins the CSS min() caps via --sensitive-info-aid-fit so the base/--large
  // maximums keep applying on wide windows.
  const available = window.innerWidth - rect.right - 10 - margin;
  tooltip.style.setProperty(
    "--sensitive-info-aid-fit",
    `${Math.max(160, available)}px`,
  );
  const tipRect = tooltip.getBoundingClientRect();
  // Right of the icon whenever it fits; in the degenerate case (icon within
  // ~160px of the window edge) slide just far enough left to stay fully
  // on-screen — never flipped to the icon's left side.
  const left = Math.max(
    margin,
    Math.min(rect.right + 10, window.innerWidth - tipRect.width - margin),
  );
  const top = Math.max(
    margin,
    Math.min(rect.top - 8, window.innerHeight - tipRect.height - margin),
  );
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideSensitiveInfoVisualAidTooltip() {
  sensitiveInfoVisualAidShowToken = null;
  if (sensitiveInfoVisualAidTooltip) {
    sensitiveInfoVisualAidTooltip.hidden = true;
  }
}

async function showSensitiveInfoVisualAidTooltip(button, aid) {
  const tooltip = ensureSensitiveInfoVisualAidTooltip();
  if (!tooltip) {
    return;
  }
  const showToken = {};
  sensitiveInfoVisualAidShowToken = showToken;
  if (!aid.dataUrl) {
    if (!aid.dataUrlPromise) {
      aid.dataUrlPromise = fetchSensitiveInfoVisualAidDataUrl(
        aid.imageUrl,
      ).catch((error) => {
        aid.dataUrlPromise = null;
        throw error;
      });
    }
    try {
      aid.dataUrl = await aid.dataUrlPromise;
    } catch (error) {
      console.warn("[Sensitive Info] Failed to load visual aid image:", error);
      return;
    }
  }
  if (sensitiveInfoVisualAidShowToken !== showToken) {
    return;
  }
  const image = tooltip.querySelector("img");
  // Size-adapt BEFORE setting the image and positioning: the tooltip element
  // is shared across aids, so always drop the class first, then re-add it for
  // large captures so the first layout pass already uses the enlarged bounds.
  tooltip.classList.remove("sensitive-info-visual-aid-tooltip--large");
  if (
    (aid.naturalWidth || 0) > SENSITIVE_INFO_VISUAL_AID_LARGE_MIN_NATURAL_WIDTH
  ) {
    tooltip.classList.add("sensitive-info-visual-aid-tooltip--large");
  }
  // The <img> is shared across aids: drop any previous hover's onload before
  // assigning the new src, and token-guard the deferred repositions so a
  // stale callback can never re-anchor the tooltip to an earlier magnifier.
  image.onload = null;
  image.src = aid.dataUrl;
  image.alt = aid.alt || `Screenshot for step ${aid.step}`;
  tooltip.hidden = false;
  positionSensitiveInfoVisualAidTooltip(button);
  const repositionIfCurrent = () => {
    if (sensitiveInfoVisualAidShowToken === showToken) {
      positionSensitiveInfoVisualAidTooltip(button);
    }
  };
  if (image.complete) {
    // Cached data-URL src can complete synchronously; re-clamp the enlarged
    // tooltip once layout has applied the class + image dimensions.
    requestAnimationFrame(repositionIfCurrent);
  } else {
    image.onload = repositionIfCurrent;
  }
}

function decorateSensitiveInfoPreambleVisualAids() {
  hideSensitiveInfoVisualAidTooltip();
  const elements = getSensitiveInfoElements();
  const preambleEl = elements.preamble;
  const visualAids = sensitiveInfoState.visualAids;
  if (
    !preambleEl ||
    preambleEl.hidden ||
    !Array.isArray(visualAids) ||
    visualAids.length === 0
  ) {
    return;
  }
  const orderedList = preambleEl.querySelector("ol");
  if (!orderedList) {
    return;
  }
  const steps = Array.from(orderedList.children).filter(
    (node) => node.tagName === "LI",
  );
  for (const aid of visualAids) {
    const step = steps[aid.step - 1];
    // Skip aids whose image already failed to preload — re-creating their
    // magnifier would only get removed again (and would re-fetch on every
    // re-render, e.g. each input keystroke).
    if (!step || aid.loadFailed || step.querySelector(".sensitive-info-visual-aid")) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sensitive-info-visual-aid";
    button.setAttribute("aria-label", `Show screenshot for step ${aid.step}`);
    button.innerHTML = SENSITIVE_INFO_MAGNIFIER_SVG;
    button.addEventListener("mouseenter", () =>
      void showSensitiveInfoVisualAidTooltip(button, aid),
    );
    button.addEventListener("focus", () =>
      void showSensitiveInfoVisualAidTooltip(button, aid),
    );
    button.addEventListener("mouseleave", hideSensitiveInfoVisualAidTooltip);
    button.addEventListener("blur", hideSensitiveInfoVisualAidTooltip);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        hideSensitiveInfoVisualAidTooltip();
      }
    });
    // Append inside the step's trailing paragraph when the safe renderer
    // wrapped the text in one, so the icon sits to the right of the step text
    // instead of wrapping onto its own line.
    const inlineHost = step.querySelector(":scope > p:last-of-type") || step;
    inlineHost.appendChild(button);
    // Preload immediately (fire-and-forget): hover then hits the cache, and
    // unloadable screenshots remove their magnifier instead of playing dead.
    preloadSensitiveInfoVisualAid(aid, button);
  }
}

function showSensitiveInfoModal() {
  if (!hasPresentedSensitiveInfoFlow()) {
    return false;
  }
  const { modal, input } = getSensitiveInfoElements();
  if (!modal) {
    return false;
  }
  sensitiveInfoState.presentation = "visible";
  sensitiveInfoState.hiddenByNavigation = false;
  renderSensitiveInfoModal();
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  setSensitiveInfoInteractionSuppressed(true);
  setTimeout(() => input?.focus(), 0);
  return true;
}

async function hideSensitiveInfoModal(options = {}) {
  if (!hasPresentedSensitiveInfoFlow()) {
    return false;
  }
  const navigation = options.navigation === true;
  const setPresentation = window.electronAPI?.setNativeInputPresentation;
  if (typeof setPresentation !== "function") {
    return false;
  }

  const { modal } = getSensitiveInfoElements();
  hideSensitiveInfoVisualAidTooltip();
  modal?.classList.remove("visible");
  modal?.setAttribute("aria-hidden", "true");
  setSensitiveInfoInteractionSuppressed(false);
  sensitiveInfoState.presentation = "hidden";
  sensitiveInfoState.hiddenByNavigation = navigation;

  try {
    const result = await setPresentation({
      kind: "sensitive_info",
      flow_id: sensitiveInfoState.flowId,
      presentation: "hidden",
    });
    if (!result?.success) {
      throw new Error(result?.error || "Failed to hide secure request");
    }
    return true;
  } catch (error) {
    console.error("[Sensitive Info] Failed to hide modal:", error);
    if (!navigation) {
      showSensitiveInfoModal();
    }
    return false;
  }
}

function closeSensitiveInfoModal(options = {}) {
  const { modal, input } = getSensitiveInfoElements();
  hideSensitiveInfoVisualAidTooltip();
  if (input) {
    input.value = "";
  }
  if (modal) {
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
  }
  setSensitiveInfoInteractionSuppressed(false);
  // PORTICO-348: settle and forget only this flow; other chats keep theirs, and the
  // active chat's next pending prompt is presented right away.
  settleSensitiveInfoFlow(options.flow || sensitiveInfoState, options.result || null);
  void syncSensitiveInfoModalForNavigation();
}

function dismissSensitiveInfoModal() {
  if (sensitiveInfoState.flowId) {
    window.electronAPI?.notifySensitiveInfoCompleted?.({
      flow_id: sensitiveInfoState.flowId,
      action: "dismissed",
    });
  }
  closeSensitiveInfoModal({
    result: {
      action: "dismissed",
    },
  });
}

function submitSensitiveInfoValue() {
  const { input } = getSensitiveInfoElements();
  const sensitiveValue = input?.value || "";
  if (!sensitiveValue.length) {
    renderSensitiveInfoModal();
    return;
  }
  const result = {
    action: "submitted",
  };
  window.electronAPI?.notifySensitiveInfoCompleted?.({
    flow_id: sensitiveInfoState.flowId,
    action: "submitted",
    sensitive_value: sensitiveValue,
  });
  closeSensitiveInfoModal({ result });
}

function attachSensitiveInfoModalListeners() {
  const elements = getSensitiveInfoElements();
  if (elements.cancelBtn) {
    elements.cancelBtn.onclick = () => dismissSensitiveInfoModal();
  }
  if (elements.closeBtn) {
    elements.closeBtn.onclick = () => dismissSensitiveInfoModal();
  }
  if (elements.hideBtn) {
    elements.hideBtn.onclick = () => void hideSensitiveInfoModal();
  }
  if (elements.submitBtn) {
    elements.submitBtn.onclick = () => submitSensitiveInfoValue();
  }
  if (elements.input) {
    elements.input.oninput = () => renderSensitiveInfoModal();
    elements.input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitSensitiveInfoValue();
      } else if (event.key === "Escape") {
        event.preventDefault();
        dismissSensitiveInfoModal();
      }
    };
  }
}

function resolveSensitiveInfoLanguage() {
  const documentLanguage = normalizeSensitiveInfoString(document.documentElement?.lang);
  if (documentLanguage) {
    return documentLanguage;
  }
  const navigatorLanguage = normalizeSensitiveInfoString(navigator.language);
  return navigatorLanguage || "en";
}

// PORTICO-348: `flow` seeds the preferred view key so a prompt pending in a
// background chat resolves identity against its own view.
function getSensitiveInfoOwuiViewCandidates(flow = sensitiveInfoState) {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeSensitiveInfoString(value);
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

  pushCandidate(flow?.modalTarget?.viewKey);

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

function buildSensitiveInfoRequesterResolutionScript({ chatId, language }) {
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

async function resolveSensitiveInfoRequesterIdentityFromOwui(chatId, flow) {
  const normalizedChatId = normalizeSensitiveInfoString(chatId);
  if (!normalizedChatId || !window.electronAPI?.owui?.executeJavaScript) {
    return buildFallbackSensitiveInfoRequesterIdentity();
  }

  const candidateViewKeys = getSensitiveInfoOwuiViewCandidates(flow);
  if (!candidateViewKeys.length) {
    return buildFallbackSensitiveInfoRequesterIdentity();
  }

  const script = buildSensitiveInfoRequesterResolutionScript({
    chatId: normalizedChatId,
    language: resolveSensitiveInfoLanguage(),
  });

  for (const viewKey of candidateViewKeys) {
    try {
      const identity = await window.electronAPI.owui.executeJavaScript(viewKey, script);
      if (identity?.success) {
        return normalizeResolvedSensitiveInfoRequesterIdentity(identity);
      }
    } catch (error) {
      console.warn(
        `[Sensitive Info] Failed to resolve requester identity from OWUI view ${viewKey}:`,
        error?.message || error,
      );
    }
  }

  return buildFallbackSensitiveInfoRequesterIdentity();
}

// PORTICO-348: hydrate the given flow using ITS chat, not whichever is presented.
async function hydrateSensitiveInfoRequesterIdentity(flow) {
  const activeFlowId = normalizeSensitiveInfoString(flow?.flowId);
  const chatId = normalizeSensitiveInfoString(flow?.chatId);
  if (!activeFlowId || !chatId) {
    return;
  }

  const requesterIdentity = await resolveSensitiveInfoRequesterIdentityFromOwui(chatId, flow);
  // The flow may have settled while the lookup was in flight.
  if (findSensitiveInfoFlowById(activeFlowId) !== flow) {
    return;
  }

  flow.requesterIdentity = requesterIdentity;
  if (flow === sensitiveInfoState) {
    renderSensitiveInfoRequesterHeader();
  }
}

async function runSensitiveInfoModal(payload = {}) {
  await loadSensitiveInfoTemplate();

  const flowId = normalizeSensitiveInfoString(payload?.flow_id);
  if (!flowId) {
    throw new Error("sensitive-info flow_id is required");
  }
  const chatId = normalizeSensitiveInfoString(payload?.chat_id);
  if (!chatId) {
    throw new Error("sensitive-info chat_id is required");
  }
  const prompt = normalizeSensitiveInfoString(payload?.prompt);
  if (!prompt) {
    throw new Error("sensitive-info prompt is required");
  }

  // PORTICO-348: a re-delivery of this chat's own flow just re-syncs; only a second
  // flow for the SAME chat is a real conflict. A prompt in another chat must
  // never reject this one.
  const existingFlowForChat = sensitiveInfoFlows.get(chatId);
  if (existingFlowForChat) {
    if (existingFlowForChat.flowId === flowId) {
      void syncSensitiveInfoModalForNavigation();
      return { success: true, reusedExistingFlow: true, flow_id: flowId };
    }
    throw new Error(
      `A different sensitive-info flow is already active for this chat (${existingFlowForChat.flowId})`,
    );
  }

  return new Promise((resolve) => {
    const flow = createInitialSensitiveInfoState({
      flowId,
      chatId,
      modalTarget: normalizeSensitiveInfoModalTarget(payload.__modalTarget),
      prompt,
      preamble: normalizeSensitiveInfoString(payload?.preamble),
      label: normalizeSensitiveInfoString(payload?.label) || "Sensitive value",
      placeholder:
        normalizeSensitiveInfoString(payload?.placeholder) || "Paste the sensitive value",
      requesterIdentity: buildFallbackSensitiveInfoRequesterIdentity(),
      visualAids: normalizeRendererSensitiveInfoVisualAids(payload?.visual_aids),
      resolve,
    });

    const { modal } = getSensitiveInfoElements();
    if (!modal) {
      throw new Error("#sensitive-info-modal not found after template load");
    }
    sensitiveInfoFlows.set(chatId, flow);
    attachSensitiveInfoModalListeners();
    // Presents only if this chat is on screen; otherwise the prompt waits in the
    // map (reported hidden) until the user activates its chat.
    void (async () => {
      await syncSensitiveInfoModalForNavigation();
      if (sensitiveInfoState !== flow) {
        await suspendSensitiveInfoFlowForNavigation(flow);
      }
      void hydrateSensitiveInfoRequesterIdentity(flow);
    })();
  });
}

window.runSensitiveInfoModal = runSensitiveInfoModal;
window.closeSensitiveInfoModal = closeSensitiveInfoModal;
window.hideSensitiveInfoModal = hideSensitiveInfoModal;
// PORTICO-348: chat-tab.js switchTab() calls this so the prompt follows the chat.
window.syncSensitiveInfoModalForNavigation = syncSensitiveInfoModalForNavigation;

window.electronAPI?.onNativeInputReopenRequested?.((payload = {}) => {
  if (payload?.kind !== "sensitive_info") return;
  const flow = findSensitiveInfoFlowById(payload?.flow_id);
  if (!flow) return;
  // Mark it visible; it is presented once its own chat is active.
  flow.presentation = "visible";
  flow.hiddenByNavigation = false;
  void syncSensitiveInfoModalForNavigation();
});

window.electronAPI?.onNativeInputTerminal?.((payload = {}) => {
  const flowId = normalizeSensitiveInfoString(payload?.flow_id);
  if (payload?.kind !== "sensitive_info" || !flowId) {
    return;
  }
  // PORTICO-348: a prompt can terminate while another chat's modal is on screen, so
  // resolve by id and settle a background flow without disturbing the visible one.
  const flow = findSensitiveInfoFlowById(flowId);
  if (!flow) return;
  const result = {
    success: false,
    status: normalizeSensitiveInfoString(payload?.status) || "completed",
    flow_id: flowId,
  };
  if (flow === sensitiveInfoState) {
    closeSensitiveInfoModal({ result });
  } else {
    settleSensitiveInfoFlow(flow, result);
  }
});
