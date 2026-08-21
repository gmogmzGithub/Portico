// Finalize screen module for guided setup
// Generates .env and MCP configuration
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

const {
  getSelectedServerIdsFromIndices,
} = require('../../../services/guided-setup/server-selection-state');

let finalizeInProgress = false;
let finalizeGatePollToken = 0;
const FINALIZE_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const GENERIC_PREREQ_BLOCK_MESSAGE = 'Oops, something went wrong. Please navigate to the prereqs step.';
// Canonical runtime secret keys persisted via upsertRuntimeSecret.
const RUNTIME_SECRET_KEYS = new Set([
  'PORTICO_LLM_API_KEY',
  'LOCAL_STACK_API_KEY',
  'BIFROST_BRIDGE_LOCAL_API_KEY',
  'OWUI_AUTH_BRIDGE_SECRET',
  'WEBUI_SECRET_KEY',
  'ULTRA_MULTI_AGENT_SIGNING_SECRET',
  'CLOUDSMITH_ENTITLEMENT_TOKEN',
]);
// Broader runtime strip set. CLOUDSMITH_API_KEY is protected release-operator
// input in the repository .env and must survive setup finalization.
const RUNTIME_SECRET_STRIP_KEYS = new Set([
  ...RUNTIME_SECRET_KEYS,
  'INTERNAL_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'PORTICO_LLM_API_KEY_FILE',
  'BIFROST_BRIDGE_LOCAL_API_KEY_FILE',
  'OWUI_AUTH_BRIDGE_SECRET_FILE',
  'WEBUI_SECRET_KEY_FILE',
  'ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE',
  'SLACK_OAUTH_CLIENT_ID',
  'SLACK_OAUTH_CLIENT_SECRET',
  'SLACK_OAUTH_CLIENT_ID_FILE',
  'SLACK_OAUTH_CLIENT_SECRET_FILE',
  'SLACK_MCP_XOXP_TOKEN',
  'SLACK_MCP_XOXP_TOKEN_FILE',
]);
const PLACEHOLDER_RUNTIME_SECRET_PATTERNS = [
  /^your[-_]/i,
  /placeholder/i,
  /^example(?:[-_]|$)/i,
  /(?:^|[-_\s])(api[-_\s]?)?key[-_\s]?here(?:$|[-_\s])/i,
  /(?:^|[-_\s])paste[-_\s]?here(?:$|[-_\s])/i,
];

function isPlaceholderRuntimeSecret(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return false;
  }
  return PLACEHOLDER_RUNTIME_SECRET_PATTERNS.some((pattern) =>
    pattern.test(normalizedValue),
  );
}

function stripRuntimeSecretsFromEnvContent(envContent) {
  let nextContent = String(envContent || '');
  for (const runtimeKey of RUNTIME_SECRET_STRIP_KEYS) {
    const runtimeKeyRegex = new RegExp(`^${runtimeKey}=.*$`, 'gm');
    if (nextContent.match(runtimeKeyRegex)) {
      nextContent = nextContent.replace(runtimeKeyRegex, '');
    }
  }
  return nextContent.replace(/\n\n\n+/g, '\n\n');
}

function collectSensitiveRequiredEnvKeys(setupState = {}) {
  const keys = new Set();
  const serverLists = [setupState.mcpServers, setupState.serverConfigs];
  for (const servers of serverLists) {
    for (const server of Array.isArray(servers) ? servers : []) {
      for (const envVar of server.required_env_vars || server.requiredVars || []) {
        if (envVar?.sensitive === true && envVar.name) {
          keys.add(envVar.name);
        }
      }
    }
  }
  return keys;
}

async function persistRuntimeSecretIfNeeded(key, value, sensitiveKeys = new Set()) {
  if (!RUNTIME_SECRET_KEYS.has(key) && !sensitiveKeys.has(key)) {
    return false;
  }

  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue || isPlaceholderRuntimeSecret(normalizedValue)) {
    console.log(
      `[generateEnvFile] Skipping empty/placeholder runtime secret for ${key}`,
    );
    return true;
  }

  if (typeof window.electronAPI?.upsertRuntimeSecret !== 'function') {
    throw new Error('Runtime secret persistence is unavailable');
  }

  const result = await window.electronAPI.upsertRuntimeSecret(
    key,
    normalizedValue,
  );
  if (!result?.success) {
    throw new Error(result?.error || `Failed to persist ${key}`);
  }

  console.log(`[generateEnvFile] Persisted runtime secret for ${key}`);
  return true;
}

