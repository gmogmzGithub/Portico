// Confirmation card component for guided setup
// Extracted from guided-setup.js

const CONFIRMATION_FOLLOW_UP_STATE_KEY = '__guidedSetupConfirmationFollowUpState';
const DEFAULT_CONFIRMATION_FOLLOW_UP_TIMEOUT_MS = 1500;

function getConfirmationFollowUpContext(confirmationId, context) {
  return `${context}-after-${confirmationId}`;
}

function getConfirmationFollowUpAccordionOptions(context, callbacks = {}) {
  const shouldCollapseAccordions = typeof context === 'string' && context.startsWith('server-config');

  if (!shouldCollapseAccordions) {
    return undefined;
  }

  return {
    startCollapsed: true,
    autoExpandFirst: true,
    onToggle: callbacks.handleConfigurationAccordionToggle,
    scrollContainer: callbacks.getConfigurationScrollContainer?.(),
  };
}

function clearPendingConfirmationFollowUp(afterContent) {
  const pendingState = afterContent?.[CONFIRMATION_FOLLOW_UP_STATE_KEY];
  if (!pendingState) {
    return;
  }

  pendingState.observer?.disconnect?.();

  if (pendingState.timeoutId != null && typeof clearTimeout === 'function') {
    clearTimeout(pendingState.timeoutId);
  }

  try {
    delete afterContent[CONFIRMATION_FOLLOW_UP_STATE_KEY];
  } catch (_error) {
    afterContent[CONFIRMATION_FOLLOW_UP_STATE_KEY] = null;
  }
}

function createConfirmationFollowUpAccordions(afterContent, confirmationId, context, callbacks = {}) {
  if (!afterContent || typeof callbacks.createAccordionsForVisibleContent !== 'function') {
    return [];
  }

  const createdAccordions = callbacks.createAccordionsForVisibleContent(
    afterContent,
    getConfirmationFollowUpContext(confirmationId, context),
    getConfirmationFollowUpAccordionOptions(context, callbacks),
  );

  return Array.isArray(createdAccordions) ? createdAccordions : [];
}

function watchDeferredConfirmationFollowUp(afterContent, confirmationId, context, callbacks = {}) {
  if (
    !afterContent ||
    typeof callbacks.createAccordionsForVisibleContent !== 'function' ||
    typeof MutationObserver !== 'function'
  ) {
    return null;
  }

  clearPendingConfirmationFollowUp(afterContent);

  const stopWatching = () => {
    clearPendingConfirmationFollowUp(afterContent);
  };

  const tryCreateAccordions = () => {
    const createdAccordions = createConfirmationFollowUpAccordions(
      afterContent,
      confirmationId,
      context,
      callbacks,
    );
    if (createdAccordions.length === 0) {
      return false;
    }

    stopWatching();
    callbacks.refreshConfigurationGuidance?.();
    return true;
  };

  const observer = new MutationObserver(() => {
    tryCreateAccordions();
  });
  observer.observe(afterContent, { childList: true, subtree: true });

  const timeoutMs = Number.isFinite(callbacks.confirmationFollowUpTimeoutMs)
    ? callbacks.confirmationFollowUpTimeoutMs
    : DEFAULT_CONFIRMATION_FOLLOW_UP_TIMEOUT_MS;
  const timeoutId = timeoutMs >= 0 && typeof setTimeout === 'function'
    ? setTimeout(() => {
      stopWatching();
    }, timeoutMs)
    : null;

  afterContent[CONFIRMATION_FOLLOW_UP_STATE_KEY] = {
    observer,
    timeoutId,
  };

  return {
    stop: stopWatching,
  };
}

// Generate confirmation card HTML
function generateConfirmationCard(message, confirmationId, context) {
  const cannedMessage = context === 'server-config'
    ? "Clicking 'No' will skip the rest of this server's configuration.<br>You can re-launch this setup wizard at any time to complete your configuration later."
    : "You can re-launch this setup wizard at any time to complete your configuration later.";

  return `
    <div class="confirmation-card" id="${confirmationId}" data-guidance-target="confirmation">
      <div class="confirmation-message">${message}</div>
      <div class="confirmation-canned-message">${cannedMessage}</div>
      <div class="confirmation-buttons">
        <button class="btn btn-confirm-yes" type="button" onclick="handleConfirmationYes('${confirmationId}', '${context}')">
          <span class="confirmation-button-icon" aria-hidden="true">✓</span>
          <span>Yes</span>
        </button>
        <button class="btn btn-confirm-no" type="button" onclick="handleConfirmationNo('${confirmationId}', '${context}')">
          <span class="confirmation-button-icon" aria-hidden="true">✕</span>
          <span>No</span>
        </button>
      </div>
    </div>
  `;
}

// Handle confirmation Yes button
// Callbacks must be provided to handle accordion and content display
function handleConfirmationYes(confirmationId, context, callbacks = {}) {
  console.log('[handleConfirmationYes] User clicked Yes for:', confirmationId);

  // Hide the confirmation card
  const confirmationCard = document.getElementById(confirmationId);
  if (confirmationCard) {
    confirmationCard.style.display = 'none';
  }

  // Mark accordion containing confirmation as completed and collapse it
  if (callbacks.markAccordionsAsCompleted) {
    callbacks.markAccordionsAsCompleted(confirmationId);
  }

  // Show and process content after this confirmation
  const afterContent = document.getElementById(`after-${confirmationId}`);
  if (afterContent) {
    // Show the content first
    afterContent.classList.add('visible');

    // Then create accordions for the newly revealed content
    const createdAccordions = createConfirmationFollowUpAccordions(
      afterContent,
      confirmationId,
      context,
      callbacks,
    );
    if (createdAccordions.length === 0) {
      watchDeferredConfirmationFollowUp(afterContent, confirmationId, context, callbacks);
    } else {
      clearPendingConfirmationFollowUp(afterContent);
    }
    console.log('[handleConfirmationYes] Processed and showing content after confirmation');
  }

  if (callbacks.refreshConfigurationGuidance) {
    callbacks.refreshConfigurationGuidance();
  }

  if (callbacks.addLog) {
    callbacks.addLog('Continuing with configuration...', 'info');
  }
}

// Handle confirmation No button
function handleConfirmationNo(confirmationId, context, callbacks = {}) {
  console.log('[handleConfirmationNo] User clicked No for:', confirmationId, 'context:', context);

  if (context === 'server-config') {
    // Skip the current server using existing skip logic
    if (callbacks.addLog) {
      callbacks.addLog('Skipping server configuration based on user choice...', 'warning');
    }
    if (callbacks.handleSkipServer) {
      callbacks.handleSkipServer();
    }
  } else if (context === 'portico-api') {
    // For Portico API context, this would be unusual but handle gracefully
    if (callbacks.addLog) {
      callbacks.addLog('Configuration cancelled by user', 'warning');
    }
    // Could go back to welcome or handle differently
    if (callbacks.showStage) {
      callbacks.showStage('welcome');
    }
  }
}

// Create window-exposed versions that use global callbacks
function createWindowHandlers(callbacks) {
  window.handleConfirmationYes = (confirmationId, context) => {
    handleConfirmationYes(confirmationId, context, callbacks);
  };

  window.handleConfirmationNo = (confirmationId, context) => {
    handleConfirmationNo(confirmationId, context, callbacks);
  };
}

// Export functions
module.exports = {
  generateConfirmationCard,
  handleConfirmationYes,
  handleConfirmationNo,
  createWindowHandlers
};

// Also expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.generateConfirmationCard = generateConfirmationCard;
}
