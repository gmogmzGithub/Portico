(function (root, factory) {
  const configurationGuidanceApi =
    root?.ConfigurationGuidance ||
    (typeof require === 'function' ? require('./configuration-guidance') : null);
  const api = factory(configurationGuidanceApi);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.McpConfigGuidance = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMcpConfigGuidanceApi(configurationGuidanceApi) {
  if (!configurationGuidanceApi) {
    throw new Error('McpConfigGuidance requires ConfigurationGuidance');
  }

  const {
    createConfigurationGuidanceController,
    evaluateConfigurationReadiness,
  } = configurationGuidanceApi;

  const MCP_CONFIG_SAVE_PULSE_CLASS = 'is-pulsing';
  const MCP_CONFIG_ACCORDION_PULSE_CLASS = 'is-guidance-pulsing';
  const MCP_CONFIG_CONFIRMATION_PULSE_CLASS = 'is-guidance-pulsing';
  const MCP_CONFIG_INPUT_PULSE_CLASS = 'is-input-guidance-pulsing';

  const mcpConfigGuidanceController = createConfigurationGuidanceController();

  function getMcpConfigElements(doc = globalThis.document) {
    return {
      configContent: doc?.getElementById?.('mcp-config-content') || null,
      saveButton: doc?.getElementById?.('mcp-config-save-btn') || null,
    };
  }

  function getActiveMcpConfigInputs(doc = globalThis.document) {
    const { configContent } = getMcpConfigElements(doc);
    if (configContent?.querySelectorAll) {
      return Array.from(configContent.querySelectorAll('.input-field:not([disabled])'))
        .filter((input) => input && !input.disabled);
    }

    return [];
  }

  function inputNeedsConfigurationValue(input) {
    if (!input || input.dataset?.optional) {
      return false;
    }

    if (typeof input.value === 'string') {
      return input.value.trim().length === 0;
    }

    return !input.value;
  }

  function hasElementClass(element, className) {
    return Boolean(element?.classList?.contains?.(className));
  }

  function findClosestElementByClass(element, className) {
    let current = element?.parentElement || element?.parentNode || null;

    while (current) {
      if (hasElementClass(current, className)) {
        return current;
      }

      current = current.parentElement || current.parentNode || null;
    }

    return null;
  }

  function isConfirmationAnswered(card) {
    return hasElementClass(card, 'confirmed') || hasElementClass(card, 'skipped');
  }

  function isMcpConfigConfirmationCardVisible(card) {
    if (!card || isConfirmationAnswered(card) || card.style?.display === 'none') {
      return false;
    }

    const hiddenConfirmationContent = findClosestElementByClass(card, 'mcp-config-content-after-confirmation');
    if (hiddenConfirmationContent && hasElementClass(hiddenConfirmationContent, 'hidden')) {
      return false;
    }

    const parentAccordion = findClosestElementByClass(card, 'mcp-config-accordion');
    if (parentAccordion && hasElementClass(parentAccordion, 'collapsed')) {
      return false;
    }

    return true;
  }

  function getUnansweredMcpConfigConfirmationCards(doc = globalThis.document) {
    const { configContent } = getMcpConfigElements(doc);
    if (!configContent?.querySelectorAll) {
      return [];
    }

    return Array.from(configContent.querySelectorAll('.mcp-config-confirmation-card'))
      .filter((card) => card?.style?.display !== 'none' && !isConfirmationAnswered(card));
  }

  function getVisibleMcpConfigConfirmationCard(doc = globalThis.document) {
    const cards = getUnansweredMcpConfigConfirmationCards(doc);
    return cards.find((card) => isMcpConfigConfirmationCardVisible(card)) || null;
  }

  function clearMcpConfigPulseState(doc = globalThis.document) {
    const { configContent, saveButton } = getMcpConfigElements(doc);

    saveButton?.classList?.remove?.(MCP_CONFIG_SAVE_PULSE_CLASS);

    if (!configContent?.querySelectorAll) {
      return;
    }

    configContent
      .querySelectorAll(`.mcp-config-accordion.${MCP_CONFIG_ACCORDION_PULSE_CLASS}`)
      .forEach((accordion) => accordion.classList?.remove?.(MCP_CONFIG_ACCORDION_PULSE_CLASS));
    configContent
      .querySelectorAll(`.mcp-config-confirmation-card.${MCP_CONFIG_CONFIRMATION_PULSE_CLASS}`)
      .forEach((card) => card.classList?.remove?.(MCP_CONFIG_CONFIRMATION_PULSE_CLASS));
  }

  function clearMcpConfigInputPulseState(doc = globalThis.document) {
    getActiveMcpConfigInputs(doc).forEach((input) => {
      input?.classList?.remove?.(MCP_CONFIG_INPUT_PULSE_CLASS);
    });
  }

  function findFirstPendingMcpConfigAccordionInput(accordion, doc = globalThis.document) {
    if (!accordion) {
      return null;
    }

    return getActiveMcpConfigInputs(doc).find((input) => (
      findClosestElementByClass(input, 'mcp-config-accordion') === accordion &&
      inputNeedsConfigurationValue(input)
    )) || null;
  }

  function focusMcpConfigAccordionInput(accordion, doc = globalThis.document) {
    clearMcpConfigInputPulseState(doc);

    const targetInput = findFirstPendingMcpConfigAccordionInput(accordion, doc);
    if (!targetInput) {
      return null;
    }

    targetInput.classList?.add?.(MCP_CONFIG_INPUT_PULSE_CLASS);

    try {
      targetInput.focus?.({ preventScroll: true });
    } catch (_error) {
      targetInput.focus?.();
    }

    return targetInput;
  }

  function applyMcpConfigPulseState(
    pulseTarget,
    {
      accordionId = null,
      confirmationId = null,
    } = {},
    doc = globalThis.document,
  ) {
    clearMcpConfigPulseState(doc);

    const { saveButton } = getMcpConfigElements(doc);
    if (pulseTarget === 'save') {
      saveButton?.classList?.add?.(MCP_CONFIG_SAVE_PULSE_CLASS);
      return pulseTarget;
    }

    if (pulseTarget === 'accordion' && accordionId) {
      const accordion = doc?.getElementById?.(accordionId);
      accordion?.classList?.add?.(MCP_CONFIG_ACCORDION_PULSE_CLASS);
      return pulseTarget;
    }

    if (pulseTarget === 'confirmation' && confirmationId) {
      const confirmationCard = doc?.getElementById?.(confirmationId);
      confirmationCard?.classList?.add?.(MCP_CONFIG_CONFIRMATION_PULSE_CLASS);
      return pulseTarget;
    }

    return null;
  }

  function getMcpConfigReadiness(callbacks = {}, doc = globalThis.document) {
    const unresolvedConfirmations = getUnansweredMcpConfigConfirmationCards(doc);
    return evaluateConfigurationReadiness(getActiveMcpConfigInputs(doc), callbacks, {
      unresolvedConfirmationCount: unresolvedConfirmations.length,
    });
  }

  function bindMcpConfigInputListeners(callbacks = {}, doc = globalThis.document) {
    const { configContent } = getMcpConfigElements(doc);
    if (!configContent || configContent.dataset.mcpConfigGuidanceBound === 'true') {
      return;
    }

    const handleInput = (event) => {
      if (event?.target?.classList?.contains?.('input-field')) {
        event.target.classList?.remove?.(MCP_CONFIG_INPUT_PULSE_CLASS);
        refreshMcpConfigGuidance(callbacks, doc);
      }
    };

    configContent.dataset.mcpConfigGuidanceBound = 'true';
    if (typeof configContent.addEventListener === 'function') {
      configContent.addEventListener('input', handleInput);
      configContent.addEventListener('change', handleInput);
    }
  }

  function initializeMcpConfigGuidance(server = {}, callbacks = {}, doc = globalThis.document) {
    bindMcpConfigInputListeners(callbacks, doc);

    const { configContent, saveButton } = getMcpConfigElements(doc);
    const firstAccordion = configContent?.querySelector?.('.mcp-config-accordion') || null;
    const readiness = getMcpConfigReadiness(callbacks, doc);
    const confirmationCard = getVisibleMcpConfigConfirmationCard(doc);
    const pulseTarget = saveButton?.disabled
      ? null
      : mcpConfigGuidanceController.startArrival({
        serverId: server?.id || null,
        firstAccordionId: firstAccordion?.id || null,
        ready: readiness.ready,
        confirmationId: confirmationCard?.id || null,
      });

    applyMcpConfigPulseState(
      pulseTarget,
      {
        accordionId: firstAccordion?.id || null,
        confirmationId: confirmationCard?.id || null,
      },
      doc,
    );

    return {
      readiness,
      pulseTarget,
      firstAccordionId: firstAccordion?.id || null,
      confirmationId: confirmationCard?.id || null,
    };
  }

  function refreshMcpConfigGuidance(callbacks = {}, doc = globalThis.document) {
    const { saveButton } = getMcpConfigElements(doc);
    const readiness = getMcpConfigReadiness(callbacks, doc);
    const confirmationCard = getVisibleMcpConfigConfirmationCard(doc);
    const pulseTarget = saveButton?.disabled
      ? null
      : mcpConfigGuidanceController.getPulseTarget({
        ready: readiness.ready,
        confirmationId: confirmationCard?.id || null,
      });
    const { firstAccordionId } = mcpConfigGuidanceController.getState();

    applyMcpConfigPulseState(
      pulseTarget,
      {
        accordionId: firstAccordionId,
        confirmationId: confirmationCard?.id || null,
      },
      doc,
    );

    return {
      readiness,
      pulseTarget,
      confirmationId: confirmationCard?.id || null,
    };
  }

  function handleMcpConfigAccordionToggle(details = {}, callbacks = {}, doc = globalThis.document) {
    const accordion = details.accordionId
      ? doc?.getElementById?.(details.accordionId) || null
      : null;
    const { saveButton } = getMcpConfigElements(doc);
    const readiness = getMcpConfigReadiness(callbacks, doc);
    const confirmationCard = getVisibleMcpConfigConfirmationCard(doc);
    const pulseTarget = saveButton?.disabled
      ? null
      : mcpConfigGuidanceController.handleAccordionToggle({
        accordionId: details.accordionId,
        isCollapsed: details.isCollapsed,
        ready: readiness.ready,
        confirmationId: confirmationCard?.id || null,
      });
    const { firstAccordionId } = mcpConfigGuidanceController.getState();

    applyMcpConfigPulseState(
      pulseTarget,
      {
        accordionId: firstAccordionId,
        confirmationId: confirmationCard?.id || null,
      },
      doc,
    );

    let focusedInput = null;
    if (details.isCollapsed) {
      clearMcpConfigInputPulseState(doc);
    } else {
      focusedInput = focusMcpConfigAccordionInput(accordion, doc);
    }

    return {
      readiness,
      pulseTarget,
      confirmationId: confirmationCard?.id || null,
      focusedInputId: focusedInput?.id || null,
    };
  }

  function resetMcpConfigGuidance(serverId = null, doc = globalThis.document) {
    clearMcpConfigPulseState(doc);
    clearMcpConfigInputPulseState(doc);
    mcpConfigGuidanceController.reset(serverId);
  }

  return {
    MCP_CONFIG_ACCORDION_PULSE_CLASS,
    MCP_CONFIG_CONFIRMATION_PULSE_CLASS,
    MCP_CONFIG_INPUT_PULSE_CLASS,
    MCP_CONFIG_SAVE_PULSE_CLASS,
    clearMcpConfigInputPulseState,
    clearMcpConfigPulseState,
    createMcpConfigGuidanceController: createConfigurationGuidanceController,
    focusMcpConfigAccordionInput,
    getMcpConfigReadiness,
    initializeMcpConfigGuidance,
    refreshMcpConfigGuidance,
    handleMcpConfigAccordionToggle,
    resetMcpConfigGuidance,
  };
});
