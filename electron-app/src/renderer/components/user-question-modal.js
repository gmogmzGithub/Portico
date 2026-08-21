const USER_QUESTION_OPENAI_SHORT_CODE_PATTERN = /(^|\s)(o1|o3|o4)(?:[\s-]|$)/;
const USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID = "none_of_the_above";

let userQuestionTemplateLoaded = false;
let userQuestionFlowInProgress = false;
let userQuestionState = createInitialUserQuestionState();

function createInitialUserQuestionState(overrides = {}) {
  return {
    flowId: null,
    chatId: null,
    questions: [],
    currentIndex: 0,
    answersByQuestionId: {},
    requesterIdentity: buildFallbackRequesterIdentity(),
    resolveFlow: null,
    launchSource: "manual",
    presentation: "visible",
    ...overrides,
  };
}

function buildFallbackRequesterIdentity(overrides = {}) {
  return {
    displayName: "This chat",
    fallbackText: "AI",
    logoDataUrl: null,
    needsDarkBadge: false,
    ...overrides,
  };
}

function escapeUserQuestionHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeUserQuestionString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildUserQuestionFallbackText(value) {
  const normalized = normalizeUserQuestionString(value);
  if (!normalized) {
    return "AI";
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }
  return normalized.slice(0, 2).toUpperCase();
}

function getUserQuestionBrandFamily(identity = {}) {
  const haystack = [
    normalizeUserQuestionString(identity.displayName),
    normalizeUserQuestionString(identity.modelId),
    normalizeUserQuestionString(identity.ownedBy),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) {
    return "other";
  }

  if (haystack.includes("claude") || haystack.includes("anthropic")) {
    return "claude";
  }

  if (
    haystack.includes("openai") ||
    haystack.includes("chatgpt") ||
    haystack.includes("gpt") ||
    USER_QUESTION_OPENAI_SHORT_CODE_PATTERN.test(haystack)
  ) {
    return "openai";
  }

  return "other";
}