function isFinalizeStageActive() {
  const stage = document.getElementById('stage-finalize');
  return Boolean(stage && stage.classList.contains('active'));
}

function getFinalizeLoadingElements() {
  const stage = document.getElementById('stage-finalize');
  return {
    stage,
    setupStep: stage?.querySelector('.setup-step') || null,
    wrapupLabel: stage?.querySelector('.finalize-wrapup-label') || null,
    statusEl: document.getElementById('finalize-status'),
  };
}

function formatImageList(images = [], maxItems = 3) {
  if (!Array.isArray(images) || images.length === 0) {
    return '';
  }

  const visible = images.slice(0, maxItems).join(', ');
  const remaining = images.length - maxItems;
  return remaining > 0 ? `${visible}, plus ${remaining} more` : visible;
}

function buildFinalizeTimeoutError(readiness = null) {
  const parts = [
    `Finalize timed out after ${Math.round(FINALIZE_WAIT_TIMEOUT_MS / 60000)} minutes.`,
  ];
  const missingImages = Array.isArray(readiness?.missingImages) ? readiness.missingImages : [];

  if (missingImages.length > 0) {
    parts.push(`Required Docker images are still unavailable: ${formatImageList(missingImages)}.`);
  } else if (typeof readiness?.error === 'string' && readiness.error.trim()) {
    parts.push(readiness.error.trim());
  } else {
    parts.push('Required setup prerequisites did not finish in time.');
  }

  return parts.join(' ');
}

function buildFinalizeTimeoutGuidance(readiness = null) {
  const missingImages = Array.isArray(readiness?.missingImages) ? readiness.missingImages : [];
  if (missingImages.length > 0) {
    return 'Return to the prereqs step, or manually pull the missing Docker images in Terminal, then reopen setup.';
  }
  return 'Return to the prereqs step and retry setup. If Docker image pulls keep stalling, use the Terminal workaround before reopening the app.';
}

function hasFinalizeWaitTimedOut(startedAt, now = Date.now()) {
  return now - startedAt >= FINALIZE_WAIT_TIMEOUT_MS;
}

function restartSetupWizardFromFinalize(callbacks = {}) {
  finalizeGatePollToken += 1;
  finalizeInProgress = false;
  clearFinalizeGateState();

  const restart = callbacks.restartSetupWizardFromFinalize;
  if (typeof restart === 'function') {
    Promise.resolve(restart()).catch((error) => {
      console.error('[screen-finalize] Failed to restart setup wizard:', error);
    });
    return;
  }

  if (typeof callbacks.showStage === 'function') {
    Promise.resolve(callbacks.showStage('hello')).catch((error) => {
      console.error('[screen-finalize] Failed to return to setup wizard:', error);
    });
  }
}

function retryFinalizeFromGate(callbacks = {}) {
  // Retry means retry: finalize's steps are idempotent (env upsert by regex,
  // declarative toggle patch, config regeneration, completion overwrite), so
  // re-running it is cheap and correct. Restarting the whole wizard here --
  // the old behavior -- threw away OAuth progress and re-ran the flow that
  // produced the failure in the first place. finalizeInProgress absorbs
  // double-clicks; do not force-clear it.
  if (typeof callbacks.finalizeSetup !== 'function') {
    restartSetupWizardFromFinalize(callbacks);
    return;
  }
  finalizeGatePollToken += 1;
  clearFinalizeGateState();
  Promise.resolve(callbacks.finalizeSetup()).catch((error) => {
    console.error('[screen-finalize] Finalize retry failed:', error);
  });
}

