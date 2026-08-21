// screen-prerequisites.js
// Simplified prerequisites screen for guided setup
// Keeps the staged prerequisites session business logic while presenting
// a single calm status surface instead of detailed operational UI.

const MAX_LOG_LINES = 500;
const HOST_MODE_PHASE = 4;
const HOST_MODE_WARNING_MESSAGE = 'Host mode is optional. You can continue without it; it is only needed to automate your web browser and can be enabled later.';
const PREREQ_STAGE_TRANSITION_DELAY_MS = 1000;
const PREREQ_FINAL_AUTO_ADVANCE_DELAY_MS = 2000;
const TERMINAL_RECOVERY_TITLE = 'Manual step required...';
const TERMINAL_RECOVERY_BODY = 'Please click the button below.';
const TERMINAL_RECOVERY_FOLLOWUP = 'Then paste into the terminal and hit Return.';
const TERMINAL_PASSWORD_HINT = "If prompted, enter your password and press Return. Note that you won't see any characters appear as you type, this is normal.";
const GENERIC_ERROR_BODY = 'Click Retry. If it fails again, open Diagnostics.';
const TERMINAL_COMMAND_UNAVAILABLE = 'Could not copy the command. Use the optional command below or open Diagnostics.';
const OPTIONAL_COMMAND_COPIED = 'Copied.';
const OPTIONAL_COMMAND_FAILED = 'Copy failed. Select and copy the command manually.';
const HOMEBREW_RECOVERY_COMMAND = `sudo -v
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
brew --version`;
// Updates and verifies every installed Homebrew by absolute path (setup
// resolves /usr/local/bin before /opt/homebrew/bin, so heal that prefix
// first). `brew update` may need two runs on very old installs, and a brew
// too stale to advance falls back to `brew update-reset` (hard-resets the
// Homebrew git repos) — the documented recovery for that case. `brew config`
// is the real health probe: `brew --version` succeeds even on a Homebrew that
// predates the host macOS release.
const HOMEBREW_UPDATE_RECOVERY_COMMAND = `[ -x /usr/local/bin/brew ] && { /usr/local/bin/brew update || /usr/local/bin/brew update || /usr/local/bin/brew update-reset; }
[ -x /opt/homebrew/bin/brew ] && { /opt/homebrew/bin/brew update || /opt/homebrew/bin/brew update || /opt/homebrew/bin/brew update-reset; }
[ -x /usr/local/bin/brew ] && /usr/local/bin/brew config >/dev/null
[ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew config >/dev/null
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
brew --version`;
const DEFAULT_DOCKER_IMAGE_SPECS = [
  { name: 'redis', tag: '7-alpine', label: 'Redis Cache' },
  { name: 'mongo', tag: '7', label: 'MongoDB' },
  { name: 'nginx', tag: 'alpine', label: 'Nginx' },
  { name: 'harbor.example.invalid/portico/mcpo-control-plane-rust', tag: 'latest', label: 'MCP Control Plane' },
  { name: 'harbor.example.invalid/portico/mcp-orc-rust', tag: 'latest', label: 'MCP Runtime' },
  { name: 'harbor.example.invalid/portico/bifrost-bridge', tag: 'latest', label: 'LLM Gateway' },
  { name: 'harbor.example.invalid/portico/open-webui-patched', tag: 'latest', label: 'Open WebUI' },
  { name: 'harbor.example.invalid/portico/health-check', tag: 'latest', label: 'Health Check' },
  { name: 'harbor.example.invalid/portico/chat-state-api', tag: 'latest', label: 'Chat State API' },
  { name: 'harbor.example.invalid/portico/agent-vm', tag: 'latest', label: 'Agent VM' }
];

let state = null;
let _setupState = null;
let _callbacks = null;
let bootstrapPromise = null;
let authorizeReadinessPoll = null;
let autoAdvanceTimer = null;
let simulatedPrereqStateSnapshot = null;

function getRecoveryDefinition(code) {
  switch (code) {
    case 'homebrew_auth_dialog_cancelled':
      return {
        diagnosis: 'The in-app macOS authorization dialog closed before Homebrew could continue.',
        command: HOMEBREW_RECOVERY_COMMAND,
      };
    case 'homebrew_sudo_validation_failed':
      return {
        diagnosis: 'The in-app Homebrew authorization flow failed even though admin access may still work in Terminal.',
        command: HOMEBREW_RECOVERY_COMMAND,
      };
    case 'homebrew_admin_required':
      return {
        diagnosis: 'Homebrew needs a local macOS administrator account. Run the install in Terminal with an admin account, then retry setup.',
        command: HOMEBREW_RECOVERY_COMMAND,
      };
    case 'homebrew_osascript_probe_failed':
      return {
        diagnosis: 'Portico could not reopen the macOS authorization helper in this session. Use Terminal for the Homebrew install, then retry setup.',
        command: HOMEBREW_RECOVERY_COMMAND,
      };
    case 'homebrew_outdated':
      return {
        diagnosis: 'The Homebrew package manager on this Mac predates this version of macOS, so downloads fail until it is updated. Run the update in Terminal, then retry setup.',
        command: HOMEBREW_UPDATE_RECOVERY_COMMAND,
      };
    default:
      return null;
  }
}

function isOrbStackFailureCode(code) {
  return typeof code === 'string' && code.startsWith('orbstack_');
}

function ensureRecoveryCommandStopsOnFailure(command) {
  if (/^\s*set\s+-(?:[A-Za-z]*e[A-Za-z]*|o\s+errexit)\b/.test(command)) {
    return command;
  }
  return `set -e\n${command}`;
}

function normalizeRecoveryCommand(command) {
  if (typeof command !== 'string') {
    return null;
  }
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return null;
  }

  const commandWithFailureStop = ensureRecoveryCommandStopsOnFailure(trimmedCommand);
  return commandWithFailureStop;
}

function normalizeRecoveryPayload(recovery = null, code = null) {
  const mappedRecovery = getRecoveryDefinition(code);
  const explicitRecovery = recovery && typeof recovery === 'object' ? recovery : null;
  const resolvedRecovery = explicitRecovery || mappedRecovery;
  if (!resolvedRecovery) {
    return null;
  }

  return {
    title: resolvedRecovery.title || TERMINAL_RECOVERY_TITLE,
    diagnosis: resolvedRecovery.diagnosis || null,
    command: normalizeRecoveryCommand(resolvedRecovery.command),
    restartOnRetry: resolvedRecovery.restartOnRetry === true,
  };
}

function getVisibleErrorTreatment(error) {
  if (error?.code === 'phase1_download_stalled') {
    return {
      eyebrow: '',
      title: 'Download stalled',
      body: 'The setup download stopped receiving new bytes for 20 minutes. Check your network or VPN, then click Retry.',
      showPasswordGuidance: false,
      followup: '',
    };
  }

  if (error?.code === 'orbstack_launch_approval_timeout') {
    return {
      eyebrow: '',
      title: 'OrbStack is waiting for approval',
      body: 'Click Try Again, then click Open if macOS asks whether to open OrbStack. Setup will continue automatically.',
      showPasswordGuidance: false,
      followup: '',
    };
  }

  if (error?.code === 'orbstack_translocated_launch') {
    return {
      eyebrow: '',
      title: 'OrbStack must be fully quit',
      body: 'Quit OrbStack completely from its menu bar icon, then click Try Again. Setup will reopen it safely.',
      showPasswordGuidance: false,
      followup: '',
    };
  }

  if (isOrbStackFailureCode(error?.code)) {
    return {
      eyebrow: '',
      title: 'OrbStack setup needs attention',
      body: 'Click Try Again. If it still fails, open Diagnostics—no Terminal command is required.',
      showPasswordGuidance: false,
      followup: '',
    };
  }

  if (!error?.recoveryCommand) {
    return {
      eyebrow: '',
      title: 'Setup hit a problem',
      body: GENERIC_ERROR_BODY,
      showPasswordGuidance: false,
      followup: '',
    };
  }

  return {
    eyebrow: '',
    title: TERMINAL_RECOVERY_TITLE,
    body: TERMINAL_RECOVERY_BODY,
    showPasswordGuidance: true,
    followup: '',
  };
}

async function copyTextToClipboard(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Command is unavailable');
  }
  if (window.electronAPI?.copyToClipboard) {
    await window.electronAPI.copyToClipboard(text);
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('Clipboard is unavailable');
}

function buildErrorState({ message, code = null, details = [], phase = null, retryable = true, recovery = null }) {
  const resolvedRecovery = normalizeRecoveryPayload(recovery, code);
  return {
    message: resolvedRecovery?.diagnosis || message || 'Prerequisites failed',
    rawMessage: message || resolvedRecovery?.diagnosis || 'Prerequisites failed',
    code,
    details: Array.isArray(details) ? [...details] : [],
    recoveryTitle: resolvedRecovery?.title || null,
    recoveryCommand: resolvedRecovery?.command || null,
    recoveryRestartOnRetry: resolvedRecovery?.restartOnRetry === true,
    phase,
    retryable,
  };
}

function shouldSkipHomebrewAuthOnRetry(code) {
  return code === 'homebrew_auth_dialog_cancelled' ||
    code === 'homebrew_sudo_validation_failed' ||
    code === 'homebrew_admin_required' ||
    code === 'homebrew_osascript_probe_failed';
}

function isBasicMode() {
  return _setupState?.onboardingMode === 'basic';
}

function getPhaseLabels() {
  return {
    1: 'Downloading update payload...',
    2: 'Installing core dependencies...',
    3: 'Preparing workspace...',
    4: isBasicMode() ? 'Downloading core runtime containers...' : 'Setting up host mode...'
  };
}

