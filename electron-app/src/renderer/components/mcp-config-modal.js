// MCP Server Configuration Modal
// Allows configuring MCP servers directly from the Control Plane

const MCP_CONFIG_DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const MCP_CONFIG_SLACK_READINESS_TIMEOUT_MS = 12 * 60_000;

function mcpConfigReadinessTimeoutMs(serverId) {
  return String(serverId || '').trim().toLowerCase() === 'slack'
    ? MCP_CONFIG_SLACK_READINESS_TIMEOUT_MS
    : MCP_CONFIG_DEFAULT_READINESS_TIMEOUT_MS;
}

function createInitialMcpConfigState(overrides = {}) {
  return {
    serverId: null,
    flowId: null,
    serverName: null,
    serverIcon: null,
    setupMarkdown: null,
    hasActionableNewChatControl: false,
    requiredEnvVars: [],
    presetVars: [],
    envVars: {},
    secureSecretPresence: {},
    modified: false,
    testingStatus: null, // null, 'running', 'success', 'failed'
    testingError: null,
    discoveredTools: [],
    reason: null,
    launchSource: 'manual',
    resolveFlow: null,
    flowOutcomeNotified: false,
    pendingFlowOutcome: null,
    testingFailure: null,
    activeTestRunId: 0,
    activeSingleServerSessionId: null,
    ...overrides,
  };
}

function getMcpConfigLaunchSource(options = {}) {
  return options.launchSource === 'backend-requested'
    ? 'backend-requested'
    : 'manual';
}

function allowsImplicitMcpConfigDismiss() {
  return mcpConfigState.launchSource !== 'backend-requested';
}

function getMcpConfigGuidanceApi() {
  if (typeof window !== 'undefined' && window.McpConfigGuidance) {
    return window.McpConfigGuidance;
  }

  if (typeof require === 'function') {
    return require('./mcp-config-guidance');
  }

  throw new Error('McpConfigGuidance is not available');
}

function getMcpConfigRequirementsApi() {
  if (typeof window !== 'undefined' && window.McpServerRequirements) {
    return window.McpServerRequirements;
  }

  if (typeof require === 'function') {
    return require('../../services/guided-setup/server-requirements');
  }

  return null;
}

function mcpConfigServerRequiresOAuth(server) {
  const requirementsApi = getMcpConfigRequirementsApi();
  if (requirementsApi?.serverSupportsOAuth) {
    return requirementsApi.serverSupportsOAuth(server);
  }
  return Boolean(
    server?.oauth &&
      (server.oauth.requires_user_authorization === true || server.oauth.type),
  );
}

// Module state
var mcpConfigState = createInitialMcpConfigState();
var mcpConfigEscHandler = null;
var mcpConfigTestRunSequence = 0;

// Get the markdown parser (browser-compatible version)
function getMarkdownParser() {
  return window.McpConfigMarkdownParser || null;
}

function setMcpConfigChatHandoffPresentation(enabled) {
  const isChatHandoff = enabled === true;
  mcpConfigState.hasActionableNewChatControl = isChatHandoff;

  const modal = document.getElementById('mcp-config-modal');
  const modalContent = modal?.querySelector('.mcp-config-modal');
  modalContent?.classList.toggle('chat-handoff', isChatHandoff);

  const saveBtn = document.getElementById('mcp-config-save-btn');
  if (saveBtn) {
    saveBtn.hidden = isChatHandoff;
  }
}

function getMcpConfigScrollContainer(doc = globalThis.document) {
  return doc?.querySelector?.('.mcp-config-body') || null;
}

function confirmMcpConfigDiscardChanges() {
  return (
    !mcpConfigState.modified ||
    confirm('You have unsaved changes. Are you sure you want to close?')
  );
}

function notifyMcpConfigFlowOutcome(outcome, details = {}) {
  if (mcpConfigState.flowOutcomeNotified || !mcpConfigState.serverId) {
    return false;
  }
  mcpConfigState.flowOutcomeNotified = true;
  if (window.electronAPI?.notifyGuidedSetupCompleted) {
    window.electronAPI.notifyGuidedSetupCompleted(
      mcpConfigState.serverId,
      outcome,
      mcpConfigState.flowId,
      details,
    );
  }
  return true;
}

function markMcpConfigTestFailed(details = {}) {
  const safeDetails = {
    errorCode: details.errorCode || 'CONFIGURATION_TEST_FAILED',
    configurationIssue: details.configurationIssue || null,
    requiredAction: details.requiredAction || null,
    severity: details.severity || 'error',
    message:
      details.message ||
      `${mcpConfigState.serverName || mcpConfigState.serverId} configuration test failed.`,
    recoveryPrompt: details.recoveryPrompt || null,
    recoveryLabel: details.recoveryLabel || null,
  };
  mcpConfigState.testingFailure = safeDetails;
  mcpConfigState.pendingFlowOutcome = 'test_failed';
  if (mcpConfigState.launchSource === 'backend-requested') {
    notifyMcpConfigFlowOutcome('test_failed', safeDetails);
  }
  return safeDetails;
}

async function openMcpConfigNewChat(prompt) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt || !confirmMcpConfigDiscardChanges()) {
    return false;
  }

  try {
    if (typeof window.openNewChatTab === 'function') {
      const opened = window.openNewChatTab({ prompt: normalizedPrompt });
      if (opened === false) {
        // The shared tab bar reports its existing tab-cap warning.
        return false;
      }
    } else if (typeof window.electronAPI?.requestOpenNewChatTab === 'function') {
      const result = await window.electronAPI.requestOpenNewChatTab({
        prompt: normalizedPrompt,
      });
      if (!result?.success) {
        showConfigNotification(
          result?.error || 'Could not open a new chat tab.',
          'error',
        );
        return false;
      }
    } else {
      showConfigNotification('Chat tab system not available.', 'error');
      return false;
    }
  } catch (error) {
    showConfigNotification(
      error?.message || 'Could not open a new chat tab.',
      'error',
    );
    return false;
  }

  closeMcpConfigModal({
    skipUnsavedConfirm: true,
    outcome: 'redirected_to_chat',
  });
  return true;
}