function bindFinalizeRetryButton(statusEl, callbacks = {}) {
  const retryButton = statusEl?.querySelector?.('[data-finalize-retry]');
  if (retryButton) {
    retryButton.addEventListener('click', (event) => {
      event?.preventDefault?.();
      retryFinalizeFromGate(callbacks);
    });
  }

  const startOverButton = statusEl?.querySelector?.('[data-finalize-start-over]');
  if (startOverButton) {
    startOverButton.addEventListener('click', (event) => {
      event?.preventDefault?.();
      restartSetupWizardFromFinalize(callbacks);
    });
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFinalizeGateState({
  title,
  message,
  error = null,
  guidance = null,
  errorCode = null,
  allowPrereqNavigation = false,
  retry = false,
  callbacks = {}
}) {
  const { setupStep, wrapupLabel, statusEl } = getFinalizeLoadingElements();
  if (!statusEl) return;

  if (error) {
    if (setupStep) {
      setupStep.style.display = 'none';
    }
    statusEl.setAttribute('aria-hidden', 'false');

    const isPackagedBinaryMissing =
      error.includes('bundled signed mcp-orc') ||
      error.includes('bundled MCP generator binary');
    const isRustMissing = error.includes('rustup') || error.includes('cargo is required');
    // Going back to prereqs cannot clear a held MCP mutation lease, so never
    // offer that advice for a busy error -- waiting or restarting is the fix.
    const isMcpMutationBusy = errorCode === 'MCP_OPERATION_BUSY';
    const resolvedGuidance = guidance || (isPackagedBinaryMissing
      ? 'This packaged build is missing its bundled MCP generator binary. Reinstall or rebuild the app package; do not install Rust locally.'
      : isRustMissing
        ? 'The Rust toolchain is required in development mode. Install it with: <code>curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh</code>, then restart the app.'
        : isMcpMutationBusy
          ? 'Another change to your MCP servers is still in progress. Wait a moment and press Retry. If it keeps failing, quit Portico completely and reopen it.'
          : 'Please return to the prereqs step and let setup finish before trying again.');
    const canNavigateToPrereqs =
      allowPrereqNavigation &&
      !isPackagedBinaryMissing &&
      !isRustMissing &&
      !isMcpMutationBusy &&
      typeof window !== 'undefined' &&
      typeof window.navigateToStep === 'function';

    statusEl.innerHTML = `
      <div class="setup-readiness-card">
        <div class="setup-readiness-title">${escapeHtml(title || 'Finalize is blocked.')}</div>
        <div class="setup-readiness-error">${escapeHtml(error)}</div>
        <div class="setup-readiness-message">${resolvedGuidance}</div>
        ${canNavigateToPrereqs ? `
          <div>
            <button class="btn btn-secondary" type="button" id="finalize-readiness-back-btn">Go to Prereqs</button>
          </div>
        ` : ''}
        ${retry ? '<button type="button" class="btn btn-primary setup-readiness-retry-btn" data-finalize-retry>Retry</button> <button type="button" class="btn btn-secondary setup-readiness-start-over-btn" data-finalize-start-over>Start over</button>' : ''}
      </div>
    `;
    if (canNavigateToPrereqs) {
      const backBtn = document.getElementById('finalize-readiness-back-btn');
      if (backBtn) {
        backBtn.onclick = () => {
          finalizeGatePollToken += 1;
          window.navigateToStep('prerequisites');
        };
      }
    }
    if (retry) {
      bindFinalizeRetryButton(statusEl, callbacks);
    }
    return;
  }

  if (setupStep) {
    setupStep.style.display = '';
  }
  if (wrapupLabel) {
    wrapupLabel.textContent = message || title || 'Wrapping things up...';
  }
  statusEl.innerHTML = '';
  statusEl.setAttribute('aria-hidden', 'true');
}

function clearFinalizeGateState() {
  const { setupStep, wrapupLabel, statusEl } = getFinalizeLoadingElements();
  if (!statusEl) return;
  if (setupStep) {
    setupStep.style.display = '';
  }
  if (wrapupLabel) {
    wrapupLabel.textContent = 'Wrapping things up...';
  }
  statusEl.innerHTML = '';
  statusEl.setAttribute('aria-hidden', 'true');
}

function hasHostSelections(setupState) {
  const selectedIndices = Array.isArray(setupState.selectedServers) ? setupState.selectedServers : [];
  return selectedIndices.some((index) => {
    const server = setupState.mcpServers?.[index];
    const deploymentType = server?.deploymentType || server?.deployment_type || 'docker';
    return deploymentType === 'host';
  });
}

function getSelectedServerIds(setupState) {
  return getSelectedServerIdsFromIndices(
    Array.isArray(setupState?.mcpServers) ? setupState.mcpServers : [],
    Array.isArray(setupState?.selectedServers) ? setupState.selectedServers : [],
  );
}

function isGenericFinalizePrereqBlock(error) {
  return String(error || '').trim() === GENERIC_PREREQ_BLOCK_MESSAGE;
}

function formatFinalizeLogPayload(payload) {
  try {
    return JSON.stringify(payload);
  } catch (_error) {
    return String(payload);
  }
}

async function tryResumePrerequisitesForFinalize(setupState) {
  if (!window.electronAPI?.prerequisitesResumeInteractive) {
    return { attempted: false, success: false, error: null };
  }

  try {
    const hasSelectedHostMode = hasHostSelections(setupState);
    const selectedServerIds = getSelectedServerIds(setupState);
    const result = await window.electronAPI.prerequisitesResumeInteractive({
      onboardingMode: setupState.onboardingMode || 'power',
      purpose: 'guided-setup-finalize',
      hasHostSelections: hasSelectedHostMode,
      selectedServerIds,
    });
    if (!result?.success) {
      return {
        attempted: true,
        success: false,
        error: result?.error || 'Failed to resume prerequisites'
      };
    }
    return { attempted: true, success: true, error: null };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      error: error?.message || 'Failed to resume prerequisites'
    };
  }
}

async function waitForFinalizeReadiness(setupState, callbacks = {}) {
  if (!window.electronAPI?.prerequisitesCheckFinalizeReadiness) {
    return true;
  }

  const pollToken = ++finalizeGatePollToken;
  const finalizeWaitStartedAt = Date.now();
  let recoveryAttempted = false;
  let lastReadiness = null;
  renderFinalizeGateState({
    title: 'Finishing setup...',
    message: 'Finishing the last setup checks before we open Portico.'
  });

  while (pollToken === finalizeGatePollToken && isFinalizeStageActive()) {
    if (hasFinalizeWaitTimedOut(finalizeWaitStartedAt)) {
      renderFinalizeGateState({
        title: 'Finalize timed out.',
        error: buildFinalizeTimeoutError(lastReadiness),
        guidance: buildFinalizeTimeoutGuidance(lastReadiness),
        retry: true,
        callbacks,
      });
      return false;
    }

    const readinessRequest = {
      mode: setupState.onboardingMode || 'power',
      hasHostSelections: hasHostSelections(setupState),
      selectedServerIds: getSelectedServerIds(setupState),
    };
    console.log(
      '[screen-finalize] Polling finalize readiness:',
      formatFinalizeLogPayload(readinessRequest),
    );
    const readiness = await window.electronAPI.prerequisitesCheckFinalizeReadiness(readinessRequest);
    console.log(
      '[screen-finalize] Finalize readiness result:',
      formatFinalizeLogPayload(readiness),
    );
    if (readiness?.success) {
      lastReadiness = readiness;
    }

    if (hasFinalizeWaitTimedOut(finalizeWaitStartedAt)) {
      renderFinalizeGateState({
        title: 'Finalize timed out.',
        error: buildFinalizeTimeoutError(lastReadiness),
        guidance: buildFinalizeTimeoutGuidance(lastReadiness),
        retry: true,
        callbacks,
      });
      return false;
    }

    if (!readiness?.success) {
      renderFinalizeGateState({
        title: 'Finalize is blocked.',
        error: readiness?.error || 'Oops, something went wrong. Please navigate to the prereqs step.',
        allowPrereqNavigation: true,
        retry: true,
        callbacks,
      });
      return false;
    }

    if (readiness.ready) {
      clearFinalizeGateState();
      return true;
    }

    if (readiness.error) {
      if (!recoveryAttempted && !readiness.waiting && isGenericFinalizePrereqBlock(readiness.error)) {
        recoveryAttempted = true;
        console.warn('[screen-finalize] Finalize hit the generic prereq block. Attempting one recovery pass.');
        renderFinalizeGateState({
          title: 'Finishing setup...',
          message: 'Resuming setup prerequisites before the final handoff.'
        });

        const resumeResult = await tryResumePrerequisitesForFinalize(setupState);
        console.log(
          '[screen-finalize] Finalize prereq recovery result:',
          formatFinalizeLogPayload(resumeResult),
        );
        if (!resumeResult.success) {
          renderFinalizeGateState({
            title: 'Finalize is blocked.',
            error: resumeResult.error || readiness.error,
            retry: true,
            callbacks,
          });
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }

      if (recoveryAttempted) {
        console.warn(
          '[screen-finalize] Finalize remained blocked after recovery:',
          formatFinalizeLogPayload(readiness),
        );
      }
      renderFinalizeGateState({
        title: 'Finalize is blocked.',
        error: readiness.error,
        allowPrereqNavigation: true,
        retry: true,
        callbacks,
      });
      return false;
    }

    renderFinalizeGateState({
      title: 'Finishing setup...',
      message: 'Applying the last few changes now. This should only take a moment.'
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return false;
}

// Finalize setup
async function finalizeSetup(setupState, projectRoot, callbacks = {}) {
  if (finalizeInProgress) {
    return;
  }

  finalizeInProgress = true;
  try {
    const ready = await waitForFinalizeReadiness(setupState, callbacks);
    if (!ready) {
      return;
    }

    // Generate .env file
    await generateEnvFile(setupState, projectRoot, callbacks);

    // Persist explicit MCP server toggles from guided setup selection
    await persistMcpTogglesFromSelection(setupState, callbacks);

    // Generate MCP configuration
    await generateMcpConfig(projectRoot, callbacks);

    const completionResult = await window.electronAPI.markSetupRequirementCompleted();
    if (!completionResult?.success) {
      throw new Error(
        completionResult?.error || 'Failed to persist setup completion state',
      );
    }
    if (callbacks.addLog) {
      callbacks.addLog(
        `Setup completion recorded for requirement ${completionResult.setupRequirementId}`,
        'success',
      );
    }

    if (callbacks.showStage) {
      callbacks.showStage('success');
    }
    if (callbacks.addLog) {
      callbacks.addLog('Setup completed successfully!', 'success');
    }

  } catch (err) {
    console.error('Setup failed:', err);
    if (callbacks.addLog) {
      callbacks.addLog(`Setup failed: ${err.message}`, 'error');
    }
    renderFinalizeGateState({
      title: 'Setup could not be completed',
      error: err.message,
      errorCode: err?.code || null,
      retry: true,
      callbacks,
    });
  } finally {
    finalizeInProgress = false;
  }
}

// Persist MCP toggle selection from guided setup
async function persistMcpTogglesFromSelection(setupState, callbacks = {}) {
  try {
    const toggleState = setupState.mcpToggleState || {};
    const changes =
      toggleState.changes &&
      typeof toggleState.changes === 'object' &&
      !Array.isArray(toggleState.changes)
        ? { ...toggleState.changes }
        : {};
    if (toggleState.writeMode !== 'apply' || Object.keys(changes).length === 0) {
      if (callbacks.addLog) {
        callbacks.addLog('Existing MCP server selection preserved', 'info');
      }
      return { success: true, applied: false, changedServerIds: [] };
    }
    if (typeof window.electronAPI.applyGuidedSetupMcpToggleChanges !== 'function') {
      throw new Error('Guided setup MCP toggle update is unavailable');
    }

    const saveResult = await window.electronAPI.applyGuidedSetupMcpToggleChanges({
      setupOperationId: setupState.launchContext?.setupOperationId || null,
      setupMode: setupState.launchContext?.setupMode || null,
      setupReason: setupState.launchContext?.setupReason || null,
      changes,
    });
    if (!saveResult?.success) {
      throw new Error(saveResult?.error || 'Failed to save MCP toggle selection');
    }

    if (callbacks.addLog) {
      callbacks.addLog('MCP server selection saved', 'success');
    }
    return saveResult;
  } catch (err) {
    throw new Error(`Failed to persist MCP server selection: ${err.message}`);
  }
}

// Generate .env file
async function generateEnvFile(setupState, projectRoot, callbacks = {}) {
  try {
    // Read existing .env or create new via IPC
    const readResult = await window.electronAPI.readEnvFile();

    let envContent = '';
    if (readResult.success && readResult.content) {
      envContent = readResult.content;
    } else {
      envContent = '# Portico Configuration\n\n';
    }

    const sensitiveKeys = collectSensitiveRequiredEnvKeys(setupState);
    for (const key of sensitiveKeys) {
      RUNTIME_SECRET_STRIP_KEYS.add(key);
      RUNTIME_SECRET_STRIP_KEYS.add(`${key}_FILE`);
    }
    envContent = stripRuntimeSecretsFromEnvContent(envContent);

    // Ensure content ends with newline before appending
    if (envContent.length > 0 && !envContent.endsWith('\n')) {
      envContent += '\n';
    }

    // Ensure all configured environment variables are saved
    for (const [key, value] of Object.entries(setupState.envVars)) {
      if (key === 'PORTICO_USER_ID' || key === 'PORTICO_USER_NAME') {
        continue;
      }
      if (await persistRuntimeSecretIfNeeded(key, value, sensitiveKeys)) {
        continue;
      }

      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
      if (envContent.match(regex)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    // Write .env file via IPC
    const writeResult = await window.electronAPI.writeEnvFile(envContent);

    if (!writeResult.success) {
      const writeError = new Error(writeResult.error || 'Failed to write .env file');
      // Preserve the machine-readable code so the gate can pick the right
      // guidance instead of pattern-matching the message text.
      writeError.code = writeResult.errorCode || null;
      throw writeError;
    }

    if (callbacks.addLog) {
      callbacks.addLog('.env file updated', 'success');
    }

  } catch (err) {
    const wrapped = new Error(`Failed to update .env file: ${err.message}`);
    wrapped.code = err?.code || null;
    throw wrapped;
  }
}

function buildGenerateMcpConfigFailureMessage(errorLike) {
  const fragments = [];

  for (const value of [
    errorLike?.error,
    errorLike?.message,
    errorLike?.details,
    errorLike?.stderr,
    errorLike?.stdout,
  ]) {
    const normalized = String(value || "").trim();
    if (!normalized || fragments.includes(normalized)) {
      continue;
    }
    fragments.push(normalized);
  }

  return fragments.join('\n\n') || 'unknown error';
}

// Generate MCP configuration
async function generateMcpConfig(projectRoot, callbacks = {}) {
  try {
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new TypeError('projectRoot (string) is required');
    }
    if (!window.electronAPI?.generateMcpConfig) {
      throw new Error('generateMcpConfig IPC is unavailable');
    }

    const result = await window.electronAPI.generateMcpConfig(projectRoot);

    if (!result?.success) {
      throw new Error(buildGenerateMcpConfigFailureMessage(result));
    }

    if (callbacks.addLog) {
      callbacks.addLog('MCP configuration generated', 'success');
    }

  } catch (err) {
    console.error('Failed to generate MCP config:', err);
    throw new Error(
      `Failed to generate MCP configuration: ${buildGenerateMcpConfigFailureMessage(err)}`,
    );
  }
}

// Export functions
module.exports = {
  finalizeSetup,
  generateEnvFile,
  generateMcpConfig,
  persistMcpTogglesFromSelection,
  _test: {
    hasHostSelections,
    getSelectedServerIds,
    waitForFinalizeReadiness,
    isGenericFinalizePrereqBlock,
    tryResumePrerequisitesForFinalize,
    buildFinalizeTimeoutError,
    buildFinalizeTimeoutGuidance,
    formatImageList,
    hasFinalizeWaitTimedOut,
    FINALIZE_WAIT_TIMEOUT_MS,
    renderFinalizeGateState,
    clearFinalizeGateState,
    restartSetupWizardFromFinalize,
    retryFinalizeFromGate
  }
};