function getPrerequisitesRunOptions() {
  return {
    onboardingMode: _setupState?.onboardingMode || 'power'
  };
}

function resetState() {
  simulatedPrereqStateSnapshot = null;
  state = {
    isComplete: false,
    isRunning: false,
    currentPhase: 0,
    activeStep: null,
    phases: {
      1: { status: 'pending', startedAt: null, completedAt: null },
      2: { status: 'pending', startedAt: null, completedAt: null },
      3: { status: 'pending', startedAt: null, completedAt: null },
      4: { status: 'pending', startedAt: null, completedAt: null }
    },
    dockerPull: {
      isActive: false,
      totalImages: 0,
      images: new Map(),
      completedCount: 0,
      currentLabel: null
    },
    logs: [],
    phaseLogs: {
      1: [],
      2: [],
      3: [],
      4: []
    },
    hostModeEnabled: null,
    hostModeWarning: false,
    hostModeWarningMessage: null,
    warningMessage: null,
    blockingReady: false,
    backgroundReady: false,
    authorizeReadiness: {
      ready: false,
      waiting: false,
      progressPercent: 0,
      missingImages: []
    },
    phase1Progress: {
      step: 'idle',
      activity: 'Preparing your setup...',
      percent: 0,
      bytesDownloaded: 0,
      totalBytes: null,
      downloadComplete: false
    },
    continueAvailable: false,
    continueTitle: '',
    continueMessage: '',
    backgroundInstallRunning: false,
    fullInstallComplete: false,
    error: null,
    autoAdvanceTriggered: false,
    manualVisit: false,
    suppressAutoAdvance: false
  };

  seedDockerImages();
}

function cloneMap(map) {
  return new Map(map instanceof Map ? map : []);
}

function clonePhaseLogs(phaseLogs = {}) {
  return Object.fromEntries(
    Object.entries(phaseLogs).map(([phase, entries]) => [
      phase,
      Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
    ])
  );
}

function clonePrereqStateSnapshot(source = state) {
  if (!source) return null;

  return {
    ...source,
    phases: Object.fromEntries(
      Object.entries(source.phases || {}).map(([phase, phaseState]) => [
        phase,
        { ...phaseState }
      ])
    ),
    dockerPull: {
      ...(source.dockerPull || {}),
      images: cloneMap(source.dockerPull?.images)
    },
    logs: Array.isArray(source.logs) ? source.logs.map((entry) => ({ ...entry })) : [],
    phaseLogs: clonePhaseLogs(source.phaseLogs),
    authorizeReadiness: {
      ...(source.authorizeReadiness || {}),
      missingImages: Array.isArray(source.authorizeReadiness?.missingImages)
        ? source.authorizeReadiness.missingImages.map((image) => ({ ...image }))
        : []
    },
    phase1Progress: { ...(source.phase1Progress || {}) },
    error: source.error ? {
      ...source.error,
      details: Array.isArray(source.error.details) ? [...source.error.details] : []
    } : null
  };
}

function stopAuthorizeReadinessPolling() {
  if (authorizeReadinessPoll) {
    clearInterval(authorizeReadinessPoll);
    authorizeReadinessPoll = null;
  }
}

function clearAutoAdvanceTimer() {
  if (autoAdvanceTimer) {
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }
}

function waitForPrereqUiDelay(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isPrerequisitesStageActive() {
  return Boolean(_setupState?.currentStage === 'prerequisites');
}

function syncContinueStateForReadyPrerequisites() {
  if (!state?.authorizeReadiness?.ready) {
    return;
  }

  if (state.fullInstallComplete) {
    setContinueState(true, state.hostModeWarning
      ? {
          title: 'Setup is ready to continue.',
          message: 'The main setup is complete. Host mode had issues, but you can continue and enable it later.'
        }
      : {
          title: 'Everything is ready.',
          message: 'The full install finished successfully. Continue whenever you are ready.'
        });
    return;
  }

  setContinueState(true);
}

function maybeAutoAdvanceAfterAuthorizeReady() {
  if (!state || state.autoAdvanceTriggered || state.error || !isPrerequisitesStageActive()) {
    return;
  }

  if (!state.authorizeReadiness.ready) {
    return;
  }

  if (state.suppressAutoAdvance) {
    stopAuthorizeReadinessPolling();
    syncContinueStateForReadyPrerequisites();
    render();
    return;
  }

  clearAutoAdvanceTimer();
  stopAuthorizeReadinessPolling();
  autoAdvanceTimer = setTimeout(() => {
    autoAdvanceTimer = null;

    if (
      !state ||
      state.autoAdvanceTriggered ||
      state.suppressAutoAdvance ||
      state.error ||
      !state.authorizeReadiness.ready ||
      !isPrerequisitesStageActive()
    ) {
      return;
    }

    state.autoAdvanceTriggered = true;
    if (_callbacks?.advanceAfterPrerequisites) {
      _callbacks.advanceAfterPrerequisites();
    } else if (_callbacks?.showStage) {
      _callbacks.showStage(isBasicMode() ? 'configuration' : 'server-selection');
    }
  }, PREREQ_FINAL_AUTO_ADVANCE_DELAY_MS);
}

function markAuthorizeReady(options = {}) {
  if (!state) {
    return;
  }

  const requestedPercent = Number(options.progressPercent);
  const currentPercent = Number(state.authorizeReadiness?.progressPercent) || 0;
  const nextPercent = Number.isFinite(requestedPercent)
    ? Math.max(currentPercent, Math.max(0, Math.min(100, requestedPercent)))
    : Math.max(currentPercent, 100);

  state.authorizeReadiness = {
    ready: true,
    waiting: false,
    progressPercent: nextPercent,
    missingImages: []
  };
}

async function refreshAuthorizeReadiness() {
  if (!window.electronAPI?.prerequisitesCheckAuthorizeReadiness || !state || state.error) {
    return;
  }

  try {
    const readiness = await window.electronAPI.prerequisitesCheckAuthorizeReadiness();
    if (!readiness?.success) {
      return;
    }

    state.authorizeReadiness = {
      ready: Boolean(readiness.ready),
      waiting: Boolean(readiness.waiting),
      progressPercent: Math.max(0, Math.min(100, Number(readiness.progressPercent) || 0)),
      missingImages: Array.isArray(readiness.missingImages) ? readiness.missingImages : []
    };
    render();
    maybeAutoAdvanceAfterAuthorizeReady();
  } catch (error) {
    console.warn('[screen-prerequisites] Failed to refresh authorize readiness:', error.message);
  }
}

function ensureAuthorizeReadinessPolling() {
  if (authorizeReadinessPoll || state.autoAdvanceTriggered || state.error) {
    return;
  }

  void refreshAuthorizeReadiness();
  authorizeReadinessPoll = window.setInterval(() => {
    void refreshAuthorizeReadiness();
  }, 1200);
}

function formatPercentText(value) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return `${percent}%`;
}

function setContinueState(enabled, options = {}) {
  state.continueAvailable = Boolean(enabled);
  state.blockingReady = Boolean(enabled);
  state.continueTitle = options.title || 'Core setup is complete.';
  state.continueMessage = options.message || 'You can continue while the remaining downloads finish in the background.';
}

function normalizeDockerImageSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;

  const name = typeof spec.name === 'string' ? spec.name.trim() : '';
  const tag = typeof spec.tag === 'string' && spec.tag.trim() ? spec.tag.trim() : 'latest';
  const image = typeof spec.image === 'string' && spec.image.trim()
    ? spec.image.trim()
    : (name ? `${name}:${tag}` : '');

  if (!image) return null;

  return {
    image,
    label: typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : image
  };
}

function seedDockerImages(imageSpecs = DEFAULT_DOCKER_IMAGE_SPECS) {
  if (!state?.dockerPull || !Array.isArray(imageSpecs)) return false;

  const seeded = new Map();
  for (const spec of imageSpecs) {
    const normalized = normalizeDockerImageSpec(spec);
    if (!normalized) continue;
    seeded.set(normalized.image, {
      label: normalized.label,
      status: 'waiting',
      percent: 0,
      eta: '--'
    });
  }

  if (seeded.size === 0) return false;

  state.dockerPull.images = seeded;
  state.dockerPull.totalImages = seeded.size;
  state.dockerPull.completedCount = 0;
  state.dockerPull.currentLabel = null;
  return true;
}

async function hydrateDockerImagePlan() {
  if (!window.electronAPI?.prerequisitesGetStatus) return;

  try {
    const status = await window.electronAPI.prerequisitesGetStatus();
    if (!status?.success || !Array.isArray(status.dockerImages) || status.dockerImages.length === 0) return;
    seedDockerImages(status.dockerImages);
  } catch (error) {
    console.warn('[screen-prerequisites] Failed to hydrate Docker image plan:', error.message);
  }
}

