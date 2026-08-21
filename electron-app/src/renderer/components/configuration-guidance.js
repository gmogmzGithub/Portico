(function (root, factory) {
  const configurationGuidanceApi = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = configurationGuidanceApi;
  }

  if (root) {
    root.ConfigurationGuidance = configurationGuidanceApi;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createConfigurationGuidanceApi() {
  function resolveConfigurationPulseTarget({
    ready,
    confirmationId = null,
    hasFirstAccordion,
    firstAccordionDismissed,
  }) {
    if (confirmationId) {
      return 'confirmation';
    }

    if (ready) {
      return 'save';
    }

    if (hasFirstAccordion && !firstAccordionDismissed) {
      return 'accordion';
    }

    return null;
  }

  function createConfigurationGuidanceController() {
    const state = {
      activeServerId: null,
      firstAccordionId: null,
      firstAccordionPulseDismissed: false,
    };

    return {
      reset(serverId = null) {
        state.activeServerId = serverId;
        state.firstAccordionId = null;
        state.firstAccordionPulseDismissed = false;
      },

      startArrival({
        serverId = null,
        firstAccordionId = null,
        ready = false,
        confirmationId = null,
      } = {}) {
        state.activeServerId = serverId;
        state.firstAccordionId = firstAccordionId;
        state.firstAccordionPulseDismissed = Boolean(ready || !firstAccordionId);

        return resolveConfigurationPulseTarget({
          ready,
          confirmationId,
          hasFirstAccordion: Boolean(firstAccordionId),
          firstAccordionDismissed: state.firstAccordionPulseDismissed,
        });
      },

      handleAccordionToggle({
        accordionId = null,
        isCollapsed = true,
        ready = false,
        confirmationId = null,
      } = {}) {
        if (accordionId && accordionId === state.firstAccordionId && !isCollapsed) {
          state.firstAccordionPulseDismissed = true;
        }

        if (ready) {
          state.firstAccordionPulseDismissed = true;
        }

        return resolveConfigurationPulseTarget({
          ready,
          confirmationId,
          hasFirstAccordion: Boolean(state.firstAccordionId),
          firstAccordionDismissed: state.firstAccordionPulseDismissed,
        });
      },

      getPulseTarget({ ready = false, confirmationId = null } = {}) {
        if (ready) {
          state.firstAccordionPulseDismissed = true;
        }

        return resolveConfigurationPulseTarget({
          ready,
          confirmationId,
          hasFirstAccordion: Boolean(state.firstAccordionId),
          firstAccordionDismissed: state.firstAccordionPulseDismissed,
        });
      },

      getState() {
        return {
          activeServerId: state.activeServerId,
          firstAccordionId: state.firstAccordionId,
          firstAccordionPulseDismissed: state.firstAccordionPulseDismissed,
        };
      },
    };
  }

  function evaluateConfigurationReadiness(inputs, callbacks = {}, options = {}) {
    const activeInputs = Array.from(inputs || []).filter((input) => input && !input.disabled);
    const unresolvedConfirmationCount = Number(options.unresolvedConfirmationCount || 0);

    if (unresolvedConfirmationCount > 0) {
      return {
        ready: false,
        activeInputCount: activeInputs.length,
        unresolvedConfirmationCount,
      };
    }

    for (const input of activeInputs) {
      const rawValue = typeof input.value === 'string' ? input.value : '';
      const fieldName = input.dataset?.var ? input.dataset.var.split(',')[0] : 'field';
      const validation = callbacks.validateEnvValue
        ? callbacks.validateEnvValue(rawValue, fieldName, input)
        : { valid: !!rawValue.trim(), value: rawValue.trim() };

      if (!validation.valid) {
        return {
          ready: false,
          activeInputCount: activeInputs.length,
          unresolvedConfirmationCount,
        };
      }
    }

    return {
      ready: true,
      activeInputCount: activeInputs.length,
      unresolvedConfirmationCount,
    };
  }

  return {
    createConfigurationGuidanceController,
    evaluateConfigurationReadiness,
    resolveConfigurationPulseTarget,
  };
});