function resolveUserQuestionCelestialIdentity(identity = {}) {
  if (Boolean(identity.isDerivedModel)) {
    return null;
  }

  const identifiers = [
    normalizeUserQuestionString(identity.modelId),
    normalizeUserQuestionString(identity.displayName),
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

function userQuestionNeedsDarkLogoBadge(identity = {}) {
  return (
    getUserQuestionBrandFamily(identity) === "openai" &&
    resolveUserQuestionCelestialIdentity(identity) === null
  );
}

function normalizeResolvedRequesterIdentity(identity = {}) {
  const displayName =
    normalizeUserQuestionString(identity.displayName) ||
    normalizeUserQuestionString(identity.modelId) ||
    "This chat";
  const logoDataUrl = normalizeUserQuestionString(identity.logoDataUrl) || null;
  const isDerivedModel = Boolean(identity.isDerivedModel);
  const celestialIdentity = resolveUserQuestionCelestialIdentity({
    ...identity,
    displayName,
    isDerivedModel,
  });

  return {
    displayName,
    modelId: normalizeUserQuestionString(identity.modelId) || null,
    ownedBy: normalizeUserQuestionString(identity.ownedBy) || null,
    brandFamily:
      normalizeUserQuestionString(identity.brandFamily) || getUserQuestionBrandFamily(identity),
    fallbackText:
      normalizeUserQuestionString(identity.fallbackText) ||
      buildUserQuestionFallbackText(displayName),
    logoDataUrl,
    isDerivedModel,
    celestialIdentity,
    isCelestialLogo: Boolean(celestialIdentity && logoDataUrl),
    needsDarkBadge:
      celestialIdentity === null &&
      (Boolean(identity.needsDarkBadge) || userQuestionNeedsDarkLogoBadge(identity)),
  };
}

async function loadUserQuestionTemplate() {
  if (userQuestionTemplateLoaded) {
    return;
  }

  const container = document.getElementById("user-question-container");
  if (!container) {
    throw new Error("Container #user-question-container not found");
  }

  const response = await fetch("renderer/components/user-question-modal.html");
  const html = await response.text();
  container.innerHTML = html;
  userQuestionTemplateLoaded = true;
}

function getUserQuestionElements() {
  return {
    modal: document.getElementById("user-question-modal"),
    titleText: document.getElementById("user-question-title-text"),
    titleLogoBadge: document.getElementById("user-question-title-logo-badge"),
    titleLogo: document.getElementById("user-question-title-logo"),
    titleLogoFallback: document.getElementById("user-question-title-logo-fallback"),
    headerTag: document.getElementById("user-question-header-tag"),
    progressText: document.getElementById("user-question-progress-text"),
    stepIndicators: document.getElementById("user-question-step-indicators"),
    prompt: document.getElementById("user-question-prompt"),
    options: document.getElementById("user-question-options"),
    freeformInput: document.getElementById("user-question-freeform-input"),
    prevBtn: document.getElementById("user-question-prev-btn"),
    nextBtn: document.getElementById("user-question-next-btn"),
    submitBtn: document.getElementById("user-question-submit-btn"),
    cancelBtn: document.getElementById("user-question-cancel-btn"),
    hideBtn: document.getElementById("user-question-hide-btn"),
    closeBtn: document.getElementById("user-question-close-btn"),
  };
}

function setUserQuestionInteractionSuppressed(suppressed) {
  window.setOwuiInteractionSuppressed?.("user-question-modal", suppressed);
  window.setNativeOverlayInteractionSuppressed?.("user-question-modal", suppressed);
}

function getUserQuestionAnswer(questionId) {
  return userQuestionState.answersByQuestionId[questionId] || {
    selectedOptionId: null,
    freeformText: "",
  };
}

function setUserQuestionAnswer(questionId, updates = {}) {
  const current = getUserQuestionAnswer(questionId);
  userQuestionState.answersByQuestionId = {
    ...userQuestionState.answersByQuestionId,
    [questionId]: {
      ...current,
      ...updates,
    },
  };
}

function hasUserQuestionFallbackOption(question) {
  return Boolean(
    question?.options?.some(
      (option) => option?.id === USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID,
    ),
  );
}

function freeformSelectionUpdates(question, value) {
  if (!hasUserQuestionFallbackOption(question)) {
    return {};
  }
  const answer = getUserQuestionAnswer(question.id);
  if (typeof value === "string" && value.trim()) {
    return answer.selectedOptionId
      ? {}
      : { selectedOptionId: USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID };
  }
  return answer.selectedOptionId === USER_QUESTION_NONE_OF_THE_ABOVE_OPTION_ID
    ? { selectedOptionId: null }
    : {};
}

function doesUserQuestionAnswerCount(question) {
  if (!question) {
    return false;
  }

  const answer = getUserQuestionAnswer(question.id);
  if (answer.selectedOptionId) {
    return true;
  }

  return Boolean(
    hasUserQuestionFallbackOption(question) &&
      typeof answer.freeformText === "string" &&
      answer.freeformText.trim(),
  );
}

function areAllUserQuestionsAnswered() {
  return userQuestionState.questions.every((question) =>
    doesUserQuestionAnswerCount(question),
  );
}

function renderUserQuestionRequesterHeader() {
  const elements = getUserQuestionElements();
  const identity = normalizeResolvedRequesterIdentity(userQuestionState.requesterIdentity);
  const hasLogoImage = Boolean(identity.logoDataUrl);

  if (elements.titleText) {
    elements.titleText.textContent = "We need your input...";
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

function renderUserQuestionOptions(question) {
  const { options } = getUserQuestionElements();
  if (!options) {
    return;
  }

  const answer = getUserQuestionAnswer(question.id);
  options.innerHTML = question.options
    .map((option) => {
      const selected = option.id === answer.selectedOptionId;
      return `
        <button
          class="user-question-option${selected ? " selected" : ""}"
          type="button"
          data-option-id="${escapeUserQuestionHtml(option.id)}"
        >
          <span class="user-question-option-label">${escapeUserQuestionHtml(option.label)}</span>
          ${
            option.description
              ? `<span class="user-question-option-description">${escapeUserQuestionHtml(option.description)}</span>`
              : ""
          }
        </button>
      `;
    })
    .join("");

  options.querySelectorAll("[data-option-id]").forEach((button) => {
    button.addEventListener("click", () => {
      setUserQuestionAnswer(question.id, {
        selectedOptionId: button.dataset.optionId || null,
      });
      renderUserQuestionModal();
    });
  });
}

function renderUserQuestionStepIndicators() {
  const { stepIndicators } = getUserQuestionElements();
  if (!stepIndicators) {
    return;
  }

  const questionCount = userQuestionState.questions.length;
  stepIndicators.hidden = questionCount <= 1;
  if (questionCount <= 1) {
    stepIndicators.innerHTML = "";
    return;
  }

  stepIndicators.innerHTML = userQuestionState.questions
    .map((question, index) => {
      const completed = doesUserQuestionAnswerCount(question);
      const active = index === userQuestionState.currentIndex;
      const status = completed ? "completed" : "pending";
      const classes = [
        "user-question-step-indicator",
        status,
        active ? "active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const icon = completed
        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : "";

      return `
        <button
          class="${classes}"
          type="button"
          data-question-index="${index}"
          aria-label="Question ${index + 1} ${status}"
          title="Question ${index + 1}: ${status}"
        >
          <span class="user-question-step-indicator-icon" aria-hidden="true">${icon}</span>
        </button>
      `;
    })
    .join("");

  stepIndicators.querySelectorAll("[data-question-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const questionIndex = Number.parseInt(button.dataset.questionIndex || "", 10);
      if (
        Number.isInteger(questionIndex) &&
        questionIndex >= 0 &&
        questionIndex < userQuestionState.questions.length
      ) {
        userQuestionState.currentIndex = questionIndex;
        renderUserQuestionModal();
      }
    });
  });
}

function renderUserQuestionNavigation() {
  const elements = getUserQuestionElements();
  const hasPreviousQuestion =
    userQuestionState.questions.length > 1 && userQuestionState.currentIndex > 0;
  const hasNextQuestion =
    userQuestionState.questions.length > 1 &&
    userQuestionState.currentIndex < userQuestionState.questions.length - 1;

  if (elements.prevBtn) {
    elements.prevBtn.hidden = !hasPreviousQuestion;
    elements.prevBtn.disabled = !hasPreviousQuestion;
  }

  if (elements.nextBtn) {
    elements.nextBtn.hidden = !hasNextQuestion;
    elements.nextBtn.disabled = !hasNextQuestion;
  }

  if (elements.submitBtn) {
    elements.submitBtn.disabled = !areAllUserQuestionsAnswered();
  }

  renderUserQuestionStepIndicators();
}

function renderUserQuestionModal() {
  const elements = getUserQuestionElements();
  const question = userQuestionState.questions[userQuestionState.currentIndex];
  if (!question) {
    return;
  }

  renderUserQuestionRequesterHeader();

  if (elements.headerTag) {
    elements.headerTag.textContent = question.header;
  }
  if (elements.progressText) {
    elements.progressText.hidden = userQuestionState.questions.length <= 1;
    if (userQuestionState.questions.length > 1) {
      elements.progressText.textContent = `Question ${userQuestionState.currentIndex + 1} of ${userQuestionState.questions.length}`;
    } else {
      elements.progressText.textContent = "";
    }
  }
  if (elements.prompt) {
    elements.prompt.textContent = question.question;
  }

  renderUserQuestionOptions(question);

  if (elements.freeformInput) {
    const answer = getUserQuestionAnswer(question.id);
    elements.freeformInput.value = answer.freeformText || "";
    elements.freeformInput.placeholder =
      question.freeform_placeholder ||
      "Add any extra context for this answer (optional).";
    elements.freeformInput.oninput = () => {
      setUserQuestionAnswer(question.id, {
        freeformText: elements.freeformInput.value,
        ...freeformSelectionUpdates(question, elements.freeformInput.value),
      });
      renderUserQuestionOptions(question);
      renderUserQuestionNavigation();
    };
  }

  renderUserQuestionNavigation();
}

function collectUserQuestionAnswers() {
  return userQuestionState.questions.map((question) => {
    const answer = getUserQuestionAnswer(question.id);
    return {
      question_id: question.id,
      selected_option_id: answer.selectedOptionId,
      freeform_text:
        typeof answer.freeformText === "string" && answer.freeformText.trim()
          ? answer.freeformText.trim()
          : null,
    };
  });
}

function settleUserQuestionFlow(result) {
  if (typeof userQuestionState.resolveFlow === "function") {
    userQuestionState.resolveFlow(result);
  }
}

function showUserQuestionModal() {
  if (!userQuestionFlowInProgress || !userQuestionState.flowId) {
    return false;
  }
  const { modal } = getUserQuestionElements();
  if (!modal) {
    return false;
  }
  userQuestionState.presentation = "visible";
  renderUserQuestionModal();
  modal.classList.add("visible");
  setUserQuestionInteractionSuppressed(true);
  return true;
}

async function hideUserQuestionModal() {
  if (!userQuestionFlowInProgress || !userQuestionState.flowId) {
    return false;
  }
  const setPresentation =
    window.electronAPI?.setNativeInputPresentation ||
    window.electronAPI?.setUserQuestionPresentation;
  if (typeof setPresentation !== "function") {
    return false;
  }

  const { modal } = getUserQuestionElements();
  modal?.classList.remove("visible");
  setUserQuestionInteractionSuppressed(false);
  userQuestionState.presentation = "hidden";

  try {
    const result = await setPresentation({
      kind: "user_question",
      flow_id: userQuestionState.flowId,
      presentation: "hidden",
    });
    if (!result?.success) {
      throw new Error(result?.error || "Failed to hide question modal");
    }
    return true;
  } catch (error) {
    console.error("[User Question] Failed to hide modal:", error);
    showUserQuestionModal();
    return false;
  }
}

function closeUserQuestionModal(options = {}) {
  const { modal } = getUserQuestionElements();
  if (modal) {
    modal.classList.remove("visible");
  }
  setUserQuestionInteractionSuppressed(false);

  userQuestionFlowInProgress = false;
  const result = options.result || null;
  settleUserQuestionFlow(result);
  userQuestionState = createInitialUserQuestionState();
}

function dismissUserQuestionModal() {
  if (userQuestionState.flowId && window.electronAPI?.notifyUserQuestionCompleted) {
    window.electronAPI.notifyUserQuestionCompleted({
      flow_id: userQuestionState.flowId,
      action: "dismissed",
    });
  }

  closeUserQuestionModal({
    result: {
      success: false,
      status: "dismissed",
      flow_id: userQuestionState.flowId,
      answers: [],
    },
  });
}

function submitUserQuestionAnswers() {
  if (!areAllUserQuestionsAnswered()) {
    return;
  }

  const result = {
    success: true,
    status: "submitted",
    flow_id: userQuestionState.flowId,
    answers: collectUserQuestionAnswers(),
  };

  if (window.electronAPI?.notifyUserQuestionCompleted) {
    window.electronAPI.notifyUserQuestionCompleted({
      flow_id: userQuestionState.flowId,
      action: "submitted",
      answers: result.answers,
    });
  }

  closeUserQuestionModal({ result });
}

function attachUserQuestionModalListeners() {
  const elements = getUserQuestionElements();

  if (elements.cancelBtn) {
    elements.cancelBtn.onclick = () => dismissUserQuestionModal();
  }
  if (elements.closeBtn) {
    elements.closeBtn.onclick = () => dismissUserQuestionModal();
  }
  if (elements.hideBtn) {
    elements.hideBtn.onclick = () => void hideUserQuestionModal();
  }
  if (elements.prevBtn) {
    elements.prevBtn.onclick = () => {
      if (userQuestionState.currentIndex > 0) {
        userQuestionState.currentIndex -= 1;
        renderUserQuestionModal();
      }
    };
  }
  if (elements.nextBtn) {
    elements.nextBtn.onclick = () => {
      if (userQuestionState.currentIndex < userQuestionState.questions.length - 1) {
        userQuestionState.currentIndex += 1;
        renderUserQuestionModal();
      }
    };
  }
  if (elements.submitBtn) {
    elements.submitBtn.onclick = () => submitUserQuestionAnswers();
  }
}

function resolveUserQuestionLanguage() {
  const documentLanguage = normalizeUserQuestionString(document.documentElement?.lang);
  if (documentLanguage) {
    return documentLanguage;
  }
  const navigatorLanguage = normalizeUserQuestionString(navigator.language);
  return navigatorLanguage || "en";
}

function getUserQuestionOwuiViewCandidates() {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeUserQuestionString(value);
    if (!normalized || candidates.includes(normalized)) {
      return;
    }
    candidates.push(normalized);
  };

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

function buildUserQuestionRequesterResolutionScript({ chatId, language }) {
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

      if (haystack.includes("claude") || haystack.includes("anthropic")) {
        return "claude";
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
      const brandFamily = getBrandFamily({ displayName, modelId, ownedBy });
      const baseModelId =
        normalizeValue(modelPayload?.base_model_id) ||
        normalizeValue(modelPayload?.baseModelId) ||
        normalizeValue(modelPayload?.info?.base_model_id) ||
        normalizeValue(modelPayload?.info?.baseModelId);
      const isDerivedModel = Boolean(baseModelId);
      const celestialIdentity = getCelestialIdentity({
        displayName,
        modelId,
        isDerivedModel,
      });
      const profileImageUrl =
        resolveLogoUrl(modelPayload?.info?.meta?.profile_image_url) ||
        resolveLogoUrl(modelPayload?.meta?.profile_image_url) ||
        resolveLogoUrl(modelPayload?.profile_image_url);

      const fallbackImageUrl = new URL("/models/model/profile/image", window.location.origin);
      fallbackImageUrl.searchParams.set("id", modelId);
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
        fallbackText: buildFallbackText(displayName),
        logoDataUrl,
        needsDarkBadge: brandFamily === "openai" && celestialIdentity === null,
      };
    })();
  })()`;
}

async function resolveUserQuestionRequesterIdentityFromOwui(chatId) {
  const normalizedChatId = normalizeUserQuestionString(chatId);
  if (!normalizedChatId || !window.electronAPI?.owui?.executeJavaScript) {
    return buildFallbackRequesterIdentity();
  }

  const candidateViewKeys = getUserQuestionOwuiViewCandidates();
  if (!candidateViewKeys.length) {
    return buildFallbackRequesterIdentity();
  }

  const script = buildUserQuestionRequesterResolutionScript({
    chatId: normalizedChatId,
    language: resolveUserQuestionLanguage(),
  });

  for (const viewKey of candidateViewKeys) {
    try {
      const identity = await window.electronAPI.owui.executeJavaScript(viewKey, script);
      if (identity?.success) {
        return normalizeResolvedRequesterIdentity(identity);
      }
    } catch (error) {
      console.warn(
        `[User Question] Failed to resolve requester identity from OWUI view ${viewKey}:`,
        error?.message || error,
      );
    }
  }

  return buildFallbackRequesterIdentity();
}

async function hydrateUserQuestionRequesterIdentity(flowId) {
  const activeFlowId = normalizeUserQuestionString(flowId);
  const chatId = normalizeUserQuestionString(userQuestionState.chatId);
  if (!activeFlowId || !chatId) {
    return;
  }

  const requesterIdentity = await resolveUserQuestionRequesterIdentityFromOwui(chatId);
  if (userQuestionState.flowId !== activeFlowId) {
    return;
  }

  userQuestionState.requesterIdentity = requesterIdentity;
  renderUserQuestionRequesterHeader();
}

async function runUserQuestionModal(payload = {}) {
  await loadUserQuestionTemplate();

  const flowId = normalizeUserQuestionString(payload?.flow_id);
  if (!flowId) {
    throw new Error("user-question flow_id is required");
  }

  const chatId = normalizeUserQuestionString(payload?.chat_id);
  if (!chatId) {
    throw new Error("user-question chat_id is required");
  }

  if (userQuestionFlowInProgress) {
    if (userQuestionState.flowId === flowId) {
      showUserQuestionModal();
      return {
        success: true,
        reusedExistingFlow: true,
        flow_id: flowId,
      };
    }
    throw new Error(
      `A different user-question flow is already active (${userQuestionState.flowId})`,
    );
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (!questions.length) {
    throw new Error("user-question flow requires at least one question");
  }

  userQuestionState = createInitialUserQuestionState({
    flowId,
    chatId,
    questions,
    currentIndex: 0,
    requesterIdentity: buildFallbackRequesterIdentity(),
    launchSource:
      payload.launchSource === "backend-requested" ? "backend-requested" : "manual",
  });
  userQuestionFlowInProgress = true;

  const { modal } = getUserQuestionElements();
  if (!modal) {
    userQuestionFlowInProgress = false;
    throw new Error("#user-question-modal not found after template load");
  }

  attachUserQuestionModalListeners();
  showUserQuestionModal();
  void hydrateUserQuestionRequesterIdentity(flowId);

  return new Promise((resolve) => {
    userQuestionState.resolveFlow = resolve;
  });
}

window.runUserQuestionModal = runUserQuestionModal;
window.closeUserQuestionModal = closeUserQuestionModal;
window.hideUserQuestionModal = hideUserQuestionModal;

window.electronAPI?.onUserQuestionReopenRequested?.((payload = {}) => {
  const flowId = normalizeUserQuestionString(payload?.flow_id);
  if (
    userQuestionFlowInProgress &&
    flowId &&
    flowId === userQuestionState.flowId
  ) {
    showUserQuestionModal();
  }
});

window.electronAPI?.onUserQuestionTerminal?.((payload = {}) => {
  const flowId = normalizeUserQuestionString(payload?.flow_id);
  if (
    !userQuestionFlowInProgress ||
    !flowId ||
    flowId !== userQuestionState.flowId
  ) {
    return;
  }

  const status = normalizeUserQuestionString(payload?.status) || "completed";
  closeUserQuestionModal({
    result: {
      success: false,
      status,
      flow_id: flowId,
      answers: [],
    },
  });
});

window.electronAPI?.onNativeInputReopenRequested?.((payload = {}) => {
  const flowId = normalizeUserQuestionString(payload?.flow_id);
  if (
    payload?.kind === "user_question" &&
    userQuestionFlowInProgress &&
    flowId &&
    flowId === userQuestionState.flowId
  ) {
    showUserQuestionModal();
  }
});

window.electronAPI?.onNativeInputTerminal?.((payload = {}) => {
  const flowId = normalizeUserQuestionString(payload?.flow_id);
  if (
    payload?.kind !== "user_question" ||
    !userQuestionFlowInProgress ||
    !flowId ||
    flowId !== userQuestionState.flowId
  ) {
    return;
  }
  closeUserQuestionModal({
    result: {
      success: false,
      status: normalizeUserQuestionString(payload?.status) || "completed",
      flow_id: flowId,
      answers: [],
    },
  });
});
