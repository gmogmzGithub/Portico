// Configuration screen module for guided setup
// Handles individual server configuration
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

const {
  createConfigurationGuidanceController,
  evaluateConfigurationReadiness,
  resolveConfigurationPulseTarget,
} = require('../../components/configuration-guidance');
const {
  getRequiredEnvVars,
} = require('../../../services/guided-setup/server-requirements');

const CONFIGURATION_SAVE_LABEL = 'Save & Continue';
const CONFIGURATION_SKIP_LABEL = 'Skip';
const CONFIGURATION_SKIP_ALL_LABEL = 'Skip All';
const CONFIGURATION_SAVE_PULSE_CLASS = 'is-pulsing';
const CONFIGURATION_ACCORDION_PULSE_CLASS = 'is-guidance-pulsing';
const CONFIGURATION_CONFIRMATION_PULSE_CLASS = 'is-guidance-pulsing';
const CONFIGURATION_INPUT_PULSE_CLASS = 'is-input-guidance-pulsing';

const configurationGuidanceController = createConfigurationGuidanceController();

function getConfigurationElements(doc = globalThis.document) {
  return {
    configContent: doc?.getElementById?.('config-content') || null,
    saveButton: doc?.getElementById?.('save-btn') || null,
    skipAllButton: doc?.getElementById?.('skip-all-servers-btn') || null,
    titleElement: doc?.getElementById?.('configuration-card-title') || null,
  };
}

function getActiveConfigurationInputs(doc = globalThis.document) {
  const { configContent } = getConfigurationElements(doc);
  if (configContent?.querySelectorAll) {
    return Array.from(configContent.querySelectorAll('.input-field:not([disabled])'))
      .filter((input) => input && !input.disabled);
  }

  if (doc?.querySelectorAll) {
    return Array.from(doc.querySelectorAll('.setup-stage.active .input-field:not([disabled])'))
      .filter((input) => input && !input.disabled);
  }

  return [];
}

function getConfigurationReadiness(callbacks = {}, doc = globalThis.document) {
  const unresolvedConfirmations = getUnansweredConfirmationCards(doc);
  return evaluateConfigurationReadiness(getActiveConfigurationInputs(doc), callbacks, {
    unresolvedConfirmationCount: unresolvedConfirmations.length,
  });
}

