(function (root, factory) {
  const accordionVisibilityApi = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = accordionVisibilityApi;
  }

  if (root) {
    root.AccordionVisibility = accordionVisibilityApi;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAccordionVisibilityApi() {
  const ACCORDION_VISIBILITY_STATE_KEY = '__accordionVisibilityState';
  const DEFAULT_SETTLE_DELAY_MS = 320;
  const DEFAULT_SETTLE_PROPERTY_NAMES = ['max-height', 'height'];

  function resolveScrollContainer(accordion, options = {}) {
    if (typeof options.scrollContainer === 'function') {
      return options.scrollContainer(accordion) || null;
    }

    if (options.scrollContainer) {
      return options.scrollContainer;
    }

    return null;
  }

  function computeAccordionScrollTop({
    accordionRect,
    containerRect,
    currentScrollTop,
    topPadding = 16,
    bottomPadding = 20,
  }) {
    if (
      !accordionRect ||
      !containerRect ||
      !Number.isFinite(currentScrollTop)
    ) {
      return null;
    }

    const viewportTop = containerRect.top + topPadding;
    const viewportBottom = containerRect.bottom - bottomPadding;
    const availableHeight = Math.max(0, viewportBottom - viewportTop);

    if (availableHeight <= 0) {
      return null;
    }

    const accordionHeight = Number.isFinite(accordionRect.height)
      ? accordionRect.height
      : accordionRect.bottom - accordionRect.top;
    const accordionTop = accordionRect.top;
    const accordionBottom = accordionRect.bottom;

    if (accordionHeight > availableHeight) {
      if (accordionTop < viewportTop || accordionBottom > viewportBottom) {
        return currentScrollTop + (accordionTop - viewportTop);
      }
      return null;
    }

    if (accordionTop < viewportTop) {
      return currentScrollTop + (accordionTop - viewportTop);
    }

    if (accordionBottom > viewportBottom) {
      return currentScrollTop + (accordionBottom - viewportBottom);
    }

    return null;
  }

  function ensureAccordionVisibleWithinContainer(accordion, scrollContainer, options = {}) {
    if (
      !accordion ||
      !scrollContainer ||
      typeof accordion.getBoundingClientRect !== 'function' ||
      typeof scrollContainer.getBoundingClientRect !== 'function'
    ) {
      return false;
    }

    const targetScrollTop = computeAccordionScrollTop({
      accordionRect: accordion.getBoundingClientRect(),
      containerRect: scrollContainer.getBoundingClientRect(),
      currentScrollTop: Number(scrollContainer.scrollTop || 0),
      topPadding: options.topPadding,
      bottomPadding: options.bottomPadding,
    });

    if (!Number.isFinite(targetScrollTop)) {
      return false;
    }

    if (typeof scrollContainer.scrollTo === 'function') {
      scrollContainer.scrollTo({
        top: targetScrollTop,
        behavior: options.behavior || 'smooth',
      });
    } else {
      scrollContainer.scrollTop = targetScrollTop;
    }

    return true;
  }

  function defaultSchedule(callback) {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(() => requestAnimationFrame(callback));
    }

    if (typeof setTimeout === 'function') {
      return setTimeout(callback, 0);
    }

    callback();
    return null;
  }

  function isAccordionCollapsed(accordion) {
    return accordion?.classList?.contains?.('collapsed') === true;
  }

  function runExpandedAccordionVisibilityCheck(accordion, options = {}) {
    if (isAccordionCollapsed(accordion)) {
      return false;
    }

    const scrollContainer = resolveScrollContainer(accordion, options);
    if (!scrollContainer) {
      return false;
    }

    return ensureAccordionVisibleWithinContainer(accordion, scrollContainer, options);
  }

  function clearPendingAccordionVisibilitySettle(accordion) {
    const pendingState = accordion?.[ACCORDION_VISIBILITY_STATE_KEY];
    if (!pendingState) {
      return;
    }

    pendingState.removeTransitionListener?.();

    if (pendingState.timeoutId != null && typeof clearTimeout === 'function') {
      clearTimeout(pendingState.timeoutId);
    }

    try {
      delete accordion[ACCORDION_VISIBILITY_STATE_KEY];
    } catch (_error) {
      accordion[ACCORDION_VISIBILITY_STATE_KEY] = null;
    }
  }

  function scheduleSettledAccordionVisibility(accordion, options = {}) {
    if (!accordion || isAccordionCollapsed(accordion)) {
      return null;
    }

    clearPendingAccordionVisibilitySettle(accordion);

    const settlePropertyNames = Array.isArray(options.settlePropertyNames) &&
      options.settlePropertyNames.length > 0
      ? options.settlePropertyNames
      : DEFAULT_SETTLE_PROPERTY_NAMES;
    const settleDelayMs = Number.isFinite(options.settleDelayMs)
      ? options.settleDelayMs
      : DEFAULT_SETTLE_DELAY_MS;
    const pendingState = {};
    const settleVisibility = () => {
      clearPendingAccordionVisibilitySettle(accordion);
      return runExpandedAccordionVisibilityCheck(accordion, options);
    };

    if (typeof accordion.addEventListener === 'function') {
      const handleTransitionEnd = (event = {}) => {
        const propertyName = typeof event.propertyName === 'string'
          ? event.propertyName.trim()
          : '';

        if (propertyName && !settlePropertyNames.includes(propertyName)) {
          return;
        }

        settleVisibility();
      };

      accordion.addEventListener('transitionend', handleTransitionEnd);
      pendingState.removeTransitionListener = () => {
        accordion.removeEventListener?.('transitionend', handleTransitionEnd);
      };
    }

    if (settleDelayMs >= 0 && typeof setTimeout === 'function') {
      pendingState.timeoutId = setTimeout(() => {
        settleVisibility();
      }, settleDelayMs);
    }

    if (!pendingState.removeTransitionListener && pendingState.timeoutId == null) {
      return null;
    }

    accordion[ACCORDION_VISIBILITY_STATE_KEY] = pendingState;
    return pendingState;
  }

  function scheduleExpandedAccordionVisibility(accordion, options = {}) {
    const schedule = typeof options.schedule === 'function'
      ? options.schedule
      : defaultSchedule;

    clearPendingAccordionVisibilitySettle(accordion);

    return schedule(() => {
      const scrolledImmediately = runExpandedAccordionVisibilityCheck(accordion, options);
      scheduleSettledAccordionVisibility(accordion, options);
      return scrolledImmediately;
    });
  }

  return {
    computeAccordionScrollTop,
    ensureAccordionVisibleWithinContainer,
    scheduleExpandedAccordionVisibility,
  };
});