function hydrateStatusSnapshot(status) {
  if (!status || typeof status !== 'object' || !state) return;

  state.isRunning = Boolean(status.running);
  state.isComplete = Boolean(status.currentSequence === 'complete');
  state.currentPhase = Number(status.activePhase) || state.currentPhase || 0;
  state.activeStep = typeof status.activeStep === 'string' && status.activeStep
    ? status.activeStep
    : null;
  state.blockingReady = Boolean(status.blockingReady);
  state.backgroundReady = Boolean(status.backgroundReady);
  state.backgroundInstallRunning = Boolean(status.running) && !status.backgroundReady;
  state.fullInstallComplete = Boolean(status.currentSequence === 'complete');
  state.error = status.lastError && !status.running
    ? buildErrorState({
        message: status.lastError,
        code: status.lastFailureCode || null,
        details: status.lastFailureDetails || [],
        recovery: status.lastFailureRecovery || null,
        phase: status.failedPhase || state.currentPhase || 1,
        retryable: true,
      })
    : null;

  if (Array.isArray(status.recentLogs) && status.recentLogs.length > 0) {
    state.logs = status.recentLogs.slice(-MAX_LOG_LINES).map((entry) => ({
      text: entry.text,
      type: entry.type || 'info',
      timestamp: entry.timestamp || Date.now()
    }));
  }

  if (status.phaseResults && typeof status.phaseResults === 'object') {
    if (!isBasicMode() && status.phaseResults.phase4?.success === false) {
      setHostModeWarning(HOST_MODE_WARNING_MESSAGE);
    }

    const resultsByPhase = {
      1: status.phaseResults.phase1,
      2: status.phaseResults.phase2,
      3: status.phaseResults.phase3,
      4: status.phaseResults.phase4
    };

    Object.entries(resultsByPhase).forEach(([phaseNum, result]) => {
      if (!state.phases[phaseNum]) return;
      if (result?.success === true) {
        state.phases[phaseNum].status = phaseNum === String(HOST_MODE_PHASE) && state.hostModeWarning ? 'warning' : 'complete';
      } else if (result?.success === false) {
        state.phases[phaseNum].status = phaseNum === String(HOST_MODE_PHASE) ? 'warning' : 'failed';
      }
    });
  }

  if (status.phase1Progress && typeof status.phase1Progress === 'object') {
    state.phase1Progress = {
      ...state.phase1Progress,
      step: status.phase1Progress.step || state.phase1Progress.step,
      activity: status.phase1Progress.activity || state.phase1Progress.activity,
      percent: Math.max(0, Math.min(100, Number(status.phase1Progress.percent) || 0)),
      bytesDownloaded: Math.max(0, Number(status.phase1Progress.bytesDownloaded) || 0),
      totalBytes: Number(status.phase1Progress.totalBytes) > 0
        ? Number(status.phase1Progress.totalBytes)
        : null,
      downloadComplete: Boolean(status.phase1Progress.downloadComplete)
    };
  }

  if (state.backgroundReady || state.fullInstallComplete || state.isComplete || status.currentSequence === 'complete') {
    markAuthorizeReady({ progressPercent: 100 });
  }

  if (status.dockerPull && Array.isArray(status.dockerPull.images)) {
    state.dockerPull.isActive = Boolean(status.dockerPull.running);
    state.dockerPull.totalImages = status.dockerPull.totalImages || status.dockerPull.images.length;
    state.dockerPull.completedCount = status.dockerPull.completedCount || 0;
    state.dockerPull.currentLabel = status.dockerPull.currentLabel || null;
    state.dockerPull.images.clear();
    status.dockerPull.images.forEach((image) => {
      if (!image?.image) return;
      state.dockerPull.images.set(image.image, {
        label: image.label || image.image,
        status: image.status || 'waiting',
        percent: image.percent || 0,
        eta: image.eta || null
      });
    });
  }

  if (state.authorizeReadiness.ready) {
    stopAuthorizeReadinessPolling();
  } else if (status.blockingReady) {
    ensureAuthorizeReadinessPolling();
  } else {
    state.continueAvailable = false;
  }
}

async function loadPrerequisitesScreen(setupState, callbacks = {}, options = {}) {
  console.log('[screen-prerequisites] Loading prerequisites screen');

  _setupState = setupState;
  _callbacks = callbacks;

  cleanupListeners();

  const shouldResume = Boolean(options.resume && state);
  if (!shouldResume) {
    resetState();
  }
  state.autoAdvanceTriggered = false;
  state.manualVisit = options.manualVisit === true;
  state.suppressAutoAdvance = options.suppressAutoAdvance === true;
  clearAutoAdvanceTimer();

  bindPrereqContinueActions();
  render();
  registerEventListeners();

  if (options.deferStart) {
    return;
  }

  await bootstrapPrerequisitesSession({ shouldResume });
}