function inputNeedsConfigurationValue(input) {
  if (!input) {
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

function isConfirmationCardVisible(card) {
  if (!card) {
    return false;
  }

  if (card.style?.display === 'none') {
    return false;
  }

  const hiddenConfirmationContent = findClosestElementByClass(card, 'content-after-confirmation');
  if (hiddenConfirmationContent && !hasElementClass(hiddenConfirmationContent, 'visible')) {
    return false;
  }

  const parentAccordion = findClosestElementByClass(card, 'accordion-section');
  if (parentAccordion && hasElementClass(parentAccordion, 'collapsed')) {
    return false;
  }

  return true;
}

function getVisibleConfirmationCard(doc = globalThis.document) {
  const { configContent } = getConfigurationElements(doc);
  if (!configContent?.querySelectorAll) {
    return null;
  }

  const confirmationCards = getUnansweredConfirmationCards(doc);
  return confirmationCards.find((card) => isConfirmationCardVisible(card)) || null;
}

function getUnansweredConfirmationCards(doc = globalThis.document) {
  const { configContent } = getConfigurationElements(doc);
  if (!configContent?.querySelectorAll) {
    return [];
  }

  return Array.from(configContent.querySelectorAll('.confirmation-card'))
    .filter((card) => card?.style?.display !== 'none');
}

function clearConfigurationPulseState(doc = globalThis.document) {
  const { configContent, saveButton } = getConfigurationElements(doc);

  if (saveButton?.classList) {
    saveButton.classList.remove(CONFIGURATION_SAVE_PULSE_CLASS);
  }

  if (!configContent?.querySelectorAll) {
    return;
  }

  configContent
    .querySelectorAll(`.accordion-section.${CONFIGURATION_ACCORDION_PULSE_CLASS}`)
    .forEach((accordion) => accordion.classList?.remove?.(CONFIGURATION_ACCORDION_PULSE_CLASS));
  configContent
    .querySelectorAll(`.confirmation-card.${CONFIGURATION_CONFIRMATION_PULSE_CLASS}`)
    .forEach((card) => card.classList?.remove?.(CONFIGURATION_CONFIRMATION_PULSE_CLASS));
}

function clearConfigurationInputPulseState(doc = globalThis.document) {
  getActiveConfigurationInputs(doc).forEach((input) => {
    input?.classList?.remove?.(CONFIGURATION_INPUT_PULSE_CLASS);
  });
}

function findFirstPendingAccordionInput(accordion, doc = globalThis.document) {
  if (!accordion) {
    return null;
  }

  return getActiveConfigurationInputs(doc).find((input) => (
    findClosestElementByClass(input, 'accordion-section') === accordion &&
    inputNeedsConfigurationValue(input)
  )) || null;
}

function focusConfigurationAccordionInput(accordion, doc = globalThis.document) {
  clearConfigurationInputPulseState(doc);

  const targetInput = findFirstPendingAccordionInput(accordion, doc);
  if (!targetInput) {
    return null;
  }

  targetInput.classList?.add?.(CONFIGURATION_INPUT_PULSE_CLASS);

  try {
    targetInput.focus?.({ preventScroll: true });
  } catch (_error) {
    targetInput.focus?.();
  }

  return targetInput;
}

function syncConfigurationSaveButtonVisibility(readiness, doc = globalThis.document) {
  const { saveButton } = getConfigurationElements(doc);
  if (!saveButton?.style) {
    return false;
  }

  const shouldShow = readiness?.ready === true;
  saveButton.style.display = shouldShow ? '' : 'none';

  return shouldShow;
}

function hasAdditionalPendingConfigurationServers(setupState = {}) {
  const currentServerIndex = Number.isInteger(setupState?.currentServerIndex)
    ? setupState.currentServerIndex
    : 0;

  return getNextPendingConfigurationIndex(setupState, currentServerIndex + 1) !== -1;
}

function syncConfigurationSkipAllButtonVisibility(setupState = {}, doc = globalThis.document) {
  const { skipAllButton } = getConfigurationElements(doc);
  if (!skipAllButton?.style) {
    return false;
  }

  const shouldShow = hasAdditionalPendingConfigurationServers(setupState);
  skipAllButton.style.display = shouldShow ? '' : 'none';

  if (shouldShow) {
    skipAllButton.disabled = false;
    skipAllButton.textContent = CONFIGURATION_SKIP_ALL_LABEL;
  }

  return shouldShow;
}

function applyConfigurationPulseState(
  pulseTarget,
  {
    accordionId = null,
    confirmationId = null,
  } = {},
  doc = globalThis.document,
) {
  clearConfigurationPulseState(doc);

  const { saveButton } = getConfigurationElements(doc);
  if (pulseTarget === 'save') {
    saveButton?.classList?.add?.(CONFIGURATION_SAVE_PULSE_CLASS);
    return pulseTarget;
  }

  if (pulseTarget === 'accordion' && accordionId) {
    const accordion = doc?.getElementById?.(accordionId);
    accordion?.classList?.add?.(CONFIGURATION_ACCORDION_PULSE_CLASS);
    return pulseTarget;
  }

  if (pulseTarget === 'confirmation' && confirmationId) {
    const confirmationCard = doc?.getElementById?.(confirmationId);
    confirmationCard?.classList?.add?.(CONFIGURATION_CONFIRMATION_PULSE_CLASS);
    return pulseTarget;
  }

  return null;
}

function getDefaultConfigurationTitle(server = {}) {
  const displayName = String(server.display_name || server.name || 'Integration').trim();
  if (!displayName) {
    return 'Configuration';
  }

  return /configuration$/i.test(displayName)
    ? displayName
    : `${displayName} Configuration`;
}

function syncConfigurationCardTitle(server, doc = globalThis.document) {
  const { configContent, titleElement } = getConfigurationElements(doc);
  const fallbackTitle = getDefaultConfigurationTitle(server);

  if (!titleElement) {
    return fallbackTitle;
  }

  if (!configContent?.querySelector) {
    titleElement.textContent = fallbackTitle;
    return fallbackTitle;
  }

  const contentTitle = configContent.querySelector('h1');
  if (!contentTitle) {
    titleElement.textContent = fallbackTitle;
    return fallbackTitle;
  }

  const titleHtml = typeof contentTitle.innerHTML === 'string' ? contentTitle.innerHTML.trim() : '';
  const titleText = typeof contentTitle.textContent === 'string' ? contentTitle.textContent.trim() : '';

  if (titleHtml) {
    titleElement.innerHTML = titleHtml;
  } else {
    titleElement.textContent = titleText || fallbackTitle;
  }

  contentTitle.remove?.();
  return titleText || fallbackTitle;
}

function escapeConfigurationHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPreConfiguredServer(server, doc = globalThis.document) {
  const { configContent, titleElement } = getConfigurationElements(doc);
  const displayName = String(server?.display_name || server?.name || 'Integration').trim() || 'Integration';

  if (titleElement) {
    titleElement.textContent = getDefaultConfigurationTitle(server);
  }

  if (configContent) {
    configContent.innerHTML = `
      <div class="setup-step">
        <h3>Already configured</h3>
        <p>${escapeConfigurationHtml(displayName)} already has a securely stored token.</p>
      </div>
    `;
  }

  syncConfigurationSaveButtonVisibility({ ready: false }, doc);
}

function bindConfigurationInputListeners(callbacks = {}, doc = globalThis.document) {
  const { configContent } = getConfigurationElements(doc);
  if (!configContent || configContent.dataset.configurationGuidanceBound === 'true') {
    return;
  }

  const handleInput = (event) => {
    if (event?.target?.classList?.contains?.('input-field')) {
      event.target.classList?.remove?.(CONFIGURATION_INPUT_PULSE_CLASS);
      refreshConfigurationGuidance(callbacks, doc);
    }
  };

  configContent.dataset.configurationGuidanceBound = 'true';
  if (typeof configContent.addEventListener === 'function') {
    configContent.addEventListener('input', handleInput);
    configContent.addEventListener('change', handleInput);
  }
}

function initializeConfigurationGuidance(server, callbacks = {}, doc = globalThis.document) {
  bindConfigurationInputListeners(callbacks, doc);
  syncConfigurationCardTitle(server, doc);

  const { configContent } = getConfigurationElements(doc);
  const firstAccordion = configContent?.querySelector?.('.accordion-section') || null;
  const readiness = getConfigurationReadiness(callbacks, doc);
  syncConfigurationSaveButtonVisibility(readiness, doc);
  const confirmationCard = getVisibleConfirmationCard(doc);
  const pulseTarget = configurationGuidanceController.startArrival({
    serverId: server?.id || null,
    firstAccordionId: firstAccordion?.id || null,
    ready: readiness.ready,
    confirmationId: confirmationCard?.id || null,
  });

  applyConfigurationPulseState(
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

function refreshConfigurationGuidance(callbacks = {}, doc = globalThis.document) {
  const readiness = getConfigurationReadiness(callbacks, doc);
  syncConfigurationSaveButtonVisibility(readiness, doc);
  const confirmationCard = getVisibleConfirmationCard(doc);
  const pulseTarget = configurationGuidanceController.getPulseTarget({
    ready: readiness.ready,
    confirmationId: confirmationCard?.id || null,
  });
  const { firstAccordionId } = configurationGuidanceController.getState();

  applyConfigurationPulseState(
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

function handleConfigurationAccordionToggle(details = {}, callbacks = {}, doc = globalThis.document) {
  const accordion = details.accordionId
    ? doc?.getElementById?.(details.accordionId) || null
    : null;
  const readiness = getConfigurationReadiness(callbacks, doc);
  syncConfigurationSaveButtonVisibility(readiness, doc);
  const confirmationCard = getVisibleConfirmationCard(doc);
  const pulseTarget = configurationGuidanceController.handleAccordionToggle({
    accordionId: details.accordionId,
    isCollapsed: details.isCollapsed,
    ready: readiness.ready,
    confirmationId: confirmationCard?.id || null,
  });
  const { firstAccordionId } = configurationGuidanceController.getState();

  applyConfigurationPulseState(
    pulseTarget,
    {
      accordionId: firstAccordionId,
      confirmationId: confirmationCard?.id || null,
    },
    doc,
  );

  let focusedInput = null;
  if (details.isCollapsed) {
    clearConfigurationInputPulseState(doc);
  } else {
    focusedInput = focusConfigurationAccordionInput(accordion, doc);
  }

  return {
    readiness,
    pulseTarget,
    confirmationId: confirmationCard?.id || null,
    focusedInputId: focusedInput?.id || null,
  };
}

// Load server configuration
async function loadServerConfiguration(index, setupState, callbacks = {}) {
  const server = setupState.serverConfigs[index];
  if (!server) {
    clearConfigurationInputPulseState();
    clearConfigurationPulseState();
    configurationGuidanceController.reset();
    if (callbacks.showStage) {
      await callbacks.showStage('finalize');
    }
    if (callbacks.finalizeSetup) {
      callbacks.finalizeSetup();
    }
    return;
  }

  configurationGuidanceController.reset(server.id);
  clearConfigurationInputPulseState();
  clearConfigurationPulseState();
  syncConfigurationSaveButtonVisibility({ ready: false });
  callbacks.setConfigurationLoadingState?.(true);

  try {
    setupState.currentServerIndex = index;
    if (callbacks.showStage) {
      await callbacks.showStage('configuration', { initialLoading: true });
    }
    syncConfigurationSkipAllButtonVisibility(setupState);

    // Check if this server is already configured and mark it
    const alreadyConfigured = callbacks.isServerConfigured && callbacks.isServerConfigured(server);
    if (alreadyConfigured) {
      setupState.configuredServers.add(server.id);
    }

    // Create/update server navigation
    if (callbacks.createServerNavigation) {
      callbacks.createServerNavigation();
    }

    if (alreadyConfigured && setupState.preConfiguredServers?.has?.(server.id)) {
      renderPreConfiguredServer(server);
      if (callbacks.addLog) {
        callbacks.addLog(`${server.name} is already configured`, 'success');
      }
      return;
    }

    // Parse markdown setup file if exists
    if (server.setupMarkdown) {
      await parseSetupMarkdown(server, setupState, callbacks);
    } else {
      // Generate generic configuration form
      generateConfigForm(server, setupState, callbacks);
    }

    if (callbacks.addLog) {
      callbacks.addLog(`Configuring ${server.name}...`, 'info');
    }
  } finally {
    callbacks.setConfigurationLoadingState?.(false);
  }
}

// Parse setup markdown
async function parseSetupMarkdown(server, setupState, callbacks = {}) {
  try {
    const content = server.setupMarkdown;
    const configContent = document.getElementById('config-content');

    // Clear any existing content first
    configContent.innerHTML = '';

    console.log('[parseSetupMarkdown] Starting with content:', content.substring(0, 500));

    // Parse markdown content using the markdown parser
    let html = content;

    if (callbacks.parseMarkdownContent) {
      html = callbacks.parseMarkdownContent(content, setupState.envVars, 'server-config');
    }

    console.log('[parseSetupMarkdown] Final HTML before setting innerHTML');
    configContent.innerHTML = `<div class="setup-step">${html}</div>`;
    console.log('[parseSetupMarkdown] Content set successfully');

    // Create accordions for visible content only
    if (callbacks.createAccordionsForVisibleContent) {
      callbacks.createAccordionsForVisibleContent(configContent, 'server-config', {
        startCollapsed: true,
        onToggle: (details) => handleConfigurationAccordionToggle(details, callbacks),
        scrollContainer: document.querySelector?.('.content-scroll-area') || null,
      });
    }

    // Add event listeners to inputs and populate existing values
    configContent.querySelectorAll('.input-field').forEach((input) => {
      const varNames = input.dataset.var.split(',').map((v) => v.trim());
      const primaryVarName = varNames[0];

      // Populate existing value if available
      if (setupState.envVars[primaryVarName]) {
        input.value = setupState.envVars[primaryVarName];
      }
    });

    initializeConfigurationGuidance(server, callbacks);
  } catch (err) {
    console.error('Failed to parse setup markdown:', err);
    if (callbacks.addLog) {
      callbacks.addLog(`Error loading configuration for ${server.name}`, 'error');
    }
  }
}

// Generate generic configuration form
function generateConfigForm(server, setupState, callbacks = {}) {
  const configContent = document.getElementById('config-content');
  const requiredEnvVars = getRequiredEnvVars(server);
  let html = '<div class="setup-step">';

  if (requiredEnvVars.length > 0) {
    html += '<h3>Required Configuration</h3>';

    requiredEnvVars.forEach((envVar) => {
      html += `
        <div class="input-group">
          <label class="input-label" for="input-${envVar.name}">${envVar.description || envVar.name}</label>
          <input type="text"
                 class="input-field"
                 id="input-${envVar.name}"
                 data-var="${envVar.name}"
                 placeholder="${envVar.placeholder || 'Enter value'}">
          ${envVar.description ? `<div class="input-hint">${envVar.description}</div>` : ''}
          <div class="input-error" id="error-${envVar.name}">This field is required</div>
        </div>
      `;
    });
  }

  html += '</div>';
  configContent.innerHTML = html;

  // Add event listeners for input fields and populate existing values
  configContent.querySelectorAll('.input-field').forEach((input) => {
    const varName = input.dataset.var;

    // Populate existing value if available
    if (setupState.envVars[varName]) {
      input.value = setupState.envVars[varName];
    }
  });

  initializeConfigurationGuidance(server, callbacks);
}

async function finalizeConfiguration(callbacks = {}) {
  clearConfigurationPulseState();
  configurationGuidanceController.reset();

  if (callbacks.showStage) {
    await callbacks.showStage('finalize');
  }
  if (callbacks.finalizeSetup) {
    callbacks.finalizeSetup();
  }
}

function getNextPendingConfigurationIndex(setupState = {}, startIndex = 0) {
  const serverConfigs = Array.isArray(setupState?.serverConfigs)
    ? setupState.serverConfigs
    : [];
  const configuredServers = setupState?.configuredServers;
  const skippedServers = setupState?.skippedServers;
  const normalizedStartIndex = Number.isInteger(startIndex)
    ? Math.max(0, startIndex)
    : 0;

  for (let index = normalizedStartIndex; index < serverConfigs.length; index += 1) {
    const server = serverConfigs[index];
    if (!server) {
      continue;
    }

    const serverId = server.id;
    const isConfigured = serverId
      ? configuredServers?.has?.(serverId) === true
      : false;
    const isSkipped = serverId
      ? skippedServers?.has?.(serverId) === true
      : false;

    if (!isConfigured && !isSkipped) {
      return index;
    }
  }

  return -1;
}

async function loadNextServerOrFinalize(nextIndex, setupState, callbacks = {}) {
  const pendingIndex = getNextPendingConfigurationIndex(setupState, nextIndex);
  if (pendingIndex !== -1) {
    setupState.currentServerIndex = pendingIndex;
    await loadServerConfiguration(pendingIndex, setupState, callbacks);
    return;
  }

  await finalizeConfiguration(callbacks);
}

async function resumePendingOAuthAfterConfiguration(
  setupState,
  currentServer,
  callbacks = {},
  options = {},
) {
  const serverId = currentServer?.id;
  if (!serverId || setupState?.pendingOAuthConfigurationServerId !== serverId) {
    return false;
  }

  if (options.skipped === true) {
    setupState.oauthServers = (setupState.oauthServers || [])
      .filter((server) => server?.id !== serverId);
    setupState.skippedOAuthServers?.add?.(serverId);
  }

  callbacks.addLog?.(
    options.skipped === true
      ? `Skipped authorization for ${currentServer.display_name || currentServer.name || serverId}`
      : `Configuration saved. Resuming authorization for ${currentServer.display_name || currentServer.name || serverId}`,
    options.skipped === true ? 'warning' : 'info',
  );

  if (typeof callbacks.showStage === 'function') {
    await callbacks.showStage('oauth', { autoStartPendingOAuth: options.skipped !== true });
  }
  setupState.pendingOAuthConfigurationServerId = null;
  return true;
}

// Save and continue with validation
async function saveAndContinue(setupState, skipValidation = false, callbacks = {}) {
  try {
    // Collect all inputs and their values BEFORE any modifications
    const activeInputs = getActiveConfigurationInputs(document);
    console.log(`[saveAndContinue] Found ${activeInputs.length} active inputs`);
    const inputsToProcess = [];

    // Validate and collect all inputs first
    if (!skipValidation) {
      const invalidInputs = [];

      for (const input of activeInputs) {
        const rawValue = input.value;
        const fieldName = input.dataset.var ? input.dataset.var.split(',')[0] : 'field';

        const validation = callbacks.validateEnvValue
          ? callbacks.validateEnvValue(rawValue, fieldName)
          : { valid: !!rawValue.trim(), value: rawValue.trim(), error: `${fieldName} cannot be empty` };

        if (!validation.valid) {
          invalidInputs.push(input);
          input.classList.add('error');
          const errorEl = input.parentElement.querySelector('.input-error');
          if (errorEl) {
            errorEl.textContent = validation.error;
            errorEl.classList.add('visible');
          }
        } else {
          input.classList.remove('error');
          const errorEl = input.parentElement.querySelector('.input-error');
          if (errorEl) {
            errorEl.classList.remove('visible');
          }
          inputsToProcess.push({
            element: input,
            varNameRaw: input.dataset.var,
            value: validation.value,
          });
        }
      }

      if (invalidInputs.length > 0) {
        if (callbacks.addLog) {
          callbacks.addLog('Please fix validation errors before continuing', 'error');
        }
        invalidInputs[0].focus();
        return;
      }
    } else {
      // If skipping validation, collect all inputs with values
      for (const input of activeInputs) {
        const rawValue = input.value;
        const trimmedValue = rawValue.trim();
        if (trimmedValue) {
          inputsToProcess.push({
            element: input,
            varNameRaw: input.dataset.var,
            value: trimmedValue,
          });
        }
      }
    }

    // Process all collected inputs sequentially
    for (const inputData of inputsToProcess) {
      const varNames = inputData.varNameRaw.split(',').map((v) => v.trim());

      for (const varName of varNames) {
        if (callbacks.saveEnvVarImmediately) {
          try {
            await callbacks.saveEnvVarImmediately(varName, inputData.value);
            console.log(`[saveAndContinue] Successfully saved ${varName}`);
          } catch (err) {
            console.error(`[saveAndContinue] Failed to save ${varName}:`, err);
            if (skipValidation) {
              setupState.envVars[varName] = inputData.value;
              continue;
            }
            inputData.element.classList.add('error');
            const errorEl = inputData.element.parentElement?.querySelector?.('.input-error');
            if (errorEl) {
              errorEl.textContent = err?.message || `Failed to save ${varName}`;
              errorEl.classList.add('visible');
            }
            throw err;
          }
        }
        setupState.envVars[varName] = inputData.value;
      }
    }

    if (callbacks.addLog) {
      callbacks.addLog('All values saved for current screen', 'success');
    }

    // Mark all inputs as saved
    for (const inputData of inputsToProcess) {
      inputData.element.classList.add('saved');
      inputData.element.disabled = true;
    }

    // Mark current server as completed
    const currentServer = setupState.serverConfigs[setupState.currentServerIndex];
    if (currentServer && !skipValidation) {
      setupState.completedSteps.servers[currentServer.id] = true;
      setupState.configuredServers.add(currentServer.id);
      setupState.skippedServers.delete(currentServer.id);
    }

    const nextIndex = setupState.currentServerIndex + 1;
    if (await resumePendingOAuthAfterConfiguration(
      setupState,
      currentServer,
      callbacks,
    )) {
      return;
    }
    await loadNextServerOrFinalize(nextIndex, setupState, callbacks);
  } catch (err) {
    console.error('[saveAndContinue] Error:', err);
    if (callbacks.addLog) {
      const message = err?.message
        ? `Error saving values: ${err.message}`
        : 'Error saving values';
      callbacks.addLog(skipValidation ? 'Error saving values, but continuing...' : message, skipValidation ? 'warning' : 'error');
    }

    if (!skipValidation) {
      return;
    }

    // Continue anyway
    const nextIndex = setupState.currentServerIndex + 1;
    await loadNextServerOrFinalize(nextIndex, setupState, callbacks);
  }
}

// Skip current server
async function skipServer(setupState, callbacks = {}) {
  const currentServer = setupState.serverConfigs[setupState.currentServerIndex];
  if (currentServer) {
    setupState.skippedServers.add(currentServer.id);
    setupState.configuredServers.delete(currentServer.id);
    setupState.preConfiguredServers?.delete?.(currentServer.id);
    if (callbacks.addLog) {
      callbacks.addLog(`Skipped ${currentServer.name} configuration`, 'warning');
    }
  }

  if (await resumePendingOAuthAfterConfiguration(
    setupState,
    currentServer,
    callbacks,
    { skipped: true },
  )) {
    return;
  }

  const nextIndex = setupState.currentServerIndex + 1;
  await loadNextServerOrFinalize(nextIndex, setupState, callbacks);
}

// Skip the current and all remaining configuration servers
async function skipAllServers(setupState, callbacks = {}) {
  const currentServer = setupState.serverConfigs[setupState.currentServerIndex];
  const remainingServers = setupState.serverConfigs.slice(setupState.currentServerIndex);

  remainingServers.forEach((server) => {
    if (!server) return;
    setupState.skippedServers.add(server.id);
    setupState.configuredServers.delete(server.id);
    setupState.preConfiguredServers?.delete?.(server.id);
  });

  if (remainingServers.length > 0 && callbacks.addLog) {
    const message = remainingServers.length === 1
      ? `Skipped ${remainingServers[0].name} configuration`
      : `Skipped configuration for the remaining ${remainingServers.length} servers`;
    callbacks.addLog(message, 'warning');
  }

  if (await resumePendingOAuthAfterConfiguration(
    setupState,
    currentServer,
    callbacks,
    { skipped: true },
  )) {
    return;
  }

  await finalizeConfiguration(callbacks);
}

// Previous server
async function previousServer(setupState, callbacks = {}) {
  clearConfigurationPulseState();
  configurationGuidanceController.reset();

  if (setupState.currentServerIndex > 0) {
    setupState.currentServerIndex--;
    await loadServerConfiguration(setupState.currentServerIndex, setupState, callbacks);
  } else {
    if (callbacks.showStage) {
      callbacks.showStage('server-selection');
    }
    if (callbacks.addLog) {
      callbacks.addLog('Select MCP servers to configure...', 'info');
    }
  }
}

// Jump to a specific server configuration
function jumpToServer(index, setupState, callbacks = {}) {
  if (index < 0 || index >= setupState.serverConfigs.length) return;

  clearConfigurationPulseState();
  configurationGuidanceController.reset();

  setupState.currentServerIndex = index;
  loadServerConfiguration(index, setupState, callbacks);
}

// Wrapper function to handle async saveAndContinue from onclick
async function handleSaveAndContinue(setupState, callbacks = {}) {
  try {
    clearConfigurationPulseState();

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Validating...';
    }

    await saveAndContinue(setupState, false, callbacks);

    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = CONFIGURATION_SAVE_LABEL;
    }
  } catch (err) {
    console.error('[handleSaveAndContinue] Error:', err);
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = CONFIGURATION_SAVE_LABEL;
    }
    if (callbacks.addLog) {
      callbacks.addLog('Error occurred while saving', 'error');
    }
  }
}

// Wrapper function to handle skipping server
async function handleSkipServer(setupState, callbacks = {}) {
  try {
    clearConfigurationPulseState();

    const skipBtn = document.getElementById('skip-server-btn');
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.textContent = 'Skipping...';
    }

    await skipServer(setupState, callbacks);

    if (skipBtn) {
      skipBtn.disabled = false;
      skipBtn.textContent = CONFIGURATION_SKIP_LABEL;
    }
  } catch (err) {
    console.error('[handleSkipServer] Error:', err);
    const skipBtn = document.getElementById('skip-server-btn');
    if (skipBtn) {
      skipBtn.disabled = false;
      skipBtn.textContent = CONFIGURATION_SKIP_LABEL;
    }
    if (callbacks.addLog) {
      callbacks.addLog('Error occurred while skipping', 'error');
    }
  }
}

// Wrapper function to handle skipping all remaining servers
async function handleSkipAllServers(setupState, callbacks = {}) {
  try {
    clearConfigurationPulseState();

    const skipAllBtn = document.getElementById('skip-all-servers-btn');
    const skipBtn = document.getElementById('skip-server-btn');
    if (skipAllBtn) {
      skipAllBtn.disabled = true;
      skipAllBtn.textContent = 'Skipping Remaining...';
    }
    if (skipBtn) {
      skipBtn.disabled = true;
    }

    await skipAllServers(setupState, callbacks);
  } catch (err) {
    console.error('[handleSkipAllServers] Error:', err);
    const skipAllBtn = document.getElementById('skip-all-servers-btn');
    const skipBtn = document.getElementById('skip-server-btn');
    if (skipAllBtn) {
      skipAllBtn.disabled = false;
      skipAllBtn.textContent = CONFIGURATION_SKIP_ALL_LABEL;
    }
    if (skipBtn) {
      skipBtn.disabled = false;
      skipBtn.textContent = CONFIGURATION_SKIP_LABEL;
    }
    if (callbacks.addLog) {
      callbacks.addLog('Error occurred while skipping all remaining servers', 'error');
    }
  }
}

// Export functions
module.exports = {
  createConfigurationGuidanceController,
  evaluateConfigurationReadiness,
  resolveConfigurationPulseTarget,
  hasAdditionalPendingConfigurationServers,
  syncConfigurationSaveButtonVisibility,
  syncConfigurationSkipAllButtonVisibility,
  initializeConfigurationGuidance,
  handleConfigurationAccordionToggle,
  refreshConfigurationGuidance,
  focusConfigurationAccordionInput,
  getNextPendingConfigurationIndex,
  resumePendingOAuthAfterConfiguration,
  loadServerConfiguration,
  parseSetupMarkdown,
  generateConfigForm,
  saveAndContinue,
  skipServer,
  skipAllServers,
  previousServer,
  jumpToServer,
  handleSaveAndContinue,
  handleSkipServer,
  handleSkipAllServers,
};

// NOTE: Window exports are handled by the main guided-setup.js orchestrator
// to ensure proper callback and state injection
