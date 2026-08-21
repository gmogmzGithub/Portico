(function attachAgentReasoningOptions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.AgentReasoningOptions = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const LEGACY_REASONING_EFFORT_OPTIONS = Object.freeze([
    "low",
    "medium",
    "high",
    "max",
  ]);
  const REASONING_EFFORT_ORDER = Object.freeze([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);

  function normalizeReasoningEffortOptions(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const options = [];
    for (const value of values) {
      const normalized = String(value || "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      options.push(normalized);
    }
    return options;
  }

  function normalizeModelIdentifier(value) {
    return String(value || "").trim().replace(/:latest$/i, "").toLowerCase();
  }

  function isGpt56SolModel(value) {
    const normalized = normalizeModelIdentifier(value);
    return (
      normalized === "gpt-5.6 sol" ||
      normalized === "gpt-5.6-sol" ||
      normalized.endsWith("/gpt-5.6-sol")
    );
  }

  function capReasoningEffortOptionsForGui(baseModelId, values) {
    const options = normalizeReasoningEffortOptions(values);
    if (!isGpt56SolModel(baseModelId)) {
      return options;
    }

    const maxIndex = REASONING_EFFORT_ORDER.indexOf("max");
    return options.filter((option) => {
      const optionIndex = REASONING_EFFORT_ORDER.indexOf(option);
      return optionIndex >= 0 && optionIndex <= maxIndex;
    });
  }

  function coerceReasoningEffortForGui(baseModelId, value) {
    const normalized = String(value || "").trim();
    return isGpt56SolModel(baseModelId) && normalized === "ultra"
      ? "max"
      : normalized;
  }

  function reasoningEffortLabel(value) {
    return value === "ultra" ? "Ultra" : String(value || "");
  }

  function reasoningConfigForBaseModel(baseModels, baseModelId) {
    const selectedId = String(baseModelId || "").trim();
    if (!selectedId) {
      return {
        modelKnown: false,
        supportsReasoning: false,
        options: [],
      };
    }

    const normalizedSelectedId = normalizeModelIdentifier(selectedId);
    const models = Array.isArray(baseModels) ? baseModels : [];
    const model = models.find((candidate) => {
      const candidateId = String(candidate?.id || "").trim();
      return (
        candidateId === selectedId ||
        normalizeModelIdentifier(candidateId) === normalizedSelectedId
      );
    });
    if (!model) {
      return {
        modelKnown: false,
        supportsReasoning: null,
        options: [...LEGACY_REASONING_EFFORT_OPTIONS],
      };
    }

    if (model.supports_reasoning === false) {
      return {
        modelKnown: true,
        supportsReasoning: false,
        options: [],
      };
    }

    const catalogOptions = capReasoningEffortOptionsForGui(
      model.id,
      model.reasoning_effort_options,
    );
    return {
      modelKnown: true,
      supportsReasoning:
        model.supports_reasoning === true || catalogOptions.length > 0
          ? true
          : null,
      options:
        catalogOptions.length > 0
          ? catalogOptions
          : [...LEGACY_REASONING_EFFORT_OPTIONS],
    };
  }

  function buildReasoningEffortFieldState(
    baseModels,
    baseModelId,
    requestedValue,
  ) {
    const config = reasoningConfigForBaseModel(baseModels, baseModelId);
    const requested = coerceReasoningEffortForGui(baseModelId, requestedValue);
    const selectedValue = config.options.includes(requested) ? requested : "";
    const hasSelectedBaseModel = Boolean(String(baseModelId || "").trim());
    const disabled =
      !hasSelectedBaseModel ||
      config.supportsReasoning === false ||
      config.options.length === 0;

    return {
      ...config,
      disabled,
      selectedValue,
      placeholder: !hasSelectedBaseModel
        ? "Select a base model first"
        : config.supportsReasoning === false
          ? "Not supported by selected model"
          : "(default)",
    };
  }

  function normalizeReasoningEffortForSubmission(baseModels, baseModelId, value) {
    const state = buildReasoningEffortFieldState(baseModels, baseModelId, value);
    return state.selectedValue || null;
  }

  return {
    LEGACY_REASONING_EFFORT_OPTIONS,
    normalizeReasoningEffortOptions,
    capReasoningEffortOptionsForGui,
    coerceReasoningEffortForGui,
    reasoningEffortLabel,
    reasoningConfigForBaseModel,
    buildReasoningEffortFieldState,
    normalizeReasoningEffortForSubmission,
  };
});