function validateMcpConfigGuidanceValue(rawValue, _fieldName, input) {
  const trimmedValue = typeof rawValue === 'string' ? rawValue.trim() : '';
  const isRequired = !input?.dataset?.optional;
  const hasStoredSensitiveValue =
    input?.dataset?.secretStored === 'true' &&
    mcpConfigState.reason !== 'credentials_invalid';
  const validatePattern = input?.dataset?.validate;

  if (isRequired && !trimmedValue && !hasStoredSensitiveValue) {
    return { valid: false, value: trimmedValue };
  }

  if (trimmedValue && validatePattern) {
    try {
      const regex = new RegExp(validatePattern);
      if (!regex.test(trimmedValue)) {
        return { valid: false, value: trimmedValue };
      }
    } catch (error) {
      console.warn('Invalid validation pattern:', validatePattern, error);
    }
  }

  return { valid: true, value: trimmedValue };
}

function isSensitiveRequiredEnvVar(key) {
  return (mcpConfigState.requiredEnvVars || []).some(
    (envVar) => envVar?.name === key && envVar.sensitive === true,
  );
}

function stripSensitiveEnvKeys(content, keys) {
  let nextContent = String(content || '');
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    nextContent = nextContent.replace(new RegExp(`^${escapedKey}=.*$`, 'gm'), '');
    nextContent = nextContent.replace(new RegExp(`^${escapedKey}_FILE=.*$`, 'gm'), '');
  }
  return nextContent.replace(/\n\n\n+/g, '\n\n');
}

function getMcpConfigGuidanceCallbacks() {
  return {
    validateEnvValue: validateMcpConfigGuidanceValue,
  };
}

// Open the configuration modal for a server
// options.reason: 'credentials_invalid' clears password fields and shows warning banner
// options.launchSource: 'backend-requested' disables implicit dismissal (Escape/backdrop)
async function openMcpConfigModal(serverId, event, options = {}) {
  if (event) {
    event.stopPropagation();
  }

  const modal = document.getElementById('mcp-config-modal');
  if (!modal) {
    console.error('MCP config modal not found in DOM');
    if (window.electronAPI && window.electronAPI.notifyGuidedSetupCompleted) {
      window.electronAPI.notifyGuidedSetupCompleted(
        serverId,
        'test_failed',
        options.flowId || null,
        { message: 'The configuration form could not be opened.' },
      );
    }
    return;
  }

  // Reset state
  mcpConfigState = createInitialMcpConfigState({
    flowId: options.flowId || null,
    serverId,
    reason: options.reason || null,
    launchSource: getMcpConfigLaunchSource(options),
  });
  setMcpConfigChatHandoffPresentation(false);

  // Find server in appState
  const server = window.appState?.servers?.find(s => s.id === serverId);
  if (!server) {
    console.error('Server not found in appState:', serverId, 'available:', window.appState?.servers?.map(s => s.id));
    if (window.electronAPI && window.electronAPI.notifyGuidedSetupCompleted) {
      window.electronAPI.notifyGuidedSetupCompleted(
        serverId,
        'test_failed',
        mcpConfigState.flowId,
        { message: 'The requested integration is not available.' },
      );
    }
    return;
  }

  mcpConfigState.serverName = server.display_name || server.name || serverId;
  mcpConfigState.serverIcon = server.icon;
  mcpConfigState.setupMarkdown = server.setupMarkdown;
  mcpConfigState.requiredEnvVars = server.requiredVars || [];
  mcpConfigState.presetVars = server.presetVars || [];
  getMcpConfigGuidanceApi().resetMcpConfigGuidance(serverId);

  // Load existing env vars
  try {
    const envResult = await window.electronAPI.readEnvFile();
    if (envResult.success && envResult.content) {
      mcpConfigState.envVars = parseEnvContent(envResult.content);
      for (const envVar of mcpConfigState.requiredEnvVars || []) {
        if (envVar?.sensitive === true && envVar.name) {
          delete mcpConfigState.envVars[envVar.name];
        }
      }
    }
  } catch (err) {
    console.error('Failed to load env vars:', err);
  }

  try {
    const presenceResult =
      await window.electronAPI.getMcpSensitiveSecretPresence?.(serverId);
    if (presenceResult?.success) {
      mcpConfigState.secureSecretPresence = presenceResult.presence || {};
    }
  } catch (err) {
    console.error('Failed to load secure MCP secret presence:', err);
  }

  // Update modal header
  updateModalHeader();

  // Render configuration content
  renderConfigContent();

  // Reset testing pane
  resetTestingPane();

  // Show modal
  window.suppressMcpBadgeTooltip?.();
  window.setNativeOverlayInteractionSuppressed?.('mcp-config-modal', true);
  modal.classList.add('visible');

  // Attach event listeners
  attachModalEventListeners();
  getMcpConfigGuidanceApi().initializeMcpConfigGuidance(
    { id: mcpConfigState.serverId },
    getMcpConfigGuidanceCallbacks(),
  );

  if (options.waitForClose === true) {
    return new Promise((resolve) => {
      mcpConfigState.resolveFlow = resolve;
    });
  }

  return {
    success: true,
    opened: true,
    server_id: serverId,
    flow_id: mcpConfigState.flowId,
  };
}

// Parse .env file content into object
function parseEnvContent(content) {
  const envVars = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex);
        const value = trimmed.substring(eqIndex + 1);
        envVars[key] = value;
      }
    }
  }
  return envVars;
}

