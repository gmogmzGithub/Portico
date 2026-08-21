// Reasoning-effort slider — vanilla replica of OWUI's ReasoningEffortControl
// (src/patches/frontend/.../MessageInput/ReasoningEffortControl.svelte):
// a bolt+label trigger opening a top-anchored popover with a gradient slider
// fill, streaming particle animation, and a native range input overlay.
// Chat UI layer. Form contract: a hidden input named "reasoning_effort" so
// readAgentForm/serializeAgentEditorState keep reading via FormData ("" =
// model default).
(function attachAgentReasoningSlider(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === "object") {
    root.AgentReasoningSlider = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  // OWUI label map (allOptions in ReasoningEffortControl.svelte), plus the
  // agent editor's leading "Default" stop that maps back to "".
  const EFFORT_LABELS = Object.freeze({
    "": "Default",
    none: "None",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  });

  const BOLT_PATH = "M13.2 2.5 5.4 13.1h5.5l-1 8.4 8.7-12h-5.8l.4-7Z";
  let sliderSequence = 0;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function boltSvg(className) {
    return `<svg viewBox="0 0 24 24" fill="currentColor" class="${className}" aria-hidden="true"><path d="${BOLT_PATH}"></path></svg>`;
  }

  function chevronSvg() {
    return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5"></path></svg>`;
  }

  function labelFor(value) {
    return EFFORT_LABELS[value] ?? String(value || "");
  }

  function buildFieldHtml(value = "") {
    return `<div class="agent-reasoning-slider" data-agent-reasoning-slider data-current-value="${escapeHtml(value)}"></div>`;
  }

  // Compact read-only "bolt + level" chip (agent cards). Uses the same bolt +
  // color scheme as the slider trigger; the top tiers ("max"/"ultra") get the
  // purple data-effort-max treatment.
  function buildReasoningBadgeHtml(value = "") {
    const normalized = String(value || "").trim();
    if (!normalized) return "";
    const isMax = normalized === "max" || normalized === "ultra";
    return `<span class="agent-reasoning-badge"${isMax ? ' data-effort-max="true"' : ""}>${boltSvg("agent-reasoning-badge-bolt")}<span class="agent-reasoning-badge-label">${escapeHtml(labelFor(normalized))}</span></span>`;
  }

  function mount(container, options = {}) {
    if (!container || typeof container.querySelector !== "function") {
      throw new TypeError("AgentReasoningSlider.mount requires a DOM container");
    }
    container.agentReasoningSlider?.destroy?.();

    const doc = container.ownerDocument;
    const view = doc.defaultView || globalThis;
    const sliderId = `agent-reasoning-slider-${++sliderSequence}`;
    let fieldState = options.fieldState || {
      options: [],
      disabled: true,
      selectedValue: "",
      placeholder: "(default)",
    };
    let currentValue = String(fieldState.selectedValue ?? "");
    let popover = null;
    let destroyed = false;

    container.innerHTML = `
      <input type="hidden" name="reasoning_effort" value="${escapeHtml(currentValue)}" />
      <button
        type="button"
        class="agent-reasoning-trigger"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-controls="${sliderId}"
      >
        ${boltSvg("agent-reasoning-trigger-bolt")}
        <span class="agent-reasoning-trigger-label"></span>
        <span class="agent-reasoning-trigger-chevron">${chevronSvg()}</span>
      </button>`;
    const input = container.querySelector('input[name="reasoning_effort"]');
    const trigger = container.querySelector(".agent-reasoning-trigger");
    const triggerLabel = container.querySelector(".agent-reasoning-trigger-label");

    // Discrete stops: leading "Default" (= "") then the model's options.
    function stops() {
      return ["", ...(Array.isArray(fieldState.options) ? fieldState.options : [])];
    }

    function currentIndex() {
      const index = stops().indexOf(currentValue);
      return index >= 0 ? index : 0;
    }

    // Purple "max effort" theme only at the last REAL option, never Default.
    function isMaxEffort() {
      const opts = fieldState.options || [];
      return opts.length > 0 && currentValue === opts[opts.length - 1];
    }

    function progressPercent() {
      const max = stops().length - 1;
      return max > 0 ? (currentIndex() / max) * 100 : 100;
    }

    // OWUI: particle stream speeds up with effort (1.45s → 0.62s).
    function particleSpeedSeconds() {
      const max = stops().length - 1;
      const ratio = max > 0 ? currentIndex() / max : 1;
      return 1.45 - ratio * 0.83;
    }

    function updateTrigger() {
      const disabled = Boolean(fieldState.disabled);
      trigger.disabled = disabled;
      trigger.dataset.effortMax = !disabled && isMaxEffort() ? "true" : "false";
      triggerLabel.textContent = disabled
        ? fieldState.placeholder || "Not available"
        : labelFor(currentValue);
      trigger.classList.toggle("is-placeholder", disabled);
    }

    function syncHiddenInput({ silent = false } = {}) {
      // A disabled field must serialize as "" (hidden inputs always submit).
      const next = fieldState.disabled ? "" : currentValue;
      if (input.value === next) return;
      input.value = next;
      if (!silent) {
        input.dispatchEvent(new view.Event("change", { bubbles: true }));
      }
    }

    function particleSpansHtml() {
      return "<span></span>".repeat(7);
    }

    function renderPopoverContent() {
      if (!popover) return;
      const max = Math.max(stops().length - 1, 0);
      const effortMax = isMaxEffort() ? "true" : "false";
      popover.dataset.effortMax = effortMax;
      popover.innerHTML = `
        <div class="reasoning-effort-popover-heading">
          <div>
            <div class="reasoning-effort-popover-kicker">Reasoning effort</div>
            <div class="reasoning-effort-popover-value">${escapeHtml(labelFor(currentValue))}</div>
          </div>
          ${boltSvg("reasoning-effort-popover-bolt")}
        </div>
        <div
          class="reasoning-effort-slider-shell"
          data-effort-max="${effortMax}"
          style="--effort-progress: ${progressPercent()}%; --effort-particle-speed: ${particleSpeedSeconds().toFixed(2)}s;"
        >
          <div class="reasoning-effort-slider-track" aria-hidden="true">
            <div class="reasoning-effort-slider-fill">${particleSpansHtml()}</div>
          </div>
          <input
            class="reasoning-effort-slider"
            type="range"
            min="0"
            max="${max}"
            step="1"
            value="${currentIndex()}"
            aria-label="Reasoning effort"
            aria-valuetext="${escapeHtml(labelFor(currentValue))}"
          />
        </div>
        <div class="reasoning-effort-slider-labels" aria-hidden="true">
          <span>Faster</span>
          <span>Smarter</span>
        </div>`;
      popover
        .querySelector(".reasoning-effort-slider")
        ?.addEventListener("input", (event) => {
          selectIndex(Number(event.currentTarget.value));
        });
    }

    // Update visuals in place — re-rendering the range mid-drag would break it.
    function updatePopoverVisuals() {
      if (!popover) return;
      const effortMax = isMaxEffort() ? "true" : "false";
      popover.dataset.effortMax = effortMax;
      const shell = popover.querySelector(".reasoning-effort-slider-shell");
      if (shell) {
        shell.dataset.effortMax = effortMax;
        shell.style.setProperty("--effort-progress", `${progressPercent()}%`);
        shell.style.setProperty(
          "--effort-particle-speed",
          `${particleSpeedSeconds().toFixed(2)}s`,
        );
      }
      const valueEl = popover.querySelector(".reasoning-effort-popover-value");
      if (valueEl) valueEl.textContent = labelFor(currentValue);
      const range = popover.querySelector(".reasoning-effort-slider");
      if (range) {
        range.setAttribute("aria-valuetext", labelFor(currentValue));
        if (Number(range.value) !== currentIndex()) {
          range.value = String(currentIndex());
        }
      }
    }

    function selectIndex(index) {
      const nextValue = stops()[index];
      if (nextValue === undefined || nextValue === currentValue) return;
      currentValue = nextValue;
      syncHiddenInput();
      updateTrigger();
      updatePopoverVisuals();
      options.onChange?.(currentValue);
    }

    // side=top align=center offset 12 (flip below only when no room above).
    function positionPopover() {
      if (!popover || !trigger.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = Math.max(320, Number(view.innerWidth || doc.documentElement.clientWidth));
      const viewportHeight = Math.max(320, Number(view.innerHeight || doc.documentElement.clientHeight));
      const width = Math.min(320, viewportWidth - 24);
      popover.style.width = `${Math.round(width)}px`;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.min(Math.max(12, left), viewportWidth - width - 12);
      const height = popover.offsetHeight;
      const spaceAbove = rect.top - 12;
      const spaceBelow = viewportHeight - rect.bottom - 12;
      const openAbove = spaceAbove >= height || spaceAbove >= spaceBelow;
      const top = openAbove
        ? Math.max(12, rect.top - height - 12)
        : Math.min(viewportHeight - height - 12, rect.bottom + 12);
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
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
      if (destroyed || popover || fieldState.disabled) return;
      popover = doc.createElement("div");
      popover.id = sliderId;
      popover.className = "reasoning-effort-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", "Reasoning effort");
      renderPopoverContent();
      doc.body.appendChild(popover);
      trigger.setAttribute("aria-expanded", "true");
      doc.addEventListener("pointerdown", onDocumentPointerDown, true);
      doc.addEventListener("keydown", onGlobalKeydown, true);
      view.addEventListener("resize", positionPopover);
      view.addEventListener("scroll", positionPopover, true);
      positionPopover();
      // flyAndScale-style entrance (translateY + scale + fade, ~150ms).
      view.requestAnimationFrame?.(() => {
        positionPopover();
        popover?.classList.add("is-open");
        popover?.querySelector(".reasoning-effort-slider")?.focus();
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

    function toggle() {
      if (popover) close();
      else open();
    }

    function onTriggerKeydown(event) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        open();
      } else if (event.key === "Escape") {
        close({ restoreFocus: true });
      }
    }

    // Stops depend on the selected base model; called on every model change.
    function setFieldState(nextFieldState) {
      fieldState = nextFieldState || fieldState;
      currentValue = String(fieldState.selectedValue ?? "");
      if (!stops().includes(currentValue)) currentValue = "";
      syncHiddenInput({ silent: true });
      updateTrigger();
      if (popover) {
        if (fieldState.disabled) {
          close();
        } else {
          renderPopoverContent();
          positionPopover();
        }
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      trigger.removeEventListener("click", toggle);
      trigger.removeEventListener("keydown", onTriggerKeydown);
      container.removeEventListener("agent-reasoning-slider-detach", destroy);
      delete container.agentReasoningSlider;
    }

    trigger.addEventListener("click", toggle);
    trigger.addEventListener("keydown", onTriggerKeydown);
    container.addEventListener("agent-reasoning-slider-detach", destroy);
    updateTrigger();
    syncHiddenInput({ silent: true });

    const instance = {
      destroy,
      getValue: () => (fieldState.disabled ? "" : currentValue),
      open,
      close,
      reposition: positionPopover,
      setFieldState,
    };
    container.agentReasoningSlider = instance;
    return instance;
  }

  return {
    EFFORT_LABELS,
    buildFieldHtml,
    buildReasoningBadgeHtml,
    mount,
  };
});
