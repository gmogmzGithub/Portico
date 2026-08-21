(function attachAgentModelPicker(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.AgentModelPicker = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  const PROVIDER_ORDER = Object.freeze(["anthropic", "openai", "google", "local", "other"]);
  const PROVIDER_LABELS = Object.freeze({
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    local: "Local Models",
    other: "Other",
  });
  const TIER_ORDER = Object.freeze(["general", "heavy", "premium", "lightweight"]);
  const TIER_DEFINITIONS = Object.freeze({
    general: {
      label: "Everyday",
      description: "Balanced for everyday work.",
    },
    heavy: {
      label: "Heavy",
      description: "For complex, slower work.",
    },
    premium: {
      label: "Extreme",
      description: "Maximum capability for the hardest work.",
    },
    lightweight: {
      label: "Lightweight",
      description: "Fast for simple tasks.",
    },
  });
  const LOCAL_MODELS_WARNING =
    "LM Studio is not running. Start LM Studio and enable the local server.";
  let pickerSequence = 0;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeIdentifier(value) {
    return String(value || "")
      .trim()
      .replace(/:latest$/i, "")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-");
  }

  function normalizeProvider(value, model = {}) {
    const explicit = String(value || "").trim().toLowerCase();
    if (PROVIDER_ORDER.includes(explicit)) return explicit;
    if (model.is_local === true) return "local";
    const haystack = `${model.id || ""} ${model.display_name || model.name || ""}`.toLowerCase();
    if (haystack.includes("claude") || haystack.includes("anthropic")) return "anthropic";
    if (haystack.includes("gemini") || haystack.includes("google")) return "google";
    if (haystack.includes("gpt") || haystack.includes("openai")) return "openai";
    return "other";
  }

  function normalizeTier(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return TIER_ORDER.includes(normalized) ? normalized : null;
  }

  function normalizeModel(raw, index = 0) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || raw.model_id || "").trim();
    if (!id) return null;
    const disabledReason = String(raw.disabled_reason || "").trim();
    const explicitProvider = String(raw.picker_provider || "").trim().toLowerCase();
    const explicitTier = String(raw.picker_tier || "").trim().toLowerCase();
    const isLocal = raw.is_local === true || explicitProvider === "local";
    const isCatalogSelectable =
      isLocal ||
      (["anthropic", "openai", "google"].includes(explicitProvider) &&
        TIER_ORDER.includes(explicitTier));
    return {
      ...raw,
      id,
      display_name: String(raw.display_name || raw.name || id).trim() || id,
      description: String(raw.description || "").trim(),
      picker_provider: normalizeProvider(raw.picker_provider, { ...raw, id, is_local: isLocal }),
      picker_tier: isLocal ? null : normalizeTier(raw.picker_tier),
      is_local: isLocal,
      hidden: raw.hidden === true || !isCatalogSelectable,
      disabled: raw.disabled === true || Boolean(disabledReason),
      disabled_reason: disabledReason || (raw.disabled === true ? "Temporarily unavailable" : ""),
      _sourceIndex: Number.isFinite(raw._sourceIndex) ? raw._sourceIndex : index,
    };
  }

  function isGpt55(model) {
    const values = [model?.id, model?.display_name];
    return values.some((value) => {
      const normalized = normalizeIdentifier(value).split("/").filter(Boolean).at(-1) || "";
      return normalized === "gpt-5.5";
    });
  }

  function sortModels(models) {
    return (Array.isArray(models) ? models : [])
      .map(normalizeModel)
      .filter((model) => model && !model.hidden)
      .sort((left, right) => {
        const providerDifference =
          PROVIDER_ORDER.indexOf(left.picker_provider) -
          PROVIDER_ORDER.indexOf(right.picker_provider);
        if (providerDifference) return providerDifference;
        const tailDifference = Number(isGpt55(left)) - Number(isGpt55(right));
        if (tailDifference) return tailDifference;
        const leftTier = left.picker_tier ? TIER_ORDER.indexOf(left.picker_tier) : TIER_ORDER.length;
        const rightTier = right.picker_tier ? TIER_ORDER.indexOf(right.picker_tier) : TIER_ORDER.length;
        const tierDifference = leftTier - rightTier;
        if (tierDifference) return tierDifference;
        return left._sourceIndex - right._sourceIndex;
      });
  }

  function fuzzySubsequenceMatch(haystack, needle) {
    if (!needle) return true;
    let cursor = 0;
    for (const character of haystack) {
      if (character === needle[cursor]) cursor += 1;
      if (cursor === needle.length) return true;
    }
    return false;
  }

  function modelMatchesQuery(model, query) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) return true;
    const haystack = `${model.display_name} ${model.id} ${model.description} ${PROVIDER_LABELS[model.picker_provider] || ""}`.toLowerCase();
    return normalizedQuery
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => haystack.includes(term) || fuzzySubsequenceMatch(haystack, term));
  }

  function filterModels(models, query) {
    return sortModels(models).filter((model) => modelMatchesQuery(model, query));
  }

  function groupModels(models) {
    const groups = [];
    for (const provider of PROVIDER_ORDER) {
      const items = (Array.isArray(models) ? models : []).filter(
        (model) => model.picker_provider === provider,
      );
      if (items.length) {
        groups.push({ provider, label: PROVIDER_LABELS[provider], items });
      }
    }
    return groups;
  }

  function modelLogoSources(model) {
    if (!model) return { light: null, dark: null };
    if (model.is_local || model.picker_provider === "local") {
      return {
        light: "../assets/local-model-light.svg",
        dark: "../assets/local-model-dark.svg",
      };
    }
    const identity = normalizeIdentifier(model.id).split("/").filter(Boolean).at(-1) || "";
    if (identity === "gpt-5.6-sol" || identity === "gpt-5.6-sol-pro") {
      return { light: "../assets/sol.png", dark: null };
    }
    if (identity === "gpt-5.6-terra") return { light: "../assets/terra.png", dark: null };
    if (identity === "gpt-5.6-luna") return { light: "../assets/luna.png", dark: null };
    if (model.picker_provider === "anthropic") return { light: "../assets/claude.png", dark: null };
    if (model.picker_provider === "google") return { light: "../assets/gemini.png", dark: null };
    if (model.picker_provider === "openai") return { light: "../assets/gpt.png", dark: null };
    return { light: null, dark: null };
  }

  // Heroicons 24/solid "sparkles" — the same glyph OWUI's ModelTraitGlyph uses.
  function sparklesSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5ZM18 1.5a.75.75 0 0 1 .728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258a2.625 2.625 0 0 0-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.625 2.625 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.625 2.625 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5ZM16.5 15a.75.75 0 0 1 .712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 0 1 0 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 0 1-1.422 0l-.395-1.183a1.5 1.5 0 0 0-.948-.948l-1.183-.395a.75.75 0 0 1 0-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0 1 16.5 15Z" clip-rule="evenodd"></path>
      </svg>`;
  }

  function tierBadgeHtml(tier, { withLabel = false } = {}) {
    const definition = TIER_DEFINITIONS[tier];
    if (!definition) return "";
    return `
      <span class="agent-model-tier agent-model-tier-${escapeHtml(tier)}" title="${escapeHtml(definition.description)}">
        ${sparklesSvg()}
        ${withLabel ? `<span>${escapeHtml(definition.label)}</span>` : ""}
      </span>`;
  }

  // OWUI celestial OpenAI models get bare art; other OpenAI logos sit on a
  // black circular badge in light mode (modelBranding.ts parity).
  function isCelestialOpenAiModel(model) {
    const identity = normalizeIdentifier(model?.id).split("/").filter(Boolean).at(-1) || "";
    return ["gpt-5.6-sol", "gpt-5.6-sol-pro", "gpt-5.6-terra", "gpt-5.6-luna"].includes(identity);
  }

  function logoVariantClasses(model) {
    let classes = "";
    if (model?.is_local || model?.picker_provider === "local") {
      classes += " agent-model-logo-local";
    } else if (model?.picker_provider === "openai" && !isCelestialOpenAiModel(model)) {
      classes += " agent-model-logo-openai-badge";
    }
    return classes;
  }

  // Compact "logo + name + tier sparkle" chip for use outside the picker
  // (e.g. agent cards), so a model reads the same everywhere it appears.
  function buildModelIdentityHtml(model, { withTier = true } = {}) {
    if (!model) return "";
    const name = escapeHtml(model.display_name || model.name || model.id || "");
    const tier =
      withTier && model.picker_tier ? tierBadgeHtml(model.picker_tier) : "";
    return `<span class="agent-model-identity">${logoHtml(model, "agent-model-identity-logo")}<span class="agent-model-identity-name">${name}</span>${tier}</span>`;
  }

  function logoHtml(model, className = "") {
    const sources = modelLogoSources(model);
    const classNames = `${escapeHtml(className)}${logoVariantClasses(model)}`;
    if (!sources.light) {
      return `<span class="agent-model-logo agent-model-logo-fallback ${classNames}" aria-hidden="true">AI</span>`;
    }
    if (sources.dark) {
      return `
        <span class="agent-model-logo ${classNames}" aria-hidden="true">
          <img class="agent-model-logo-light" src="${escapeHtml(sources.light)}" alt="" />
          <img class="agent-model-logo-dark" src="${escapeHtml(sources.dark)}" alt="" />
        </span>`;
    }
    return `<span class="agent-model-logo ${classNames}" aria-hidden="true"><img src="${escapeHtml(sources.light)}" alt="" /></span>`;
  }

  function chevronSvg() {
    return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5"></path></svg>`;
  }

  function checkSvg() {
    return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.25 3.25 3.25 7.75-7.75"></path></svg>`;
  }

  // Heroicons 20/solid "lock-closed" — matches OWUI's disabled-row lock.
  function lockSvg() {
    return `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd"></path></svg>`;
  }

  function searchSvg() {
    return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"></circle><path d="m12.4 12.4 3.6 3.6"></path></svg>`;
  }

  function buildFieldHtml(value = "") {
    return `<div class="agent-model-picker" data-agent-model-picker data-current-value="${escapeHtml(value)}"></div>`;
  }

  function mount(container, options = {}) {
    if (!container || typeof container.querySelector !== "function") {
      throw new TypeError("AgentModelPicker.mount requires a DOM container");
    }
    container.agentModelPicker?.destroy?.();

    const doc = container.ownerDocument;
    const view = doc.defaultView || globalThis;
    const pickerId = `agent-model-picker-${++pickerSequence}`;
    const errorId = `${pickerId}-error`;
    container.dataset.agentModelPickerErrorId = errorId;
    let models = sortModels(options.models);
    let currentValue = String(options.value ?? container.dataset.currentValue ?? "").trim();
    let catalogError = String(options.error || "").trim();
    let popover = null;
    let searchValue = "";
    let destroyed = false;

    container.innerHTML = `
      <input type="hidden" name="base_model_id" value="${escapeHtml(currentValue)}" />
      <button
        type="button"
        class="agent-model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="${pickerId}"
        aria-invalid="false"
      >
        <span class="agent-model-picker-trigger-content"></span>
        <span class="agent-model-picker-chevron">${chevronSvg()}</span>
      </button>`;
    const input = container.querySelector('input[name="base_model_id"]');
    const trigger = container.querySelector(".agent-model-picker-trigger");
    const triggerContent = container.querySelector(".agent-model-picker-trigger-content");

    function selectedModel() {
      return models.find((model) => model.id === currentValue) || null;
    }

    function isUnavailableSelection() {
      if (!currentValue) return false;
      const selected = selectedModel();
      return !selected || selected.disabled;
    }

    function unavailableReason() {
      if (!currentValue) return "";
      const selected = selectedModel();
      if (!selected) return "This model is no longer available. Choose a replacement.";
      return selected.disabled_reason || "This model is temporarily unavailable. Choose a replacement.";
    }

    function updateTrigger() {
      const selected = selectedModel();
      if (!currentValue) {
        triggerContent.innerHTML = `<span class="agent-model-picker-placeholder">Select a base model</span>`;
        trigger.removeAttribute("title");
        return;
      }
      const unavailable = isUnavailableSelection();
      const displayModel = selected || {
        id: currentValue,
        display_name: currentValue,
        picker_provider: "other",
      };
      triggerContent.innerHTML = `
        ${logoHtml(displayModel, unavailable ? "is-unavailable" : "")}
        <span class="agent-model-picker-trigger-label" title="${escapeHtml(displayModel.display_name)}">${escapeHtml(displayModel.display_name)}</span>
        ${selected?.picker_tier ? tierBadgeHtml(selected.picker_tier) : ""}
        ${unavailable ? `<span class="agent-model-picker-unavailable">Unavailable</span>` : ""}`;
      if (unavailable) trigger.title = unavailableReason();
      else trigger.removeAttribute("title");
    }

    function renderGuide() {
      return `
        <aside class="agent-model-guide" aria-label="Model Guide">
          <div class="agent-model-guide-title">Model Guide</div>
          ${TIER_ORDER.map((tier) => {
            const definition = TIER_DEFINITIONS[tier];
            return `
              <div class="agent-model-guide-item">
                <div class="agent-model-guide-label">${tierBadgeHtml(tier)}<span>${escapeHtml(definition.label)}</span></div>
                <div class="agent-model-guide-description">${escapeHtml(definition.description)}</div>
              </div>`;
          }).join("")}
        </aside>`;
    }

    function renderRow(model) {
      const selected = model.id === currentValue && !model.disabled;
      const disabledTitle = model.disabled
        ? model.disabled_reason || "Temporarily unavailable"
        : "";
      return `
        <button
          type="button"
          id="${pickerId}-option-${escapeHtml(model._sourceIndex)}"
          class="agent-model-option${selected ? " is-selected" : ""}${model.disabled ? " is-disabled" : ""}"
          role="option"
          aria-selected="${selected ? "true" : "false"}"
          aria-disabled="${model.disabled ? "true" : "false"}"
          data-model-id="${escapeHtml(model.id)}"
          title="${escapeHtml(disabledTitle)}"
        >
          <span class="agent-model-option-main">
            ${logoHtml(model, model.disabled ? "is-unavailable" : "")}
            <span class="agent-model-option-copy">
              <span class="agent-model-option-name">${escapeHtml(model.display_name)}</span>
              ${model.description ? `<span class="agent-model-option-description">${escapeHtml(model.description)}</span>` : ""}
            </span>
          </span>
          <span class="agent-model-option-actions">
            ${model.disabled ? `<span class="agent-model-option-lock" aria-label="${escapeHtml(disabledTitle)}">${lockSvg()}</span>` : ""}
            ${selected ? `<span class="agent-model-option-check">${checkSvg()}</span>` : ""}
            ${model.picker_tier ? tierBadgeHtml(model.picker_tier) : ""}
          </span>
        </button>`;
    }

    function stateHtml() {
      if (catalogError) {
        return `
          <div class="agent-model-picker-state" role="alert">
            <strong>Models couldn’t be loaded</strong>
            <span>${escapeHtml(catalogError)}</span>
            <button type="button" class="agent-model-picker-retry">Retry</button>
          </div>`;
      }
      if (!models.length) {
        return `<div class="agent-model-picker-state"><strong>No base models available</strong><span>Check the model service and try again.</span>${typeof options.onRetry === "function" ? '<button type="button" class="agent-model-picker-retry">Retry</button>' : ""}</div>`;
      }
      return "";
    }

    function renderResults() {
      if (!popover) return;
      const results = popover.querySelector(".agent-model-picker-results");
      if (!results) return;
      const state = stateHtml();
      if (state) {
        results.innerHTML = state;
        wireRetry();
        return;
      }
      const filtered = filterModels(models, searchValue);
      if (!filtered.length) {
        results.innerHTML = `<div class="agent-model-picker-state"><strong>No results found</strong><span>Try a model name, provider, or capability.</span></div>`;
        return;
      }
      const grouped = groupModels(filtered);
      results.innerHTML = `
        <div class="agent-model-picker-groups" role="listbox" aria-label="Base models" data-provider-count="${grouped.length}">
          ${grouped
            .map(
              (group) => `
                <section class="agent-model-provider" data-provider="${escapeHtml(group.provider)}">
                  <div class="agent-model-provider-heading">
                    <span>${escapeHtml(group.label)}</span>
                    ${group.provider === "local" && group.items.some((model) => model.disabled) ? `<span class="agent-model-local-warning" title="${escapeHtml(LOCAL_MODELS_WARNING)}" aria-label="${escapeHtml(LOCAL_MODELS_WARNING)}">!</span>` : ""}
                  </div>
                  <div class="agent-model-provider-list">${group.items.map(renderRow).join("")}</div>
                </section>`,
            )
            .join("")}
        </div>`;
      results.querySelectorAll(".agent-model-option").forEach((row) => {
        row.addEventListener("click", () => {
          if (row.getAttribute("aria-disabled") === "true") return;
          selectValue(row.dataset.modelId || "");
        });
        row.addEventListener("keydown", handleRowKeydown);
      });
    }

    async function retryCatalog() {
      if (typeof options.onRetry !== "function") return;
      const retryButton = popover?.querySelector(".agent-model-picker-retry");
      if (retryButton) {
        retryButton.disabled = true;
        retryButton.textContent = "Loading…";
      }
      try {
        const refreshed = await options.onRetry();
        catalogError = "";
        setModels(Array.isArray(refreshed) ? refreshed : models);
      } catch (error) {
        catalogError = String(error?.message || error || "Unable to load models");
        renderResults();
      }
    }

    function wireRetry() {
      popover?.querySelector(".agent-model-picker-retry")?.addEventListener("click", retryCatalog);
    }

    function availableRows() {
      return Array.from(popover?.querySelectorAll('.agent-model-option[aria-disabled="false"]') || []);
    }

    function focusRelativeRow(current, delta) {
      const rows = availableRows();
      if (!rows.length) return;
      const currentIndex = rows.indexOf(current);
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + rows.length) % rows.length;
      rows[nextIndex].focus();
    }

    function handleRowKeydown(event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRelativeRow(event.currentTarget, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRelativeRow(event.currentTarget, -1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const rows = availableRows();
        rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close({ restoreFocus: true });
      }
    }

    function selectValue(value) {
      const selected = models.find((model) => model.id === value);
      if (!selected || selected.disabled) return;
      currentValue = selected.id;
      input.value = currentValue;
      updateTrigger();
      input.dispatchEvent(new view.Event("change", { bubbles: true }));
      options.onChange?.(currentValue, selected);
      close({ restoreFocus: true });
    }

    function positionPopover() {
      if (!popover || !trigger.isConnected) return;
      const triggerRect = trigger.getBoundingClientRect();
      const modalRect = container
        .closest?.(".agents-modal")
        ?.getBoundingClientRect?.();
      const viewportWidth = Math.max(320, Number(view.innerWidth || doc.documentElement.clientWidth));
      const viewportHeight = Math.max(320, Number(view.innerHeight || doc.documentElement.clientHeight));
      const margin = 16;
      const width = Math.max(
        Math.min(triggerRect.width, viewportWidth - margin * 2),
        Math.min(1088, viewportWidth - margin * 2),
      );
      // Centered over the containing card; the popover may be wider than the
      // card (the provider-column layout needs ~1088px — clamping to a 720px
      // card starves it). In the 1120px Agents editor this reduces to the
      // historical 16px inset.
      const idealLeft = modalRect
        ? modalRect.left + (modalRect.width - width) / 2
        : triggerRect.left;
      const left = Math.min(Math.max(margin, idealLeft), viewportWidth - width - margin);
      const below = viewportHeight - triggerRect.bottom - 10;
      const above = triggerRect.top - 10;
      const openAbove = below < 320 && above > below;
      const available = Math.max(220, openAbove ? above - margin : below - margin);
      popover.style.width = `${Math.round(width)}px`;
      popover.style.left = `${Math.round(left)}px`;
      popover.style.maxHeight = `${Math.round(Math.min(560, available))}px`;
      const measuredHeight = Math.min(popover.scrollHeight, Math.min(560, available));
      const top = openAbove
        ? Math.max(margin, triggerRect.top - measuredHeight - 8)
        : Math.min(viewportHeight - measuredHeight - margin, triggerRect.bottom + 8);
      popover.style.top = `${Math.round(Math.max(margin, top))}px`;
      popover.classList.toggle("opens-above", openAbove);
    }

    function onDocumentPointerDown(event) {
      if (!popover) return;
      if (popover.contains(event.target) || trigger.contains(event.target)) return;
      close();
    }

    function onGlobalKeydown(event) {
      if (event.key === "Escape" && popover) {
        event.preventDefault();
        close({ restoreFocus: true });
      }
    }

    function open() {
      if (destroyed || popover) return;
      popover = doc.createElement("div");
      popover.id = pickerId;
      popover.className = "agent-model-picker-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", "Choose a base model");
      popover.innerHTML = `
        <label class="agent-model-picker-search-row">
          <span>${searchSvg()}</span>
          <input class="agent-model-picker-search" type="search" value="${escapeHtml(searchValue)}" placeholder="Search models" aria-label="Search models" autocomplete="off" />
        </label>
        <div class="agent-model-picker-tabs">
          <div class="agent-model-picker-tab is-active" aria-current="page">Models</div>
        </div>
        <div class="agent-model-picker-content">
          <div class="agent-model-picker-results"></div>
          ${renderGuide()}
        </div>`;
      doc.body.appendChild(popover);
      trigger.setAttribute("aria-expanded", "true");
      renderResults();
      const search = popover.querySelector(".agent-model-picker-search");
      search?.addEventListener("input", () => {
        searchValue = search.value;
        renderResults();
      });
      search?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          availableRows()[0]?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          close({ restoreFocus: true });
        }
      });
      doc.addEventListener("pointerdown", onDocumentPointerDown, true);
      doc.addEventListener("keydown", onGlobalKeydown, true);
      view.addEventListener("resize", positionPopover);
      view.addEventListener("scroll", positionPopover, true);
      positionPopover();
      view.requestAnimationFrame?.(() => {
        positionPopover();
        search?.focus();
      });
    }

    function close({ restoreFocus = false } = {}) {
      if (!popover) return;
      popover.remove();
      popover = null;
      trigger.setAttribute("aria-expanded", "false");
      doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
      doc.removeEventListener("keydown", onGlobalKeydown, true);
      view.removeEventListener("resize", positionPopover);
      view.removeEventListener("scroll", positionPopover, true);
      if (restoreFocus) trigger.focus();
    }

    function setModels(nextModels, { error = "" } = {}) {
      models = sortModels(nextModels);
      catalogError = String(error || "").trim();
      updateTrigger();
      renderResults();
      positionPopover();
      return models;
    }

    function setInvalid(message = "") {
      const invalid = Boolean(String(message || "").trim());
      trigger.setAttribute("aria-invalid", invalid ? "true" : "false");
      if (invalid) trigger.setAttribute("aria-errormessage", errorId);
      else trigger.removeAttribute("aria-errormessage");
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      trigger.removeEventListener("click", toggle);
      trigger.removeEventListener("keydown", onTriggerKeydown);
      container.removeEventListener("agent-model-picker-detach", destroy);
      delete container.agentModelPicker;
      delete container.dataset.agentModelPickerErrorId;
    }

    function toggle() {
      if (popover) close();
      else open();
    }

    function onTriggerKeydown(event) {
      if (["Enter", " ", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        open();
      } else if (event.key === "Escape") {
        close({ restoreFocus: true });
      }
    }

    trigger.addEventListener("click", toggle);
    trigger.addEventListener("keydown", onTriggerKeydown);
    container.addEventListener("agent-model-picker-detach", destroy);
    updateTrigger();

    const instance = {
      errorId,
      destroy,
      focus: () => trigger.focus(),
      getValue: () => currentValue,
      isUnavailableSelection,
      getUnavailableReason: unavailableReason,
      open,
      close,
      reposition: positionPopover,
      setInvalid,
      setModels,
      setError(error) {
        catalogError = String(error || "").trim();
        renderResults();
      },
    };
    container.agentModelPicker = instance;
    return instance;
  }

  return {
    LOCAL_MODELS_WARNING,
    PROVIDER_ORDER,
    PROVIDER_LABELS,
    TIER_ORDER,
    TIER_DEFINITIONS,
    buildFieldHtml,
    buildModelIdentityHtml,
    filterModels,
    groupModels,
    modelLogoSources,
    modelMatchesQuery,
    normalizeModel,
    sortModels,
    mount,
  };
});