async function bootstrapPrerequisitesSession({ shouldResume = false } = {}) {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    await hydrateDockerImagePlan();

    addLogEntry(shouldResume ? 'Refreshing prerequisites status...' : 'Checking prerequisites status...', 'info');
    await waitForPrereqUiDelay(PREREQ_STAGE_TRANSITION_DELAY_MS);

    try {
      const status = await window.electronAPI.prerequisitesGetDetailedStatus();
      if (status?.success) {
        hydrateStatusSnapshot(status);
        render();
        await waitForPrereqUiDelay(PREREQ_STAGE_TRANSITION_DELAY_MS);
        maybeAutoAdvanceAfterAuthorizeReady();
        if (status.currentSequence === 'failed') {
          addLogEntry('A previous prerequisites attempt needs attention before setup can continue.', 'warning');
          return;
        }
      }

      const result = await window.electronAPI.prerequisitesResumeInteractive(getPrerequisitesRunOptions());
      if (!result?.success) {
        addLogEntry(`Failed to start prerequisites: ${result?.error || 'Unknown error'}`, 'error');
        return;
      }

      if (result.status) {
        hydrateStatusSnapshot(result.status);
        render();
        await waitForPrereqUiDelay(PREREQ_STAGE_TRANSITION_DELAY_MS);
        maybeAutoAdvanceAfterAuthorizeReady();
      }

      if (result.started) {
        addLogEntry('Installing core prerequisites...', 'info');
      }
    } catch (error) {
      console.error('[screen-prerequisites] Error starting prerequisites:', error);
      addLogEntry(`Error starting prerequisites: ${error.message}`, 'error');
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

function registerEventListeners() {
  window.electronAPI.onPrerequisitesStart(handleStart);
  window.electronAPI.onPrerequisitesPhaseStart(handlePhaseStart);
  window.electronAPI.onPrerequisitesPhaseComplete(handlePhaseComplete);
  window.electronAPI.onPrerequisitesDockerPullStart(handleDockerPullStart);
  window.electronAPI.onPrerequisitesDockerPull(handleDockerPull);
  window.electronAPI.onPrerequisitesDockerPullComplete(handleDockerPullComplete);
  window.electronAPI.onPrerequisitesDockerPullDeferred(handleDockerPullDeferred);
  window.electronAPI.onPrerequisitesStepUpdate(handleStepUpdate);
  window.electronAPI.onPrerequisitesProgress(handleProgress);
  window.electronAPI.onPrerequisitesLog(handleLog);
  window.electronAPI.onPrerequisitesWarning(handleWarning);
  window.electronAPI.onPrerequisitesBlockingReady(handleBlockingReady);
  window.electronAPI.onPrerequisitesRetry(handleRetry);
  window.electronAPI.onPrerequisitesHostMode(handleHostMode);
  window.electronAPI.onPrerequisitesComplete(handleComplete);
  window.electronAPI.onPrerequisitesError(handleError);
}

function cleanupListeners() {
  stopAuthorizeReadinessPolling();
  clearAutoAdvanceTimer();
  if (window.electronAPI?.removePrerequisitesListeners) {
    window.electronAPI.removePrerequisitesListeners();
  }
}

function handleStart(data) {
  if (state.isComplete) return;

  state.isComplete = false;
  state.isRunning = true;
  state.activeStep = null;
  state.continueAvailable = false;
  state.blockingReady = false;
  state.backgroundReady = false;
  state.hostModeWarning = false;
  state.hostModeWarningMessage = null;
  state.warningMessage = null;
  addLogEntry(`Starting ${data.totalPhases} phases...`, 'info');
  render();
}

function bindPrereqContinueActions() {
  const continueBtn = document.getElementById('prerequisites-continue-btn');
  if (continueBtn) {
    continueBtn.onclick = () => {
      if (_callbacks?.advanceAfterPrerequisites) {
        _callbacks.advanceAfterPrerequisites();
      } else if (_callbacks?.showStage) {
        _callbacks.showStage('server-selection');
      }
    };
  }
}

function handlePhaseStart(data) {
  if (state.isComplete) return;

  const { phase } = data;
  if (!state.phases[phase]) return;

  state.currentPhase = phase;
  state.activeStep = null;
  state.phases[phase].status = 'active';
  state.phases[phase].startedAt = Date.now();
  state.error = null;

  const label = data.label || getPhaseLabels()[phase] || 'Working...';
  addLogEntry(`Phase ${phase}: ${label}`, 'info', phase);
  render();
}

function handlePhaseComplete(data) {
  if (state.isComplete) return;

  const { phase } = data;
  const phaseState = state.phases[phase];
  if (!phaseState) return;

  state.activeStep = null;

  if (phaseState.status === 'failed') {
    // Preserve failure state.
  } else if (phase === HOST_MODE_PHASE && state.hostModeWarning) {
    phaseState.status = 'warning';
  } else {
    phaseState.status = 'complete';
  }
  phaseState.completedAt = Date.now();

  let logType = 'success';
  let logText = `Phase ${phase} complete`;
  if (phaseState.status === 'failed') {
    logType = 'error';
    logText = `Phase ${phase} failed`;
  } else if (phaseState.status === 'warning') {
    logType = 'warning';
    logText = `Phase ${phase} complete (optional)`;
  }

  addLogEntry(logText, logType, phase);
  render();
}

function handleDockerPullStart(data) {
  if (state.isComplete) return;

  const { totalImages, images } = data;
  state.dockerPull.isActive = true;
  state.dockerPull.totalImages = totalImages;
  state.dockerPull.completedCount = 0;
  state.dockerPull.currentLabel = null;
  state.dockerPull.images.clear();

  for (const imageSpec of images) {
    const normalized = normalizeDockerImageSpec(imageSpec);
    if (!normalized) continue;
    state.dockerPull.images.set(normalized.image, {
      label: normalized.label,
      status: 'waiting',
      percent: 0,
      eta: null
    });
  }

  addLogEntry(`Pulling ${totalImages} Docker images...`, 'info', 3);
  render();
}

function handleDockerPull(data) {
  if (state.isComplete) return;

  const { image, label, status, percent, eta } = data;
  const statusMap = {
    starting: 'downloading',
    pulling: 'downloading',
    extracting: 'extracting',
    retrying: 'downloading',
    complete: 'complete',
    failed: 'failed',
    deferred: 'deferred',
    waiting: 'waiting'
  };
  const normalizedStatus = statusMap[status] || status || 'downloading';

  state.dockerPull.images.set(image, {
    label: label || image,
    status: normalizedStatus,
    percent: percent || 0,
    eta: eta || null
  });

  if (normalizedStatus === 'downloading' || normalizedStatus === 'extracting') {
    state.dockerPull.currentLabel = label || image;
  }

  let completed = 0;
  for (const [, imageState] of state.dockerPull.images) {
    if (imageState.status === 'complete' || imageState.status === 'deferred') {
      completed += 1;
    }
  }
  state.dockerPull.completedCount = completed;

  render();
}

function handleDockerPullDeferred(data) {
  if (state.isComplete) return;

  const { deferredImages, message } = data;
  if (!Array.isArray(deferredImages) || deferredImages.length === 0) return;

  for (const image of deferredImages) {
    const existing = state.dockerPull.images.get(image);
    if (!existing) continue;
    state.dockerPull.images.set(image, {
      ...existing,
      status: 'deferred',
      percent: 100,
      eta: null
    });
  }

  addLogEntry(message || `${deferredImages.length} image(s) will be built locally`, 'info', 3);
  render();
}

function handleDockerPullComplete(data) {
  if (state.isComplete) return;

  const { success, pulled, failed } = data;
  state.dockerPull.currentLabel = null;

  if (success) {
    addLogEntry(`Docker images pulled successfully (${pulled.length} images)`, 'success', 3);
  } else if (failed && failed.length > 0) {
    addLogEntry(`Some Docker images failed to pull: ${failed.join(', ')}`, 'error', 3);
  }

  if (Array.isArray(pulled)) {
    pulled.forEach((image) => {
      const existing = state.dockerPull.images.get(image);
      state.dockerPull.images.set(image, {
        label: existing?.label || image,
        status: 'complete',
        percent: 100,
        eta: null
      });
    });
  }

  if (Array.isArray(failed)) {
    failed.forEach((image) => {
      const existing = state.dockerPull.images.get(image);
      state.dockerPull.images.set(image, {
        label: existing?.label || image,
        status: 'failed',
        percent: existing?.percent || 0,
        eta: null
      });
    });
  }

  state.dockerPull.completedCount = state.dockerPull.totalImages;
  render();
}

function handleStepUpdate(data) {
  if (state.isComplete) return;

  const { step, status } = data;
  const phaseNum = data.phase || state.currentPhase;
  const statusText = {
    start: 'started',
    complete: 'complete',
    skipped: 'skipped',
    failed: 'failed'
  };

  if (status === 'failed' && phaseNum) {
    if (phaseNum === HOST_MODE_PHASE) {
      setHostModeWarning(HOST_MODE_WARNING_MESSAGE);
    } else if (state.phases[phaseNum]) {
      state.phases[phaseNum].status = 'failed';
    }
  }

  if (status === 'start') {
    state.activeStep = step || null;
  } else if (state.activeStep === step) {
    state.activeStep = null;
  }

  addLogEntry(
    `Step '${step}' ${statusText[status] || status}`,
    status === 'failed' ? 'error' : 'info',
    phaseNum || null
  );
  render();
}

function handleProgress(data) {
  if (state.isComplete) return;
  const metric = data?.metric;
  const value = typeof data?.value === 'string' ? data.value : String(data?.value ?? '');

  switch (metric) {
    case 'phase1_step':
      state.phase1Progress.step = value || state.phase1Progress.step;
      break;
    case 'phase1_activity':
      state.phase1Progress.activity = value || state.phase1Progress.activity;
      break;
    case 'download_percent':
      state.phase1Progress.percent = Math.max(0, Math.min(100, Number(value) || 0));
      break;
    case 'download_bytes':
      state.phase1Progress.bytesDownloaded = Math.max(0, Number(value) || 0);
      break;
    case 'download_total_bytes':
      state.phase1Progress.totalBytes = Number(value) > 0 ? Number(value) : null;
      break;
    case 'download_complete':
      state.phase1Progress.downloadComplete = value === 'true' || value === '1';
      if (state.phase1Progress.downloadComplete) {
        state.phase1Progress.percent = 100;
      }
      break;
    default:
      break;
  }

  render();
}

function handleLog(data) {
  if (state.isComplete) return;
  addLogEntry(data.text, data.type || 'info', data.phase || null);
}

function handleWarning(data) {
  if (state.isComplete) return;

  const message = data?.message || 'A prerequisite step needs your attention.';
  state.warningMessage = message;
  addLogEntry(message, 'warning', state.currentPhase || null);
  render();
}

function handleBlockingReady() {
  if (!state) return;

  state.isRunning = true;
  state.error = null;
  state.activeStep = null;
  state.warningMessage = null;
  state.phases[1].status = state.phases[1].status === 'pending' ? 'complete' : state.phases[1].status;
  state.phases[2].status = 'complete';
  ensureAuthorizeReadinessPolling();

  if (_setupState?.completedSteps) {
    _setupState.completedSteps.prerequisites = true;
    _setupState.completedSteps.prerequisitesWarning = false;
  }
  if (_callbacks?.updateProgressTracker) {
    _callbacks.updateProgressTracker();
  }

  addLogEntry('Core prerequisites are installed. Finishing the minimum runtime downloads now.', 'success');
  render();
}

function handleRetry(data) {
  if (state.isComplete) return;

  const { phase, attempt, maxAttempts } = data;
  state.error = null;

  if (state.phases[phase]) {
    state.phases[phase].status = 'active';
  }
  state.activeStep = null;

  if (phase === 3) {
    state.dockerPull.images.clear();
    state.dockerPull.completedCount = 0;
    state.dockerPull.isActive = false;
    seedDockerImages();
  }

  if (phase === HOST_MODE_PHASE) {
    state.hostModeWarning = false;
    state.hostModeWarningMessage = null;
  }

  addLogEntry(`Retrying phase ${phase} (attempt ${attempt}/${maxAttempts})...`, 'info', phase);
  render();
}

function handleHostMode(data) {
  if (state.isComplete) return;

  state.hostModeEnabled = data.enabled;
  if (data.enabled === false && !isBasicMode()) {
    setHostModeWarning(HOST_MODE_WARNING_MESSAGE);
  }

  addLogEntry(
    isBasicMode()
      ? 'Host mode skipped for basic setup'
      : `Host mode: ${data.enabled ? 'enabled' : 'disabled'}`,
    'info',
    HOST_MODE_PHASE
  );
}

function handleComplete(data) {
  if (state.isComplete) return;

  const { success, failedPhase, error, results } = data;

  if (success) {
    state.isComplete = true;
    state.isRunning = false;
    state.backgroundInstallRunning = false;
    state.backgroundReady = true;
    state.fullInstallComplete = true;
    state.activeStep = null;
    state.warningMessage = null;
    markAuthorizeReady({ progressPercent: 100 });

    const hostModeFailed = !isBasicMode() && (
      state.hostModeEnabled === false ||
      (results?.phase4 && results.phase4.success === false)
    );

    if (hostModeFailed) {
      setHostModeWarning(HOST_MODE_WARNING_MESSAGE);
      addLogEntry('Host mode setup failed (optional). You can continue without it.', 'warning', HOST_MODE_PHASE);
    }

    for (const phaseNum of [1, 2, 3, 4]) {
      state.phases[phaseNum].status = phaseNum === HOST_MODE_PHASE && state.hostModeWarning
        ? 'warning'
        : 'complete';
    }
    state.currentPhase = 5;

    setContinueState(true, hostModeFailed
      ? {
          title: 'Setup is ready to continue.',
          message: 'The main setup is complete. Host mode had issues, but you can continue and enable it later.'
        }
      : {
          title: 'Everything is ready.',
          message: 'The full install finished successfully. Continue whenever you are ready.'
        });

    addLogEntry('Background installation finished.', 'success');

    if (_setupState && state.hostModeEnabled !== null) {
      _setupState.hostModeSupported = state.hostModeEnabled;
    }

    if (_setupState?.completedSteps) {
      _setupState.completedSteps.prerequisites = true;
      _setupState.completedSteps.prerequisitesWarning = state.hostModeWarning;
    }
    if (_callbacks?.updateProgressTracker) {
      _callbacks.updateProgressTracker();
    }

    render();
    maybeAutoAdvanceAfterAuthorizeReady();
    stopAuthorizeReadinessPolling();
    return;
  }

  state.isComplete = false;
  state.isRunning = false;
  state.backgroundInstallRunning = false;
  state.activeStep = null;
  const phase = failedPhase || state.currentPhase || 1;
  state.error = buildErrorState({
    message: error || 'Prerequisites failed',
    code: data.code || null,
    details: data.details || [],
    recovery: data.recovery || null,
    phase,
    retryable: true,
  });

  if (phase) {
    state.phases[phase].status = 'failed';
  }

  if (results) {
    const phaseResults = {
      1: results.phase1,
      2: results.phase2,
      3: results.phase3,
      4: results.phase4
    };
    Object.entries(phaseResults).forEach(([phaseNum, result]) => {
      if (result && result.success === false && state.phases[phaseNum]) {
        state.phases[phaseNum].status = 'failed';
      }
    });
  }

  addLogEntry(`Prerequisites failed: ${error || 'Unknown error'}`, 'error', phase);
  render();
}

function handleError(data) {
  if (state.isComplete) return;

  const { error, phase, code, details, recovery } = data;
  const phaseNum = phase || state.currentPhase;

  if (phaseNum === HOST_MODE_PHASE) {
    setHostModeWarning(HOST_MODE_WARNING_MESSAGE);
    addLogEntry(`Host mode warning: ${error}`, 'warning', phaseNum);
    render();
    return;
  }

  state.error = buildErrorState({
    message: error,
    code: code || null,
    details: details || [],
    recovery: recovery || null,
    phase: phaseNum,
    retryable: true,
  });
  state.activeStep = null;
  stopAuthorizeReadinessPolling();
  if (phaseNum && state.phases[phaseNum]) {
    state.phases[phaseNum].status = 'failed';
  }

  addLogEntry(`Error: ${error}`, 'error', phaseNum);
  render();
}

function buildSimulatedDockerRecovery() {
  return {
    title: TERMINAL_RECOVERY_TITLE,
    diagnosis: 'Docker image downloads stalled in the app. Pull the required images in Terminal, then return here and click Retry.',
    command: 'docker pull "nginx:alpine" && \\\necho "Done - click Retry in Portico"',
    restartOnRetry: true,
  };
}

function buildSimulatedPrereqPayload(errorState) {
  switch (errorState) {
    case 'generic':
      return {
        method: 'handleError',
        payload: {
          error: 'Setup could not finish this step.',
          phase: 2,
        },
      };
    case 'phase1_download_stalled':
      return {
        method: 'handleComplete',
        payload: {
          success: false,
          failedPhase: 1,
          error: 'The setup download stopped receiving new bytes for 20 minutes. Check your network or VPN, then click Retry.',
          code: 'phase1_download_stalled',
          details: ['No new bytes were downloaded for 20 minutes.'],
          results: {
            phase1: { success: false },
          },
        },
      };
    case 'docker_pull_recovery_required':
      return {
        method: 'handleComplete',
        payload: {
          success: false,
          failedPhase: 3,
          error: 'Docker image downloads stalled',
          code: 'docker_pull_recovery_required',
          recovery: buildSimulatedDockerRecovery(),
          results: {
            phase3: { success: false },
          },
        },
      };
    case 'homebrew_auth_dialog_cancelled':
    case 'homebrew_sudo_validation_failed':
    case 'homebrew_admin_required':
    case 'homebrew_osascript_probe_failed':
      return {
        method: 'handleComplete',
        payload: {
          success: false,
          failedPhase: 2,
          error: 'Administrator authorization failed',
          code: errorState,
          details: [`Simulated prerequisite failure: ${errorState}`],
          results: {
            phase2: { success: false },
          },
        },
      };
    case 'homebrew_outdated':
      return {
        method: 'handleComplete',
        payload: {
          success: false,
          failedPhase: 2,
          error: 'Homebrew is too old for this version of macOS',
          code: 'homebrew_outdated',
          details: ['Simulated prerequisite failure: homebrew_outdated'],
          results: {
            phase2: { success: false },
          },
        },
      };
    case 'orbstack_stale_artifact_conflict':
    case 'orbstack_cask_xattr_conflict':
    case 'orbstack_manual_recovery_required':
    case 'orbstack_translocated_launch':
      return {
        method: 'handleComplete',
        payload: {
          success: false,
          failedPhase: 3,
          error: 'OrbStack recovery is required',
          code: errorState,
          details: [`Simulated prerequisite failure: ${errorState}`],
          results: {
            phase3: { success: false },
          },
        },
      };
    default:
      throw new Error(`Unknown prerequisite error state: ${errorState}`);
  }
}

function simulatePrerequisitesErrorState(errorState) {
  if (!state) {
    resetState();
  }

  if (!simulatedPrereqStateSnapshot) {
    simulatedPrereqStateSnapshot = clonePrereqStateSnapshot(state);
  } else {
    state = clonePrereqStateSnapshot(simulatedPrereqStateSnapshot);
  }

  const simulation = buildSimulatedPrereqPayload(errorState);
  if (simulation.method === 'handleError') {
    handleError(simulation.payload);
  } else {
    handleComplete(simulation.payload);
  }
  addLogEntry(`Simulated prerequisite error state: ${errorState}`, 'warning', state.error?.phase || state.currentPhase || null);
  render();
  return { success: true, errorState };
}

async function clearSimulatedPrerequisitesErrorState() {
  if (typeof window !== 'undefined' && window.electronAPI?.prerequisitesGetDetailedStatus) {
    try {
      const status = await window.electronAPI.prerequisitesGetDetailedStatus();
      if (status?.success) {
        hydrateStatusSnapshot(status);
        simulatedPrereqStateSnapshot = null;
        render();
        return { success: true, restoredFrom: 'service' };
      }
    } catch (_error) {
      // Fall back to the local renderer snapshot below.
    }
  }

  if (simulatedPrereqStateSnapshot) {
    state = clonePrereqStateSnapshot(simulatedPrereqStateSnapshot);
    simulatedPrereqStateSnapshot = null;
    render();
    return { success: true, restoredFrom: 'snapshot' };
  }

  if (state) {
    state.error = null;
    render();
  }
  return { success: true, restoredFrom: 'none' };
}

function calculateOverallProgress() {
  if (state.fullInstallComplete || state.backgroundReady || state.isComplete) {
    return 100;
  }

  const phase1Complete = state.phases[1].status === 'complete' || state.phase1Progress.downloadComplete;
  if (!phase1Complete) {
    return Math.round((Math.max(0, Math.min(100, state.phase1Progress.percent || 0)) / 100) * 34);
  }

  const phase2Complete = state.phases[2].status === 'complete';
  if (!phase2Complete) {
    return 44;
  }

  if (state.dockerPull.isActive || state.blockingReady || state.phases[4].status === 'active') {
    const authorizeProgress = Math.max(0, Math.min(100, Number(state.authorizeReadiness.progressPercent) || 0));
    return Math.round(64 + (authorizeProgress / 100) * 36);
  }

  if (state.phases[3].status === 'active' || state.phases[3].status === 'complete') {
    return 64;
  }

  return 58;
}

function calculateDockerPullPercent() {
  const totalImages = state?.dockerPull?.images?.size || 0;
  if (totalImages === 0) return 0;

  let totalPercent = 0;
  let allDone = true;
  for (const [, imgData] of state.dockerPull.images) {
    const status = imgData.status || 'waiting';
    if (status === 'complete' || status === 'deferred') {
      totalPercent += 100;
      continue;
    }
    allDone = false;
    const percent = Number(imgData.percent) || 0;
    totalPercent += Math.max(0, Math.min(99, percent));
  }

  if (allDone) return 100;
  return Math.min(99, Math.floor(totalPercent / totalImages));
}

function getDockerPullSummary() {
  const total = state?.dockerPull?.totalImages || state?.dockerPull?.images?.size || 0;
  if (total === 0) {
    return {
      ready: 0,
      total: 0,
      percent: 0,
      statusText: 'Waiting for image downloads...',
      detailText: 'We will pull everything needed during workspace setup.'
    };
  }

  let completed = 0;
  let deferred = 0;
  let failed = 0;
  for (const [, imageState] of state.dockerPull.images) {
    switch (imageState.status) {
      case 'complete':
        completed += 1;
        break;
      case 'deferred':
        deferred += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      default:
        break;
    }
  }

  const ready = completed + deferred;
  const percent = calculateDockerPullPercent();

  if (failed > 0) {
    return {
      ready,
      total,
      percent,
      statusText: 'Downloads need attention',
      detailText: `${failed} ${failed === 1 ? 'image failed' : 'images failed'} while the remaining downloads were being prepared.`
    };
  }

  if (ready >= total) {
    return {
      ready,
      total,
      percent: 100,
      statusText: 'All downloads are ready',
      detailText: 'Everything needed for startup has been downloaded.'
    };
  }

  const currentLabel = state.dockerPull.currentLabel;
  return {
    ready,
    total,
    percent,
    statusText: 'Finishing remaining downloads...',
    detailText: currentLabel
      ? `Currently downloading ${currentLabel}.`
      : `Background downloads are still in progress. ${ready} of ${total} are ready.`
  };
}

function getCurrentStepSummary() {
  const phaseLabels = getPhaseLabels();

  if (state.error) {
    const failedLabel = phaseLabels[state.error.phase] || 'a setup step';
    return `Needs attention: ${failedLabel}`;
  }

  if (state.fullInstallComplete || state.backgroundReady || state.isComplete) {
    return '';
  }

  const phase1Complete = state.phases[1].status === 'complete' || state.phase1Progress.downloadComplete;
  if (!phase1Complete) {
    if (state.phase1Progress.step === 'download') {
      return state.phase1Progress.activity || 'Downloading update payload...';
    }
    return state.phase1Progress.activity || 'Preparing your setup...';
  }

  if (state.phases[2].status === 'active') {
    return phaseLabels[2];
  }

  if (state.dockerPull.isActive || state.blockingReady || state.phases[4].status === 'active') {
    return 'Downloading core runtime containers...';
  }

  if (state.phases[3].status === 'active') {
    return phaseLabels[3] || 'Preparing your workspace...';
  }

  if (!isBasicMode() && state.phases[4].status === 'active') {
    return phaseLabels[4];
  }

  if (state.isRunning || state.backgroundInstallRunning) {
    return 'Preparing your environment...';
  }

  return 'Preparing your setup...';
}

function renderDownloadArt() {
  return `
    <svg viewBox="0 0 320 180" class="prerequisites-art-svg" aria-hidden="true">
      <defs>
        <linearGradient id="download-sky" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f7fbff"></stop>
          <stop offset="100%" stop-color="#dbeafe"></stop>
        </linearGradient>
      </defs>
      <rect x="16" y="20" width="288" height="140" rx="28" fill="url(#download-sky)"></rect>
      <path d="M68 92h66" stroke="#9fb2cf" stroke-width="10" stroke-linecap="round"></path>
      <path d="M190 68l24 24 24-24" fill="none" stroke="#003a9b" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M214 44v44" stroke="#003a9b" stroke-width="10" stroke-linecap="round"></path>
      <rect x="86" y="54" width="40" height="54" rx="16" fill="#4f94ff"></rect>
      <circle cx="106" cy="48" r="8" fill="#4f94ff"></circle>
      <circle cx="98" cy="70" r="4" fill="#ffffff"></circle>
      <circle cx="114" cy="70" r="4" fill="#ffffff"></circle>
      <path d="M96 88c7 6 17 6 24 0" stroke="#ffffff" stroke-width="4" stroke-linecap="round"></path>
      <rect x="238" y="102" width="40" height="26" rx="13" fill="#7bb3ff"></rect>
      <circle cx="252" cy="94" r="7" fill="#7bb3ff"></circle>
      <circle cx="266" cy="94" r="7" fill="#7bb3ff"></circle>
      <path d="M86 126h186" stroke="#bfd0e7" stroke-width="8" stroke-linecap="round"></path>
    </svg>
  `;
}

function renderPasswordArt() {
  return `
    <svg viewBox="0 0 320 180" class="prerequisites-art-svg" aria-hidden="true">
      <rect x="48" y="20" width="224" height="138" rx="26" fill="#f8fafc" stroke="#cad5e2" stroke-width="4"></rect>
      <rect x="48" y="20" width="224" height="30" rx="26" fill="#e2e8f0"></rect>
      <circle cx="74" cy="35" r="6" fill="#f87171"></circle>
      <circle cx="94" cy="35" r="6" fill="#fbbf24"></circle>
      <circle cx="114" cy="35" r="6" fill="#4ade80"></circle>
      <rect x="82" y="72" width="156" height="22" rx="11" fill="#dbeafe"></rect>
      <rect x="82" y="106" width="108" height="20" rx="10" fill="#e2e8f0"></rect>
      <rect x="198" y="104" width="40" height="24" rx="12" fill="#003a9b"></rect>
      <path d="M156 98v-16c0-13 9-22 22-22 13 0 22 9 22 22v6" stroke="#003a9b" stroke-width="8" stroke-linecap="round" fill="none"></path>
      <rect x="140" y="90" width="52" height="44" rx="16" fill="#4f94ff"></rect>
      <circle cx="166" cy="108" r="6" fill="#ffffff"></circle>
      <path d="M166 114v10" stroke="#ffffff" stroke-width="4" stroke-linecap="round"></path>
    </svg>
  `;
}

function renderDockerArt() {
  return `
    <svg viewBox="0 0 320 180" class="prerequisites-art-svg" aria-hidden="true">
      <defs>
        <linearGradient id="container-sky" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f7fbff"></stop>
          <stop offset="100%" stop-color="#dcecff"></stop>
        </linearGradient>
        <linearGradient id="container-deck" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#dbe4ef"></stop>
          <stop offset="100%" stop-color="#c1cedf"></stop>
        </linearGradient>
        <linearGradient id="container-blue" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7bb3ff"></stop>
          <stop offset="100%" stop-color="#4f94ff"></stop>
        </linearGradient>
        <linearGradient id="container-navy" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4f94ff"></stop>
          <stop offset="100%" stop-color="#003a9b"></stop>
        </linearGradient>
        <linearGradient id="container-steel" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#8ea6c1"></stop>
          <stop offset="100%" stop-color="#5f7899"></stop>
        </linearGradient>
      </defs>
      <rect x="28" y="20" width="264" height="140" rx="28" fill="url(#container-sky)"></rect>
      <rect x="58" y="122" width="204" height="14" rx="7" fill="url(#container-deck)"></rect>
      <path d="M54 144h212" stroke="#91a7c0" stroke-width="6" stroke-linecap="round"></path>
      <path d="M76 122V70h8v52M244 122V58h8v64" stroke="#6b84a3" stroke-width="5" stroke-linecap="round"></path>
      <path d="M80 72h72M178 60h70" stroke="#6b84a3" stroke-width="5" stroke-linecap="round"></path>
      <rect x="82" y="92" width="36" height="26" rx="3" fill="url(#container-blue)" stroke="#355068" stroke-width="4"></rect>
      <rect x="120" y="92" width="36" height="26" rx="3" fill="url(#container-navy)" stroke="#355068" stroke-width="4"></rect>
      <rect x="158" y="92" width="36" height="26" rx="3" fill="#5db9ff" stroke="#355068" stroke-width="4"></rect>
      <rect x="196" y="92" width="36" height="26" rx="3" fill="url(#container-steel)" stroke="#355068" stroke-width="4"></rect>
      <rect x="101" y="64" width="36" height="24" rx="3" fill="#5db9ff" stroke="#355068" stroke-width="4"></rect>
      <rect x="139" y="64" width="36" height="24" rx="3" fill="url(#container-steel)" stroke="#355068" stroke-width="4"></rect>
      <rect x="177" y="64" width="36" height="24" rx="3" fill="url(#container-blue)" stroke="#355068" stroke-width="4"></rect>
      <rect x="138" y="36" width="36" height="24" rx="3" fill="url(#container-navy)" stroke="#355068" stroke-width="4"></rect>
      <path d="M96 96v18M106 96v18M134 96v18M144 96v18M172 96v18M182 96v18M210 96v18M220 96v18M115 68v16M125 68v16M153 68v16M163 68v16M191 68v16M201 68v16M152 40v16M162 40v16" stroke="rgba(21,42,64,0.28)" stroke-width="3" stroke-linecap="round"></path>
      <circle cx="74" cy="44" r="10" fill="rgba(79,148,255,0.18)"></circle>
      <circle cx="248" cy="42" r="8" fill="rgba(0,58,155,0.12)"></circle>
    </svg>
  `;
}

function renderErrorArt() {
  return `
    <svg viewBox="0 0 48 48" class="prerequisites-art-svg" aria-hidden="true">
      <circle cx="24" cy="24" r="20" fill="rgba(248,113,113,0.16)"></circle>
      <path d="M24 13v14" stroke="#ef4444" stroke-width="4" stroke-linecap="round"></path>
      <circle cx="24" cy="34" r="2.5" fill="#ef4444"></circle>
    </svg>
  `;
}

function getSpotlightContent() {
  const phase1Complete = state.phases[1].status === 'complete' || state.phase1Progress.downloadComplete;

  if (state.error) {
    return {
      art: renderErrorArt(),
      helper: state.error.recoveryCommand
        ? 'Terminal can finish this step.'
        : GENERIC_ERROR_BODY
    };
  }

  if (state.fullInstallComplete || state.backgroundReady || state.isComplete) {
    return {
      art: renderDockerArt(),
      helper: state.manualVisit ? '' : 'Core runtime containers are ready. Moving you along now.'
    };
  }

  if (!phase1Complete) {
    return {
      art: renderDownloadArt(),
      helper: 'Your new agent workspace is already on the way.'
    };
  }

  if (state.currentPhase === 2 && state.activeStep === 'command_line_tools') {
    return {
      art: renderPasswordArt(),
      helper: 'Approve the Apple Command Line Developer Tools / Software Update window.'
    };
  }

  if (state.currentPhase === 3 && state.activeStep === 'orbstack_approval') {
    return {
      art: renderPasswordArt(),
      helper: 'macOS may ask you to open OrbStack. Click <strong>Open</strong> once—setup will continue automatically.'
    };
  }

  if (state.dockerPull.isActive || state.blockingReady || state.phases[4].status === 'active') {
    return {
      art: renderDockerArt(),
      helper: state.authorizeReadiness.ready
        ? (state.manualVisit ? '' : 'Core runtime containers are ready. Moving you along now.')
        : "We're downloading all necessary software."
    };
  }

  return {
    art: renderPasswordArt(),
    helper: 'If prompted, please provide your <strong>computer</strong> password.'
  };
}

function render() {
  renderProgress();
  renderSpotlight();
  renderWarning();
  renderContinuePanel();
  renderError();
}

function renderProgress() {
  const progress = calculateOverallProgress();
  const progressContainer = document.getElementById('prerequisites-progress');
  const progressBar = document.getElementById('prerequisites-overall-progress');
  const progressText = document.getElementById('prerequisites-progress-text');
  const title = document.getElementById('prerequisites-title');
  const currentStep = document.getElementById('prerequisites-current-step');
  const fullyReady = Boolean(state.fullInstallComplete || state.backgroundReady || state.isComplete);
  const activelyRunning = Boolean((state.isRunning || state.backgroundInstallRunning) && !fullyReady && !state.error);
  const phase1Complete = state.phases[1].status === 'complete' || state.phase1Progress.downloadComplete;

  if (state.error) {
    if (title) title.style.display = 'none';
    if (progressContainer) progressContainer.style.display = 'none';
    if (progressText) progressText.textContent = '';
    if (currentStep) {
      currentStep.textContent = '';
      currentStep.style.display = 'none';
    }
    return;
  }

  if (title) title.style.display = '';
  if (progressContainer) progressContainer.style.display = '';

  if (progressBar) {
    progressBar.style.width = `${progress}%`;
    progressBar.classList.toggle('is-active', activelyRunning);
    progressBar.classList.toggle('is-complete', fullyReady);
  }

  if (progressText) {
    if (fullyReady) {
      progressText.textContent = 'Ready';
    } else if (!phase1Complete) {
      progressText.textContent = formatPercentText(state.phase1Progress.percent);
    } else if (state.dockerPull.isActive || state.blockingReady) {
      progressText.textContent = formatPercentText(state.authorizeReadiness.progressPercent || calculateDockerPullPercent());
    } else {
      progressText.textContent = `${progress}%`;
    }
  }

  if (title) {
    title.textContent = fullyReady
      ? 'Your environment is ready.'
      : 'Setting Up Your Environment...';
  }

  if (currentStep) {
    const summary = getCurrentStepSummary();
    currentStep.textContent = summary;
    currentStep.style.display = summary ? 'block' : 'none';
  }
}

function renderSpotlight() {
  const spotlight = document.getElementById('prerequisites-spotlight');
  const visual = document.getElementById('prerequisites-spotlight-visual');
  const helper = document.getElementById('prerequisites-spotlight-helper');
  if (!visual || !helper) return;

  if (state.error) {
    if (spotlight) {
      spotlight.style.display = 'none';
      spotlight.classList?.remove('is-error');
    }
    visual.innerHTML = '';
    helper.innerHTML = '';
    return;
  }

  if (spotlight) {
    spotlight.style.display = '';
  }
  if (spotlight?.classList) {
    spotlight.classList.toggle('is-error', Boolean(state.error));
  }
  const content = getSpotlightContent();
  visual.innerHTML = content.art;
  helper.innerHTML = content.helper || '';
}

function renderWarning() {
  const warningPanel = document.getElementById('prerequisites-warning');
  const warningMessage = document.getElementById('prerequisites-warning-message');
  if (!warningPanel || !warningMessage) return;

  if (!state.error && state.warningMessage) {
    warningPanel.style.display = 'block';
    warningMessage.textContent = state.warningMessage;
    return;
  }

  warningPanel.style.display = 'none';
  warningMessage.textContent = '';
}

function renderContinuePanel() {
  const panel = document.getElementById('prerequisites-continue');
  const copy = document.querySelector?.('.prerequisites-continue-copy');
  const title = document.getElementById('prerequisites-continue-title');
  const message = document.getElementById('prerequisites-continue-message');
  if (!panel) return;

  if (!state.manualVisit || !state.continueAvailable || state.error) {
    panel.style.display = 'none';
    panel.classList.remove('is-compact');
    if (copy) copy.style.display = '';
    return;
  }

  panel.style.display = 'flex';
  panel.classList.add('is-compact');
  if (copy) copy.style.display = 'none';
  if (title) title.textContent = state.continueTitle || 'Continue';
  if (message) message.textContent = state.continueMessage || '';
}

function renderError() {
  const errorPanel = document.getElementById('prerequisites-error');
  const errorEyebrow = document.getElementById('prerequisites-error-eyebrow');
  const errorTitle = document.getElementById('prerequisites-error-title');
  const errorMessage = document.getElementById('prerequisites-error-message');
  const errorFollowup = document.getElementById('prerequisites-error-followup');
  const manualAction = document.getElementById('prerequisites-error-manual-action');
  const recoveryPanel = document.getElementById('prerequisites-error-recovery');
  const commandDetails = document.getElementById('prerequisites-error-command-details');
  const commandSummary = document.getElementById('prerequisites-error-command-summary');
  const recoveryCommand = document.getElementById('prerequisites-error-command');
  const commandCopyBtn = document.getElementById('prerequisites-error-copy-command-btn');
  const commandCopyStatus = document.getElementById('prerequisites-error-copy-command-status');
  const passwordGuidance = document.getElementById('prerequisites-password-guidance');
  const passwordHint = document.getElementById('prerequisites-password-hint');
  const commandStatus = document.getElementById('prerequisites-error-command-status');
  const terminalCommandBtn = document.getElementById('prerequisites-open-terminal-command-btn');
  const retryBtn = document.getElementById('prerequisites-retry-btn');
  const retryLabel = document.getElementById('prerequisites-retry-label');
  if (!errorPanel || !errorMessage) return;

  if (!state.error) {
    if (retryLabel) retryLabel.textContent = 'Retry';
    if (retryBtn) {
      retryBtn.title = 'Retry';
      retryBtn.setAttribute('aria-label', 'Retry prerequisites');
    }
    errorPanel.style.display = 'none';
    if (errorEyebrow) errorEyebrow.style.display = 'none';
    if (errorFollowup) errorFollowup.style.display = 'none';
    if (manualAction) manualAction.style.display = 'none';
    if (recoveryPanel) recoveryPanel.style.display = 'none';
    if (passwordGuidance) passwordGuidance.style.display = 'none';
    if (terminalCommandBtn) terminalCommandBtn.style.display = 'none';
    if (commandCopyBtn) commandCopyBtn.style.display = 'none';
    if (commandCopyStatus) {
      commandCopyStatus.style.display = 'none';
      commandCopyStatus.textContent = '';
      commandCopyStatus.classList?.remove('error');
    }
    if (commandStatus) {
      commandStatus.style.display = 'none';
      commandStatus.textContent = '';
      commandStatus.classList?.remove('error');
    }
    return;
  }

  const hasRecoveryCommand = Boolean(state.error.recoveryCommand);
  const treatment = getVisibleErrorTreatment(state.error);
  const retryText = isOrbStackFailureCode(state.error.code) ? 'Try Again' : 'Retry';
  if (retryLabel) retryLabel.textContent = retryText;
  if (retryBtn) {
    retryBtn.title = retryText;
    retryBtn.setAttribute('aria-label', `${retryText} prerequisites`);
  }
  if (errorEyebrow) {
    errorEyebrow.textContent = treatment.eyebrow;
    errorEyebrow.style.display = treatment.eyebrow ? '' : 'none';
  }
  if (errorTitle) {
    errorTitle.textContent = treatment.title;
  }
  errorMessage.textContent = treatment.body;
  if (errorFollowup) {
    errorFollowup.textContent = treatment.followup || '';
    errorFollowup.style.display = hasRecoveryCommand && treatment.followup ? 'block' : 'none';
  }
  if (manualAction) {
    manualAction.style.display = hasRecoveryCommand ? 'flex' : 'none';
  }

  if (recoveryPanel && recoveryCommand && state.error.recoveryCommand) {
    if (passwordHint) passwordHint.textContent = TERMINAL_PASSWORD_HINT;
    if (commandSummary) commandSummary.textContent = '(Optional) View terminal command';
    if (passwordGuidance) {
      passwordGuidance.style.display = treatment.showPasswordGuidance ? '' : 'none';
    }
    recoveryCommand.textContent = state.error.recoveryCommand;
    if (commandCopyBtn) {
      commandCopyBtn.style.display = 'inline-flex';
      commandCopyBtn.disabled = false;
      commandCopyBtn.textContent = 'Copy Command';
    }
    if (commandCopyStatus) {
      commandCopyStatus.style.display = 'none';
      commandCopyStatus.textContent = '';
      commandCopyStatus.classList?.remove('error');
    }
    recoveryPanel.style.display = 'block';
  } else if (recoveryPanel) {
    recoveryPanel.style.display = 'none';
    if (passwordGuidance) passwordGuidance.style.display = 'none';
    if (commandCopyBtn) commandCopyBtn.style.display = 'none';
    if (commandCopyStatus) {
      commandCopyStatus.style.display = 'none';
      commandCopyStatus.textContent = '';
      commandCopyStatus.classList?.remove('error');
    }
  }

  if (commandStatus) {
    commandStatus.style.display = 'none';
    commandStatus.textContent = '';
    commandStatus.classList?.remove('error');
  }

  if (terminalCommandBtn) {
    terminalCommandBtn.onclick = async () => {
      const command = state?.error?.recoveryCommand;
      if (!command) return;

      const previousText = terminalCommandBtn.textContent;
      let result = null;
      const showPasteFallback = () => {
        if (errorFollowup) {
          errorFollowup.textContent = TERMINAL_RECOVERY_FOLLOWUP;
          errorFollowup.style.display = 'block';
        }
        if (commandStatus) {
          commandStatus.style.display = 'none';
          commandStatus.textContent = '';
          commandStatus.classList?.remove('error');
        }
      };
      try {
        terminalCommandBtn.disabled = true;
        terminalCommandBtn.textContent = 'Opening...';
        if (errorFollowup) {
          errorFollowup.style.display = 'none';
          errorFollowup.textContent = '';
        }
        if (commandStatus) {
          commandStatus.style.display = 'none';
          commandStatus.textContent = '';
          commandStatus.classList?.remove('error');
        }
        if (window.electronAPI?.openTerminalWithCommand) {
          result = await window.electronAPI.openTerminalWithCommand(command);
        } else {
          await copyTextToClipboard(command);
          result = { success: true, copied: true, terminalOpened: false };
        }

        if (!result?.success) {
          if (result?.copied) {
            showPasteFallback();
            addLogEntry(`Could not open the manual step window after copying the recovery command: ${result.error || 'Unknown error'}`, 'error', state?.error?.phase || null);
            return;
          }
          throw new Error(result?.error || 'Manual step could not be opened');
        }

        if (!result.commandStarted) {
          showPasteFallback();
        }
        addLogEntry(result.commandStarted
          ? 'Opened the manual recovery command in a terminal window.'
          : 'Copied the recovery command for manual paste.',
          'success',
          state?.error?.phase || null);
      } catch (error) {
        if (commandDetails) {
          commandDetails.open = true;
          commandDetails.setAttribute?.('open', '');
        }
        if (commandStatus) {
          commandStatus.textContent = TERMINAL_COMMAND_UNAVAILABLE;
          commandStatus.style.display = 'block';
          commandStatus.classList?.add('error');
        }
        addLogEntry(`Failed to open the manual recovery command: ${error.message}`, 'error', state?.error?.phase || null);
      } finally {
        terminalCommandBtn.disabled = false;
        terminalCommandBtn.textContent = previousText || 'Run Setup Step';
      }
    };
    terminalCommandBtn.style.display = state.error.recoveryCommand ? 'inline-flex' : 'none';
    terminalCommandBtn.textContent = 'Run Setup Step';
  }

  if (commandCopyBtn) {
    commandCopyBtn.onclick = async () => {
      const command = state?.error?.recoveryCommand;
      if (!command) return;
      const previousText = commandCopyBtn.textContent;
      try {
        commandCopyBtn.disabled = true;
        commandCopyBtn.textContent = 'Copying...';
        if (commandCopyStatus) {
          commandCopyStatus.style.display = 'none';
          commandCopyStatus.textContent = '';
          commandCopyStatus.classList?.remove('error');
        }
        await copyTextToClipboard(command);
        if (commandCopyStatus) {
          commandCopyStatus.textContent = OPTIONAL_COMMAND_COPIED;
          commandCopyStatus.style.display = 'inline';
          commandCopyStatus.classList?.remove('error');
        }
      } catch (error) {
        if (commandCopyStatus) {
          commandCopyStatus.textContent = OPTIONAL_COMMAND_FAILED;
          commandCopyStatus.style.display = 'inline';
          commandCopyStatus.classList?.add('error');
        }
        addLogEntry(`Failed to copy the optional recovery command: ${error.message}`, 'error', state?.error?.phase || null);
      } finally {
        commandCopyBtn.disabled = false;
        commandCopyBtn.textContent = previousText || 'Copy Command';
      }
    };
  }

  errorPanel.style.display = 'block';
}

function addLogEntry(text, type = 'info', phaseOverride = null) {
  const cleanText = stripAnsi(text);
  const entry = { text: cleanText, type, timestamp: Date.now() };
  state.logs.push(entry);

  while (state.logs.length > MAX_LOG_LINES) {
    state.logs.shift();
  }

  const phaseKey = phaseOverride || state.currentPhase;
  if (phaseKey && state.phaseLogs?.[phaseKey]) {
    state.phaseLogs[phaseKey].push(entry);
    while (state.phaseLogs[phaseKey].length > MAX_LOG_LINES) {
      state.phaseLogs[phaseKey].shift();
    }
  }

  notifyDebugDrawerUpdate();
}

function stripAnsi(str) {
  if (typeof str !== 'string') return String(str);
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setHostModeWarning(message) {
  state.hostModeWarning = true;
  state.hostModeWarningMessage = message || HOST_MODE_WARNING_MESSAGE;
  state.hostModeEnabled = false;
  if (state.phases[HOST_MODE_PHASE]) {
    state.phases[HOST_MODE_PHASE].status = 'warning';
  }
}

function formatLogEntry(entry) {
  const timestamp = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
  const level = (entry.type || 'info').toUpperCase();
  return `[${timestamp}] [${level}] ${entry.text}`;
}

function buildSectionFromEntries(id, title, entries, meta) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return {
    id,
    title,
    meta,
    content: entries.map(formatLogEntry).join('\n')
  };
}

function getPrereqDebugSections() {
  if (!state) return [];

  const sections = [];
  const timelineSection = buildSectionFromEntries(
    'prerequisites',
    'Prerequisites',
    state.logs,
    'Renderer timeline'
  );
  if (timelineSection) {
    sections.push(timelineSection);
  }

  const phaseLabels = getPhaseLabels();
  [1, 2, 3, 4].forEach((phaseNum) => {
    const phaseSection = buildSectionFromEntries(
      `prerequisites-phase-${phaseNum}`,
      `Prerequisites · Phase ${phaseNum}`,
      state.phaseLogs[phaseNum],
      phaseLabels[phaseNum]
    );
    if (phaseSection) {
      sections.push(phaseSection);
    }
  });

  return sections;
}

function getPhaseLogText(phaseNum) {
  if (!state?.phaseLogs?.[phaseNum]) return '';
  return state.phaseLogs[phaseNum].map(formatLogEntry).join('\n');
}

function openPrereqLogs(phaseNum) {
  if (!window.openLogViewerModal || !state) return;
  const phaseNames = {
    1: 'Prereqs: Download',
    2: 'Prereqs: Dependencies',
    3: 'Prereqs: Workspace',
    4: isBasicMode() ? 'Prereqs: Docker Images' : 'Prereqs: Host Mode'
  };

  window.openLogViewerModal(`prereq-phase-${phaseNum}`, 'inline', {
    name: phaseNames[phaseNum] || `Prereqs Phase ${phaseNum}`,
    logSource: 'inline',
    logProvider: () => getPhaseLogText(phaseNum),
    autoRefresh: state.isRunning
  });
}

function notifyDebugDrawerUpdate() {
  if (typeof window.notifyGuidedSetupDebugUpdate === 'function') {
    window.notifyGuidedSetupDebugUpdate();
  }
}

async function collectPrereqDebugInfo() {
  if (typeof window.collectGuidedSetupDebugInfo === 'function') {
    return window.collectGuidedSetupDebugInfo();
  }

  return window.electronAPI?.collectDebugInfo?.();
}

async function retryPrerequisites() {
  const previousFailureCode = state?.error?.code || null;
  stopAuthorizeReadinessPolling();
  clearAutoAdvanceTimer();
  state.error = null;
  state.isComplete = false;
  state.warningMessage = null;
  state.blockingReady = false;
  state.backgroundReady = false;
  state.continueAvailable = false;
  state.continueTitle = '';
  state.continueMessage = '';
  state.backgroundInstallRunning = false;
  state.fullInstallComplete = false;
  state.autoAdvanceTriggered = false;
  state.authorizeReadiness = {
    ready: false,
    waiting: false,
    progressPercent: 0,
    missingImages: []
  };
  state.currentPhase = 0;
  state.activeStep = null;
  state.dockerPull.images.clear();
  state.dockerPull.completedCount = 0;
  state.dockerPull.totalImages = 0;
  state.dockerPull.isActive = false;
  state.logs = [];
  state.phaseLogs = {
    1: [],
    2: [],
    3: [],
    4: []
  };

  for (const phaseNum of [1, 2, 3, 4]) {
    state.phases[phaseNum].status = 'pending';
    state.phases[phaseNum].startedAt = null;
    state.phases[phaseNum].completedAt = null;
  }

  seedDockerImages();
  render();
  addLogEntry('Retrying prerequisites...', 'info');

  try {
    const retryOptions = {
      ...getPrerequisitesRunOptions(),
    };
    if (previousFailureCode) {
      retryOptions.previousFailureCode = previousFailureCode;
    }
    if (shouldSkipHomebrewAuthOnRetry(previousFailureCode)) {
      retryOptions.skipHomebrewAuthOnRetry = true;
    }

    const result = await window.electronAPI.prerequisitesResumeInteractive(retryOptions);
    if (!result?.success) {
      addLogEntry(`Failed to restart prerequisites: ${result?.error || 'Unknown error'}`, 'error');
      return;
    }

    if (result.status) {
      hydrateStatusSnapshot(result.status);
      render();
    }
  } catch (error) {
    console.error('[screen-prerequisites] Error retrying prerequisites:', error);
    addLogEntry(`Error retrying: ${error.message}`, 'error');
  }
}

module.exports = {
  loadPrerequisitesScreen,
  bootstrapPrerequisitesSession,
  cleanupListeners,
  retryPrerequisites,
  openPrereqLogs,
  getPrereqDebugSections,
  collectPrereqDebugInfo,
  simulatePrerequisitesErrorState,
  clearSimulatedPrerequisitesErrorState,
  _test: {
    getPhaseLabels,
    getPrerequisitesRunOptions,
    resetState,
    markAuthorizeReady,
    maybeAutoAdvanceAfterAuthorizeReady,
    hydrateStatusSnapshot,
    formatPercentText,
    normalizeDockerImageSpec,
    seedDockerImages,
    calculateOverallProgress,
    calculateDockerPullPercent,
    getDockerPullSummary,
    getCurrentStepSummary,
    getSpotlightContent,
    formatLogEntry,
    buildSectionFromEntries,
    stripAnsi,
    escapeHtml,
    normalizeRecoveryCommand,
    normalizeRecoveryPayload,
    setHostModeWarning,
    handleStart,
    handlePhaseStart,
    handlePhaseComplete,
    handleDockerPullStart,
    handleDockerPull,
    handleDockerPullDeferred,
    handleDockerPullComplete,
    handleStepUpdate,
    handleProgress,
    handleWarning,
    handleBlockingReady,
    handleRetry,
    handleHostMode,
    handleComplete,
    handleError,
    buildSimulatedPrereqPayload,
    simulatePrerequisitesErrorState,
    clearSimulatedPrerequisitesErrorState,
    clonePrereqStateSnapshot,
    setContext(setupState, callbacks = {}) {
      _setupState = setupState;
      _callbacks = callbacks;
    },
    getState() {
      return state;
    }
  }
};

if (typeof window !== 'undefined') {
  window.openPrereqLogs = openPrereqLogs;
  window.collectPrereqDebugInfo = collectPrereqDebugInfo;
  window.getPrereqDebugSections = getPrereqDebugSections;
}