// Update modal header with server info
function updateModalHeader() {
  const iconEl = document.querySelector('.mcp-config-server-icon');
  const titleEl = document.querySelector('.mcp-config-title');
  const subtitleEl = document.querySelector('.mcp-config-subtitle');

  if (iconEl) {
    if (mcpConfigState.serverIcon) {
      iconEl.innerHTML = `<img src="${mcpConfigState.serverIcon}" alt="${mcpConfigState.serverName}">`;
    } else {
      iconEl.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
      `;
    }
  }

  if (titleEl) {
    titleEl.textContent = `Configure ${mcpConfigState.serverName}`;
  }

  if (subtitleEl) {
    subtitleEl.textContent = mcpConfigState.requiredEnvVars.length > 0
      ? `${mcpConfigState.requiredEnvVars.length} configuration value${mcpConfigState.requiredEnvVars.length > 1 ? 's' : ''} required`
      : 'Set up required configuration';
  }
}

// Render configuration form content
function renderConfigContent() {
  const contentEl = document.getElementById('mcp-config-content');
  if (!contentEl) return;
  const guidanceCallbacks = getMcpConfigGuidanceCallbacks();

  if (mcpConfigState.setupMarkdown) {
    // Use markdown parser if available
    const parser = getMarkdownParser();
    if (parser && parser.parseMarkdownContent) {
      const html = parser.parseMarkdownContent(
        mcpConfigState.setupMarkdown,
        mcpConfigState.envVars
      );
      // Inject warning banner for reconfiguration before the form content
      const warningBanner = mcpConfigState.reason === 'credentials_invalid' ? `
        <div class="mcp-config-warning-banner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>Your credentials appear to be invalid or expired. Please enter a new token below — the old one will be replaced.</span>
        </div>
      ` : '';
      contentEl.innerHTML = `<div class="setup-step">${warningBanner}${html}</div>`;
      setMcpConfigChatHandoffPresentation(
        parser.hasActionableNewChatControl?.(
          mcpConfigState.setupMarkdown,
          mcpConfigState.envVars,
        ) === true,
      );

      // Initialize confirmation content visibility (hide content after confirmations)
      contentEl.querySelectorAll('.mcp-config-content-after-confirmation').forEach(el => {
        el.classList.add('hidden');
      });

      // Attach event listeners for interactive elements
      if (parser.attachEventListeners) {
        parser.attachEventListeners(contentEl, {
          startCollapsed: true,
          onToggle: (details) => getMcpConfigGuidanceApi().handleMcpConfigAccordionToggle(details, guidanceCallbacks),
          refreshGuidance: () => getMcpConfigGuidanceApi().refreshMcpConfigGuidance(guidanceCallbacks),
          openNewChat: openMcpConfigNewChat,
          scrollContainer: () => getMcpConfigScrollContainer(),
          context: 'mcp-config',
        });
      }
    } else {
      // Fallback: render basic form
      console.warn('[MCP Config Modal] Markdown parser not available, using basic form');
      renderBasicConfigForm(contentEl);
    }
  } else {
    // No markdown, generate basic form
    renderBasicConfigForm(contentEl);
  }

  // Populate existing values into inputs
  populateExistingValues();
  applyStoredSensitiveFieldState();

  // Add input change listeners
  contentEl.querySelectorAll('.input-field').forEach(input => {
    const handleFieldUpdate = () => {
      mcpConfigState.modified = true;
      // Clear error state on input
      input.classList.remove('error');
      const errorEl = input.parentElement?.querySelector('.input-error');
      if (errorEl) errorEl.classList.remove('visible');
    };
    input.addEventListener('input', handleFieldUpdate);
    input.addEventListener('change', handleFieldUpdate);
  });

  getMcpConfigGuidanceApi().initializeMcpConfigGuidance(
    { id: mcpConfigState.serverId },
    guidanceCallbacks,
  );
}

// Render basic configuration form
function renderBasicConfigForm(container) {
  if (mcpConfigState.requiredEnvVars.length === 0) {
    container.innerHTML = `
      <div class="mcp-config-no-vars">
        <p>This server does not require any configuration.</p>
        <p>Click "Save & Test" to verify it works correctly.</p>
      </div>
    `;
    return;
  }

  const isReconfigure = mcpConfigState.reason === 'credentials_invalid';

  let html = '<div class="setup-step">';

  if (isReconfigure) {
    html += `
      <div class="mcp-config-warning-banner">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span>Your credentials appear to be invalid or expired. Please enter a new token below — the old one will be replaced.</span>
      </div>
    `;
  }

  html += '<h3>Required Configuration</h3>';

  for (const envVar of mcpConfigState.requiredEnvVars) {
    // When reconfiguring, clear sensitive fields so user must enter new value
    const existingValue = (isReconfigure && envVar.sensitive) ? '' : (mcpConfigState.envVars[envVar.name] || '');
    const inputType = envVar.sensitive ? 'password' : 'text';
    const placeholder = (isReconfigure && envVar.sensitive)
      ? 'Enter new token (old one will be replaced)'
      : (envVar.placeholder || 'Enter value');

    html += `
      <div class="input-group">
        <label class="input-label" for="input-${envVar.name}">${envVar.description || envVar.name}</label>
        <input type="${inputType}"
               class="input-field"
               id="input-${envVar.name}"
               data-var="${envVar.name}"
               value="${escapeHtml(existingValue)}"
               placeholder="${placeholder}">
        <div class="input-error" id="error-${envVar.name}">This field is required</div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;
}

// Populate existing values from loaded env vars
function populateExistingValues() {
  const contentEl = document.getElementById('mcp-config-content');
  if (!contentEl) return;

  const isReconfigure = mcpConfigState.reason === 'credentials_invalid';

  contentEl.querySelectorAll('.input-field').forEach(input => {
    const varNames = (input.dataset.var || '').split(',').map(v => v.trim());
    const primaryVar = varNames[0];
    // When reconfiguring, skip populating sensitive (password) fields — force user to enter new value
    if (isReconfigure && input.type === 'password') {
      input.value = '';
      input.placeholder = 'Enter new token (old one will be replaced)';
      return;
    }
    if (primaryVar && mcpConfigState.envVars[primaryVar]) {
      input.value = mcpConfigState.envVars[primaryVar];
    }
  });
}

function applyStoredSensitiveFieldState() {
  const contentEl = document.getElementById('mcp-config-content');
  if (!contentEl) return;

  contentEl.querySelectorAll('.input-field').forEach(input => {
    const primaryVar = (input.dataset.var || '').split(',')[0]?.trim();
    const hasStoredSecret =
      primaryVar &&
      isSensitiveRequiredEnvVar(primaryVar) &&
      mcpConfigState.secureSecretPresence[primaryVar] === true &&
      mcpConfigState.reason !== 'credentials_invalid';
    if (!hasStoredSecret) {
      delete input.dataset.secretStored;
      return;
    }
    input.dataset.secretStored = 'true';
    input.value = '';
    input.placeholder = 'Stored securely; leave blank to keep';
  });
}

// Escape HTML special characters
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

// Validate and save configuration
async function validateAndSave() {
  const contentEl = document.getElementById('mcp-config-content');
  if (!contentEl) return false;

  const inputs = contentEl.querySelectorAll('.input-field');
  let allValid = true;
  const valuesToSave = {};

  // Validate each input
  for (const input of inputs) {
    const value = input.value.trim();
    const varNames = (input.dataset.var || '').split(',').map(v => v.trim());
    const primaryVar = varNames[0];
    const validatePattern = input.dataset.validate;
    const errorMessage = input.dataset.error || 'Invalid input';

    // Skip optional fields that are empty
    const isRequired = !input.dataset.optional;
    const hasStoredSensitiveValue =
      input.dataset.secretStored === 'true' &&
      mcpConfigState.reason !== 'credentials_invalid';

    // Check required
    if (isRequired && !value && !hasStoredSensitiveValue) {
      allValid = false;
      input.classList.add('error');
      const errorEl = input.parentElement?.querySelector('.input-error');
      if (errorEl) {
        errorEl.textContent = 'This field is required';
        errorEl.classList.add('visible');
      }
      continue;
    }

    // Check pattern validation if specified
    if (value && validatePattern) {
      try {
        const regex = new RegExp(validatePattern);
        if (!regex.test(value)) {
          allValid = false;
          input.classList.add('error');
          const errorEl = input.parentElement?.querySelector('.input-error');
          if (errorEl) {
            errorEl.textContent = errorMessage;
            errorEl.classList.add('visible');
          }
          continue;
        }
      } catch (err) {
        console.warn('Invalid validation pattern:', validatePattern, err);
      }
    }

    // Valid - clear error state
    input.classList.remove('error');
    const errorEl = input.parentElement?.querySelector('.input-error');
    if (errorEl) errorEl.classList.remove('visible');

    // Collect value for all var names
    if (value) {
      for (const varName of varNames) {
        valuesToSave[varName] = value;
      }
    }
  }

  if (!allValid) {
    return false;
  }

  // Save to .env file
  try {
    // Read current .env
    const envResult = await window.electronAPI.readEnvFile();
    let content = envResult.success ? (envResult.content || '') : '';

    // Ensure content ends with newline before appending
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }

    const sensitiveKeys = Object.keys(valuesToSave).filter(isSensitiveRequiredEnvVar);
    content = stripSensitiveEnvKeys(content, sensitiveKeys);

    // Update values
    for (const [key, value] of Object.entries(valuesToSave)) {
      if (isSensitiveRequiredEnvVar(key)) {
        const result = await window.electronAPI.upsertRuntimeSecret(key, value);
        if (!result?.success) {
          throw new Error(result?.error || `Failed to persist ${key}`);
        }
        mcpConfigState.secureSecretPresence[key] = true;
        delete mcpConfigState.envVars[key];
        continue;
      }
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      mcpConfigState.envVars[key] = value;
    }

    // Also write preset env vars from YAML config (e.g. GITLAB_API_URL, GITLAB_IS_OLD)
    for (const preset of (mcpConfigState.presetVars || [])) {
      if (preset.name && preset.value !== undefined) {
        const presetRegex = new RegExp(`^${preset.name}=.*$`, 'm');
        if (!presetRegex.test(content)) {
          content += `\n${preset.name}=${preset.value}`;
        }
      }
    }

    // Write back
    const writeResult = await window.electronAPI.writeEnvFile(content);
    if (!writeResult.success) {
      throw new Error(writeResult.error || 'Failed to write .env file');
    }

    mcpConfigState.modified = false;
    return true;
  } catch (err) {
    console.error('Failed to save configuration:', err);
    showConfigNotification('Failed to save configuration: ' + err.message, 'error');
    return false;
  }
}

function getPromoteButtonContent(label) {
  return `
      <svg class="mcp-config-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
      </svg>
      ${label}
    `;
}

function resetPromoteButton() {
  const promoteBtn = document.getElementById('mcp-config-promote-btn');
  if (promoteBtn) {
    promoteBtn.disabled = false;
    promoteBtn.innerHTML = 'Enable Server';
    promoteBtn.style.display = 'none';
  }
}

async function ensureMcpConfigOAuthReady() {
  const server = window.appState?.servers?.find(
    (entry) => entry?.id === mcpConfigState.serverId,
  );
  if (!mcpConfigServerRequiresOAuth(server)) {
    return true;
  }

  let hasOAuthTokens = false;
  try {
    const tokenState =
      await window.electronAPI?.checkOAuthTokensExist?.(mcpConfigState.serverId);
    hasOAuthTokens = tokenState?.exists === true;
  } catch (error) {
    console.warn(
      `[MCP Config] Failed to verify OAuth tokens for ${mcpConfigState.serverId}:`,
      error,
    );
  }

  if (server) {
    server.hasOAuthTokens = hasOAuthTokens;
  }
  if (hasOAuthTokens) {
    return true;
  }

  window.markMcpServerOAuthUnauthenticated?.(mcpConfigState.serverId);
  showConfigNotification(
    `${mcpConfigState.serverName || mcpConfigState.serverId} must be authenticated before configuration can be tested.`,
    'warning',
  );
  return false;
}

// Start server test
async function startServerTest(options = {}) {
  if (!options.skipOAuthCheck && !(await ensureMcpConfigOAuthReady())) {
    return false;
  }

  const serverId = mcpConfigState.serverId;
  const testRunId = ++mcpConfigTestRunSequence;
  mcpConfigState.activeTestRunId = testRunId;
  mcpConfigState.activeSingleServerSessionId = null;
  getMcpConfigGuidanceApi().clearMcpConfigPulseState();
  mcpConfigState.testingStatus = 'running';
  mcpConfigState.testingError = null;
  mcpConfigState.testingFailure = null;
  mcpConfigState.pendingFlowOutcome = null;
  mcpConfigState.discoveredTools = [];
  let testSucceeded = false;
  let sessionId = null;

  // Expand testing pane
  const modal = document.getElementById('mcp-config-modal');
  const modalContent = modal?.querySelector('.mcp-config-modal');
  if (modalContent) {
    modalContent.classList.add('testing-expanded');
  }

  // Initialize divider drag functionality after pane expands
  setTimeout(() => initMcpConfigDividerDrag(), 100);

  // Render initial testing UI
  renderTestingProgress();

  try {
    // Step 1: Start single server
    updateTestStep('start', 'running', 'Starting test server...');
    const startResult = await window.electronAPI.startSingleMcpServer(
      serverId,
      { oauthMode: 'existing-record' },
    );
    if (!startResult.success) {
      if (
        startResult.requiresConfiguration === true &&
        startResult.severity === 'warning'
      ) {
        const savedSecretUnavailable =
          startResult.errorCode === 'SAVED_SECRET_UNAVAILABLE' ||
          startResult.configurationIssue === 'saved_secret_unavailable';
        const warning = markMcpConfigTestFailed({
          errorCode: startResult.errorCode || 'NOT_CONFIGURED',
          configurationIssue:
            startResult.configurationIssue || 'configuration_incomplete',
          requiredAction:
            startResult.requiredAction ||
            (savedSecretUnavailable ? 'replace_saved_secret' : 'configure'),
          severity: 'warning',
          message:
            startResult.message ||
            'The saved connection is unavailable. Replace it securely before testing.',
          recoveryPrompt: startResult.recoveryPrompt || null,
          recoveryLabel: startResult.recoveryLabel || null,
        });
        mcpConfigState.testingStatus = 'warning';
        mcpConfigState.testingError = warning.message;
        renderTestingWarning(warning);
        return false;
      }
      const startError = new Error(
        startResult?.details?.container_logs ||
          startResult.error ||
          'Failed to start test server',
      );
      startError.flowDetails = {
        errorCode:
          startResult.errorCode || 'START_SINGLE_MCP_SERVER_FAILED',
        message:
          startResult.message ||
          `${mcpConfigState.serverName || serverId} failed to start for testing.`,
      };
      throw startError;
    }
    sessionId = startResult.sessionId;
    if (!isMcpConfigTestRunActive(testRunId, serverId)) {
      return false;
    }
    mcpConfigState.activeSingleServerSessionId = sessionId;
    updateTestStep('start', 'success', 'Test server started');

    // Step 2: Wait for health
    updateTestStep('health', 'running', 'Checking server health...');
    // Managed Node servers may need first-run package preparation; Slack may
    // additionally rebuild its workspace caches on a genuinely cold start.
    const healthResult = await waitForServerHealth(
      serverId,
      mcpConfigReadinessTimeoutMs(serverId),
      {
        sessionId,
        isCancelled: () => !isMcpConfigTestRunActive(testRunId, serverId),
      },
    );
    if (healthResult.state === 'stale_session' || healthResult.state === 'cancelled') {
      return false;
    }
    if (healthResult.state === 'authorization_required') {
      window.markMcpServerOAuthUnauthenticated?.(serverId);
      updateTestStep('health', 'failed', 'OAuth authorization required');
      throw new Error(
        `${mcpConfigState.serverName || serverId} requires OAuth authorization. Your stored configuration was preserved.`,
      );
    }
    if (healthResult.state === 'failed' || !healthResult.healthy) {
      // Fetch container logs to show the actual error
      let containerLogs = '';
      try {
        const logsResult = await window.electronAPI.getWizardMcpServerLogs(
          serverId,
          100,
          { sessionId },
        );
        containerLogs = logsResult.logs || '';
      } catch (logErr) {
        console.warn('Failed to fetch container logs:', logErr);
      }
      updateTestStep('health', 'failed', 'Health check failed');
      throw new Error(
        containerLogs ||
        healthResult.error ||
        'Server health check timed out',
      );
    }
    updateTestStep('health', 'success', 'Server is healthy');

    // Step 3: Fetch tools
    updateTestStep('tools', 'running', 'Discovering tools...');
    const toolsResult = await fetchServerTools(serverId, { sessionId });
    if (!isMcpConfigTestRunActive(testRunId, serverId)) {
      return false;
    }
    if (toolsResult.tools && toolsResult.tools.length > 0) {
      mcpConfigState.discoveredTools = toolsResult.tools;
      updateTestStep('tools', 'success', `Found ${toolsResult.tools.length} tools`, toolsResult.tools);
    } else {
      updateTestStep('tools', 'success', 'No tools discovered (server may not expose tools)');
    }

    mcpConfigState.testingStatus = 'success';
    testSucceeded = true;

  } catch (err) {
    if (!isMcpConfigTestRunActive(testRunId, serverId)) {
      return false;
    }
    console.error('Server test failed:', err);
    failRunningTestStep();
    mcpConfigState.testingStatus = 'failed';
    mcpConfigState.testingError = err.message;
    markMcpConfigTestFailed(
      err.flowDetails || {
        errorCode: 'CONFIGURATION_TEST_FAILED',
        message: `${mcpConfigState.serverName || serverId} did not pass its configuration test.`,
      },
    );
  } finally {
    if (sessionId) {
      await stopOwnedSingleServerSession(serverId, sessionId);
    }

    if (
      isMcpConfigTestRunActive(testRunId, serverId) &&
      mcpConfigState.activeSingleServerSessionId === sessionId
    ) {
      mcpConfigState.activeSingleServerSessionId = null;
    }
    if (testSucceeded && isMcpConfigTestRunActive(testRunId, serverId)) {
      renderTestingSuccess();
    } else if (
      mcpConfigState.testingStatus === 'failed' &&
      isMcpConfigTestRunActive(testRunId, serverId)
    ) {
      renderTestingError(mcpConfigState.testingError);
    }
  }
  return testSucceeded;
}

function isMcpConfigTestRunActive(testRunId, serverId) {
  return (
    mcpConfigState.activeTestRunId === testRunId &&
    mcpConfigState.serverId === serverId
  );
}

async function stopOwnedSingleServerSession(serverId, sessionId) {
  if (!serverId || !sessionId) return;
  try {
    await window.electronAPI.stopSingleMcpServer(serverId, { sessionId });
  } catch (stopErr) {
    console.warn('Failed to stop test server:', stopErr);
  }
}

function cancelMcpConfigTest() {
  const serverId = mcpConfigState.serverId;
  const sessionId = mcpConfigState.activeSingleServerSessionId;
  mcpConfigState.activeTestRunId = ++mcpConfigTestRunSequence;
  mcpConfigState.activeSingleServerSessionId = null;
  if (mcpConfigState.testingStatus === 'running') {
    mcpConfigState.testingStatus = 'cancelled';
  }
  if (serverId && sessionId) {
    stopOwnedSingleServerSession(serverId, sessionId);
  }
}

// Resolve the single-server MCPO base URL (dynamic port allocated at start time)
async function getSingleServerBaseUrl(sessionId) {
  let baseUrl = "http://localhost:8770";
  if (window.electronAPI?.getSingleMcpServerBaseUrl) {
    const result = await window.electronAPI.getSingleMcpServerBaseUrl({
      sessionId,
    });
    if (!result?.success || !result.baseUrl) {
      throw new Error(result?.error || 'Single-server session is no longer active');
    }
    baseUrl = result.baseUrl;
  }
  return baseUrl;
}

// Wait for server to become healthy.
// The IPC handler performs a single quick HTTP check (~5s) per call,
// so the 2s poll interval gives true responsiveness.
// The caller supplies a server-specific safety timeout.
async function waitForServerHealth(serverId, timeout, options = {}) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeout) {
    if (options.isCancelled?.()) {
      return { state: 'cancelled', healthy: false, tools: [] };
    }
    try {
      const result = await window.electronAPI.checkSingleMcpServer(serverId, {
        sessionId: options.sessionId,
      });
      if (
        result?.state === 'healthy' ||
        result?.state === 'authorization_required' ||
        result?.state === 'failed' ||
        result?.state === 'stale_session'
      ) {
        return result;
      }
    } catch (err) {
      // Ignore errors during polling
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return {
    state: 'failed',
    healthy: false,
    tools: [],
    error: 'Server health check timed out',
  };
}

// Fetch server tools from OpenAPI
async function fetchServerTools(serverId, options = {}) {
  try {
    const baseUrl = await getSingleServerBaseUrl(options.sessionId);

    const response = await fetch(`${baseUrl}/${serverId}/openapi.json`);
    if (!response.ok) {
      return { tools: [] };
    }
    const openapi = await response.json();
    const tools = Object.keys(openapi.paths || {}).map(path => {
      const name = path.replace(/^\//, '').replace(/\//g, '_');
      return { name };
    });
    return { tools };
  } catch (err) {
    console.warn('Failed to fetch tools:', err);
    return { tools: [] };
  }
}

// Render testing progress UI
function renderTestingProgress() {
  const container = document.getElementById('mcp-config-testing-content');
  if (!container) return;

  container.innerHTML = `
    <div class="mcp-config-test-steps">
      <div class="mcp-config-test-step" data-step="start">
        <div class="mcp-config-test-icon pending">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        </div>
        <div class="mcp-config-test-content">
          <div class="mcp-config-test-title">Starting test server</div>
          <div class="mcp-config-test-detail">Preparing isolated environment...</div>
        </div>
      </div>
      <div class="mcp-config-test-step" data-step="health">
        <div class="mcp-config-test-icon pending">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        </div>
        <div class="mcp-config-test-content">
          <div class="mcp-config-test-title">Health check</div>
          <div class="mcp-config-test-detail">Waiting...</div>
        </div>
      </div>
      <div class="mcp-config-test-step" data-step="tools">
        <div class="mcp-config-test-icon pending">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
          </svg>
        </div>
        <div class="mcp-config-test-content">
          <div class="mcp-config-test-title">Discover tools</div>
          <div class="mcp-config-test-detail">Waiting...</div>
        </div>
      </div>
    </div>
  `;

  // Hide footer buttons during test
  const retryBtn = document.getElementById('mcp-config-retry-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  resetPromoteButton();
}

// Update a test step's status
function updateTestStep(stepId, status, detail, tools) {
  const step = document.querySelector(`.mcp-config-test-step[data-step="${stepId}"]`);
  if (!step) return;

  const iconEl = step.querySelector('.mcp-config-test-icon');
  const detailEl = step.querySelector('.mcp-config-test-detail');

  if (iconEl) {
    iconEl.className = `mcp-config-test-icon ${status}`;
    if (status === 'running') {
      iconEl.innerHTML = `
        <svg class="mcp-config-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
      `;
    } else if (status === 'success') {
      iconEl.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
      `;
    } else if (status === 'failed') {
      iconEl.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
      `;
    }
  }

  if (detailEl) {
    detailEl.textContent = detail;

    // Add tools list if provided
    if (tools && tools.length > 0) {
      const toolsList = document.createElement('div');
      toolsList.className = 'mcp-config-tools-list';
      toolsList.innerHTML = tools.map(t => `
        <div class="mcp-config-tool-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          ${escapeHtml(t.name)}
        </div>
      `).join('');
      detailEl.appendChild(toolsList);
    }
  }
}

function failRunningTestStep() {
  const failureDetails = {
    start: 'Failed to start test server',
    health: 'Health check failed',
    tools: 'Tool discovery failed',
  };

  for (const [stepId, detail] of Object.entries(failureDetails)) {
    const step = document.querySelector(
      `.mcp-config-test-step[data-step="${stepId}"]`,
    );
    const icon = step?.querySelector('.mcp-config-test-icon');
    if (icon?.classList.contains('running')) {
      updateTestStep(stepId, 'failed', detail);
      return;
    }
  }
}

// Render testing success state
function renderTestingSuccess() {
  const promoteBtn = document.getElementById('mcp-config-promote-btn');
  if (promoteBtn) {
    promoteBtn.style.display = 'inline-flex';
  }

  promoteToProduction();
}

function setConfigFinalizing(isFinalizing) {
  const finalizing = document.getElementById('mcp-config-finalizing');
  if (finalizing) {
    finalizing.style.display = 'none';
  }

  if (!isFinalizing) return;

  const retryBtn = document.getElementById('mcp-config-retry-btn');
  const promoteBtn = document.getElementById('mcp-config-promote-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  if (promoteBtn) {
    promoteBtn.style.display = 'inline-flex';
    promoteBtn.disabled = true;
    promoteBtn.innerHTML = getPromoteButtonContent('Wrapping up...');
  }
}

function renderTestingWarning(warning = {}) {
  const container = document.getElementById('mcp-config-testing-content');
  if (!container) return;

  const recoveryPrompt = String(warning.recoveryPrompt || '').trim();
  const recoveryLabel =
    String(warning.recoveryLabel || '').trim() || 'Continue setup in chat';
  const recoveryAction = recoveryPrompt
    ? `
        <button type="button" id="mcp-config-test-recovery-chat-btn" class="mcp-config-new-chat-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
          </svg>
          ${escapeHtml(recoveryLabel)}
        </button>
      `
    : '';

  container.innerHTML = `
    <div class="mcp-config-test-warning">
      <div class="mcp-config-test-warning-title">Setup needed</div>
      <div class="mcp-config-test-warning-message">${escapeHtml(
        warning.message || 'Saved setup information is unavailable.',
      )}</div>
      ${recoveryAction}
    </div>
  `;

  const recoveryButton = document.getElementById(
    'mcp-config-test-recovery-chat-btn',
  );
  recoveryButton?.addEventListener('click', async () => {
    recoveryButton.disabled = true;
    const opened = await openMcpConfigNewChat(recoveryPrompt);
    if (!opened) recoveryButton.disabled = false;
  });

  const retryBtn = document.getElementById('mcp-config-retry-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  resetPromoteButton();
}

// Render testing error state
function renderTestingError(errorMessage) {
  const container = document.getElementById('mcp-config-testing-content');
  if (container) {
    // Extract key error from logs if present
    let displayError = errorMessage;
    let logsSection = '';

    // Check if this looks like container logs (multi-line with timestamps)
    const isContainerLogs = errorMessage && (
      errorMessage.includes('{"level":') ||
      errorMessage.includes('"timestamp"') ||
      errorMessage.split('\n').length > 3
    );

    if (isContainerLogs) {
      // Try to extract the fatal/error message for display
      const lines = errorMessage.split('\n');
      let keyError = '';

      for (const line of lines) {
        try {
          // Parse JSON log lines
          if (line.includes('{"level":')) {
            const match = line.match(/\{[^}]+\}/g);
            if (match) {
              for (const jsonStr of match) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  if (parsed.level === 'fatal' || parsed.level === 'error') {
                    keyError = parsed.message || '';
                    break;
                  }
                } catch (e) { /* ignore parse errors */ }
              }
            }
          }
        } catch (e) { /* ignore parse errors */ }
      }

      displayError = keyError || 'Server failed to start. See logs below for details.';
      logsSection = `
        <div class="mcp-config-test-logs">
          <div class="mcp-config-test-logs-header">Container Logs</div>
          <pre class="mcp-config-test-logs-content">${escapeHtml(errorMessage)}</pre>
        </div>
      `;
    }

    container.innerHTML += `
      <div class="mcp-config-test-error">
        <div class="mcp-config-test-error-title">Test Failed</div>
        <div class="mcp-config-test-error-message">${escapeHtml(displayError)}</div>
        ${logsSection}
      </div>
    `;
  }

  const retryBtn = document.getElementById('mcp-config-retry-btn');
  if (retryBtn) {
    retryBtn.style.display = 'inline-flex';
  }
}

// Reset testing pane
function resetTestingPane() {
  const modal = document.getElementById('mcp-config-modal');
  const modalContent = modal?.querySelector('.mcp-config-modal');
  if (modalContent) {
    modalContent.classList.remove('testing-expanded');
  }

  // Reset main panel width if it was resized
  resetMcpConfigMainPanelWidth();

  const container = document.getElementById('mcp-config-testing-content');
  if (container) {
    container.innerHTML = '';
  }

  setConfigFinalizing(false);

  const retryBtn = document.getElementById('mcp-config-retry-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  resetPromoteButton();
}

// Promote configuration to production
async function promoteToProduction() {
  const promoteBtn = document.getElementById('mcp-config-promote-btn');
  const serverId = mcpConfigState.serverId;
  if (promoteBtn) {
    promoteBtn.disabled = true;
    promoteBtn.style.display = 'inline-flex';
    promoteBtn.innerHTML = getPromoteButtonContent('Enabling...');
  }

  try {
    const promoteStartedAt = Date.now();
    const serverConfig = window.appState?.servers?.find((s) => s.id === serverId);
    const deploymentType = serverConfig?.deploymentType || 'docker';

    // Step 1: Persist enabled toggle state for this integration.
    // This keeps card state aligned with backend health status.
    console.log(`[MCP Config] Enabling server toggle for ${serverId}...`);
    const toggleResult = await window.electronAPI.toggleMcpServer(
      serverId,
      true,
      deploymentType,
      { backgroundLifecycle: true },
    );
    if (!toggleResult?.success) {
      throw new Error(toggleResult?.error || 'Failed to enable server');
    }
    if (toggleResult?.requiresConfiguration) {
      throw new Error(
        toggleResult.message ||
        toggleResult.error ||
        'Configuration is still incomplete; the server was not started.'
      );
    }
    if (window.appState?.toggles) {
      window.appState.toggles[serverId] = true;
    }
    console.log(`[MCP Config] Toggle enabled for ${serverId}`);

    // Step 2: The backend lifecycle is already queued by toggleMcpServer.
    // Hand the returned authoritative snapshot to the operation controller and
    // let its readiness scheduler own all subsequent card and modal state.
    // Starting a second renderer-side readiness loop here races configuration
    // regeneration and can combine a stale Failed status with optimistic text.
    setConfigFinalizing(true);
    window.McpOperationOverlayController?.acceptSnapshot?.(toggleResult);

    console.log(`[MCP Config] Enable queued in ${Date.now() - promoteStartedAt}ms`);

    closeMcpConfigModal({ outcome: 'completed' });

    // Refresh server list
    if (typeof window.refreshMcpServersList === 'function') {
      window.refreshMcpServersList();
    } else if (typeof refreshMcpServersList === 'function') {
      refreshMcpServersList();
    }

  } catch (err) {
    console.error('Failed to promote to production:', err);
    showConfigNotification('Failed to enable server: ' + err.message, 'error');
    setConfigFinalizing(false);

    markMcpConfigTestFailed({
      errorCode: 'CONFIGURATION_ENABLE_FAILED',
      message: `${mcpConfigState.serverName || serverId} could not be enabled after testing.`,
    });

    if (promoteBtn) {
      promoteBtn.disabled = false;
      promoteBtn.innerHTML = 'Enable Server';
      promoteBtn.style.display = 'inline-flex';
    }
  }
}

// Close the modal
function closeMcpConfigModal(options = {}) {
  const modal = document.getElementById('mcp-config-modal');
  if (!modal) return false;

  // Warn about unsaved changes
  if (
    options.skipUnsavedConfirm !== true &&
    !confirmMcpConfigDiscardChanges()
  ) {
    return false;
  }

  const outcome =
    options.outcome ||
    (options.skipDismissNotify === true
      ? 'completed'
      : mcpConfigState.pendingFlowOutcome || 'dismissed');
  notifyMcpConfigFlowOutcome(
    outcome,
    outcome === 'test_failed' ? mcpConfigState.testingFailure || {} : {},
  );

  cancelMcpConfigTest();

  const resolveFlow = mcpConfigState.resolveFlow;
  const flowResult = {
    success: outcome === 'completed',
    completed: outcome === 'completed',
    dismissed: outcome === 'dismissed',
    test_failed: outcome === 'test_failed',
    redirected_to_chat: outcome === 'redirected_to_chat',
    outcome,
    server_id: mcpConfigState.serverId,
    flow_id: mcpConfigState.flowId,
  };

  // Just hide the modal - don't reset anything here to avoid jank
  // State and testing pane are reset when modal opens (like log-viewer-modal pattern)
  window.suppressMcpBadgeTooltip?.({ untilPointerMove: true });
  modal.classList.remove('visible');
  window.setNativeOverlayInteractionSuppressed?.('mcp-config-modal', false);
  getMcpConfigGuidanceApi().resetMcpConfigGuidance();

  // Reset state immediately (doesn't affect visuals)
  mcpConfigState = createInitialMcpConfigState();
  if (typeof resolveFlow === 'function') {
    resolveFlow(flowResult);
  }
  return true;
}

// Attach event listeners
function attachModalEventListeners() {
  const closeBtn = document.getElementById('mcp-config-close-btn');
  const cancelBtn = document.getElementById('mcp-config-cancel-btn');
  const saveBtn = document.getElementById('mcp-config-save-btn');
  const testingCloseBtn = document.getElementById('mcp-config-testing-close-btn');
  const retryBtn = document.getElementById('mcp-config-retry-btn');
  const promoteBtn = document.getElementById('mcp-config-promote-btn');
  const modal = document.getElementById('mcp-config-modal');

  // Remove old listeners by cloning
  if (closeBtn) {
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener('click', () => closeMcpConfigModal());
  }

  if (cancelBtn) {
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.addEventListener('click', () => closeMcpConfigModal());
  }

  if (saveBtn) {
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', async () => {
      getMcpConfigGuidanceApi().clearMcpConfigPulseState();
      newSaveBtn.disabled = true;
      newSaveBtn.innerHTML = `
        <svg class="mcp-config-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
        Saving...
      `;

      const oauthReady = await ensureMcpConfigOAuthReady();
      if (oauthReady) {
        const saved = await validateAndSave();
        if (saved) {
          await startServerTest({ skipOAuthCheck: true });
        }
      }

      newSaveBtn.disabled = false;
      newSaveBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        Save & Test
      `;
      if (mcpConfigState.testingStatus !== 'success') {
        getMcpConfigGuidanceApi().refreshMcpConfigGuidance(getMcpConfigGuidanceCallbacks());
      }
    });
  }

  if (testingCloseBtn) {
    const newTestingCloseBtn = testingCloseBtn.cloneNode(true);
    testingCloseBtn.parentNode.replaceChild(newTestingCloseBtn, testingCloseBtn);
    newTestingCloseBtn.addEventListener('click', () => {
      cancelMcpConfigTest();
      resetTestingPane();
    });
  }

  if (retryBtn) {
    const newRetryBtn = retryBtn.cloneNode(true);
    retryBtn.parentNode.replaceChild(newRetryBtn, retryBtn);
    newRetryBtn.addEventListener('click', startServerTest);
  }

  if (promoteBtn) {
    const newPromoteBtn = promoteBtn.cloneNode(true);
    promoteBtn.parentNode.replaceChild(newPromoteBtn, promoteBtn);
    newPromoteBtn.addEventListener('click', promoteToProduction);
  }

  // Click outside to close
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        if (!allowsImplicitMcpConfigDismiss()) {
          return;
        }
        closeMcpConfigModal();
      }
    };
  }

  // ESC key to close
  if (mcpConfigEscHandler) {
    document.removeEventListener('keydown', mcpConfigEscHandler);
  }

  mcpConfigEscHandler = (e) => {
    if (e.key === 'Escape') {
      const modalEl = document.getElementById('mcp-config-modal');
      if (modalEl && modalEl.classList.contains('visible')) {
        if (!allowsImplicitMcpConfigDismiss()) {
          e.preventDefault?.();
          e.stopPropagation?.();
          return;
        }
        closeMcpConfigModal();
      }
    }
  };
  document.addEventListener('keydown', mcpConfigEscHandler);
}

// Show notification (use app's notification system)
function showConfigNotification(message, type) {
  if (typeof window.showNotification === 'function') {
    window.showNotification(message, type);
  } else {
    console.log(`[${type}] ${message}`);
  }
}

// ============================================================================
// DIVIDER DRAG FUNCTIONALITY
// ============================================================================

let mcpConfigDividerState = {
  isDragging: false,
  startX: 0,
  startWidth: 0
};

/**
 * Initialize divider drag functionality
 */
function initMcpConfigDividerDrag() {
  const divider = document.getElementById('mcp-config-divider');
  if (!divider) return;

  // Remove old listeners first (in case of re-init)
  divider.removeEventListener('mousedown', startMcpConfigDividerDrag);
  document.removeEventListener('mousemove', onMcpConfigDividerDrag);
  document.removeEventListener('mouseup', stopMcpConfigDividerDrag);

  // Add new listeners
  divider.addEventListener('mousedown', startMcpConfigDividerDrag);
  document.addEventListener('mousemove', onMcpConfigDividerDrag);
  document.addEventListener('mouseup', stopMcpConfigDividerDrag);
  document.addEventListener('pointercancel', stopMcpConfigDividerDrag);
  window.addEventListener('blur', stopMcpConfigDividerDrag);
}

function startMcpConfigDividerDrag(e) {
  const mainPanel = document.querySelector('.mcp-config-main');
  if (!mainPanel) return;

  mcpConfigDividerState.isDragging = true;
  mcpConfigDividerState.startX = e.clientX;
  mcpConfigDividerState.startWidth = mainPanel.getBoundingClientRect().width;

  document.getElementById('mcp-config-divider')?.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
}

function onMcpConfigDividerDrag(e) {
  if (!mcpConfigDividerState.isDragging) return;

  const mainPanel = document.querySelector('.mcp-config-main');
  const modalContent = document.querySelector('.mcp-config-modal');
  if (!mainPanel || !modalContent) return;

  const delta = e.clientX - mcpConfigDividerState.startX;
  const newWidth = Math.max(350, Math.min(mcpConfigDividerState.startWidth + delta, modalContent.clientWidth - 350));

  mainPanel.style.flex = `0 0 ${newWidth}px`;
  mainPanel.style.minWidth = `${newWidth}px`;
  mainPanel.style.maxWidth = `${newWidth}px`;
}

function stopMcpConfigDividerDrag() {
  if (!mcpConfigDividerState.isDragging) return;

  mcpConfigDividerState.isDragging = false;
  document.getElementById('mcp-config-divider')?.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

/**
 * Reset main panel to default width (remove any custom sizing from drag)
 */
function resetMcpConfigMainPanelWidth() {
  const mainPanel = document.querySelector('.mcp-config-main');
  if (mainPanel) {
    mainPanel.style.flex = '';
    mainPanel.style.minWidth = '';
    mainPanel.style.maxWidth = '';
  }
}

// Expose to window for external access
window.openMcpConfigModal = openMcpConfigModal;
window.closeMcpConfigModal = closeMcpConfigModal;
window.initMcpConfigDividerDrag = initMcpConfigDividerDrag;
