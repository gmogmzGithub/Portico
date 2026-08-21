// windows.js - Window creation and lifecycle management
// Handles creation of loading, guided-setup, main, and chat windows

const {
  app,
  BrowserWindow,
  shell,
  dialog,
  nativeTheme,
  screen,
  systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { getLogger } = require('./logger');
const { evaluateSetupRequirementStatus } = require('./setup-completion');
const { classifySetupRequirementStatus, shouldDeferRequiredUpdateForSetup } = require('./setup-decision');
const { openHttpExternalUrl } = require('./shell-open');
const { loadAppPage } = require('./app-protocol');
const { tagAppQuit } = require('./quit-provenance');

// Import shared state for window references
const state = require('./shared-state');

// Import bootstrap for paths and utilities
const bootstrap = require('./bootstrap');
const {
  APP_SERVICES,
  PRELOAD_SCRIPT,
  getThemeIcon,
  getCurrentChannelLabel,
  updateAllWindowIcons,
  updateWindowMenu
} = bootstrap;
const { validateCustomReleaseChannelName } = require('../utils/release-channel');
const { safeExecuteJavaScript, safeWebContentsSend } = require('./webcontents-safe');
const owuiViews = require('./owui-views');
const {
  NATIVE_SIDEBAR_VIBRANCY_ARGUMENT,
  getMacWindowVisualOptions,
  isMacSidebarVibrancyEnabled,
} = require('./native-window-visuals');

const OPEN_WEBUI_HOME_URL = 'http://localhost:3789';
const BROWSER_CONSOLE_LEVEL_MAP = {
  0: 'debug',
  1: 'info',
  2: 'warn',
  3: 'error'
};
const DEFAULT_MAC_TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 21, y: 24 });
const DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 21, y: 15 });
let currentMacTrafficLightPosition = { ...DEFAULT_MAC_TRAFFIC_LIGHT_POSITION };
let currentMainMacTrafficLightPosition = { ...DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION };
const LOCAL_FIND_OVERLAY_STATE_CHANNEL = 'local-find-overlay-state';
const LOCAL_FIND_OVERLAY_EVENT_CHANNEL = 'local-find-overlay-event';
const LOCAL_FIND_OVERLAY_MIN_WIDTH = 252;
const LOCAL_FIND_OVERLAY_MIN_HEIGHT = 52;
const LOADING_WINDOW_BOUNDS = Object.freeze({
  compact: { width: 660, height: 500, minWidth: 620, minHeight: 460 },
  expanded: { width: 1116, height: 676, minWidth: 1040, minHeight: 620 },
});
const ARTIFACT_VERSION_MENU_EVENT_CHANNEL = 'artifact-version-menu-event';
const ARTIFACT_DIVIDER_OVERLAY_EVENT_CHANNEL = 'artifact-divider-overlay-event';
const ARTIFACT_DIVIDER_OVERLAY_MIN_WIDTH = 6;
let primaryAppPageFailureShown = false;

const artifactOverlayLoadPromises = {
  versionMenu: null,
  dividerOverlay: null,
};

const artifactVersionMenuState = {
  ownerWindowId: null,
  ownerLifecycleCleanup: null,
  isHiding: false,
};

const artifactDividerOverlayState = {
  ownerWindowId: null,
  ownerLifecycleCleanup: null,
  handleBounds: null,
  dragActive: false,
};
const localFindOverlayEntries = new Map();

function handlePrimaryAppPageFailure(windowRef, label, details) {
  if (primaryAppPageFailureShown) {
    return;
  }
  primaryAppPageFailureShown = true;

  try {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.hide();
    }
  } catch (_error) {
    // Best effort: the native error dialog is the important fallback.
  }

  const failureDescription =
    details?.didFailLoad?.errorDescription ||
    details?.error?.message ||
    'Unknown renderer load error';
  const errorCode = details?.didFailLoad?.errorCode;
  const codeSuffix = Number.isFinite(Number(errorCode))
    ? ` (error ${errorCode})`
    : '';
  const failedUrl = details?.url || 'app://bundle';

  dialog.showErrorBox(
    'Portico failed to load',
    `${label} could not be loaded${codeSuffix}.\n\n${failureDescription}\n\n${failedUrl}`,
  );

  setImmediate(() => {
    tagAppQuit('renderer-load-failure');
    app.quit();
  });
}

function loadPrimaryAppPage(windowRef, page, label) {
  const loadPromise = loadAppPage(windowRef, page, {
    label,
    onFailure: (details) =>
      handlePrimaryAppPageFailure(windowRef, label, details),
  });
  void loadPromise.catch(() => {
    // loadAppPage already logged the failure and displayed a native error.
  });
  return loadPromise;
}

function getLoadingWindowBackgroundColor() {
  const currentTheme = state.appState.currentTheme;
  if (currentTheme === 'light') {
    return '#f7f7f7';
  }
  if (currentTheme === 'dark') {
    return '#050505';
  }
  return nativeTheme.shouldUseDarkColors ? '#050505' : '#f7f7f7';
}

function normalizeBrowserConsoleLevel(level) {
  const numericLevel = Number(level);
  if (Number.isFinite(numericLevel) && BROWSER_CONSOLE_LEVEL_MAP[numericLevel]) {
    return BROWSER_CONSOLE_LEVEL_MAP[numericLevel];
  }
  return 'info';
}

function attachBrowserConsoleCapture(windowRef, windowLabel) {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  const webContents = windowRef.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  if (webContents.__porticoConsoleCaptureAttached) {
    return;
  }
  webContents.__porticoConsoleCaptureAttached = true;

  webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelName = normalizeBrowserConsoleLevel(level);
    const normalizedLine = Number.isFinite(Number(line)) ? Number(line) : null;
    const text = `[${windowLabel} CONSOLE] ${String(message || '')}`;
    const meta = {
      browserWindowConsole: true,
      windowLabel,
      windowId: windowRef.id,
      webContentsId: webContents.id,
      level: Number(level),
      line: normalizedLine,
      sourceId: sourceId || null
    };

    const logger = getLogger();
    if (logger && typeof logger.writeWebviewConsoleEntry === 'function') {
      logger.writeWebviewConsoleEntry({
        level: levelName,
        message: text,
        meta
      });
    }

    if (levelName === 'error') {
      console.error(text, meta);
    } else if (levelName === 'warn') {
      console.warn(text, meta);
    } else {
      console.info(text, meta);
    }
  });
}

function applyMacTrafficLightPosition(
  windowRef,
  position = currentMacTrafficLightPosition,
) {
  if (
    process.platform !== 'darwin' ||
    !windowRef ||
    windowRef.isDestroyed() ||
    typeof windowRef.setWindowButtonPosition !== 'function'
  ) {
    return;
  }

  try {
    windowRef.setWindowButtonPosition(position);
  } catch (error) {
    console.warn('[Windows] Failed to set traffic light position:', error.message);
  }
}

function getDetachedConversationMacTrafficLightPosition(
  position = DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION,
) {
  const normalized = normalizeMacTrafficLightPosition(position);
  if (!normalized) {
    return { ...DEFAULT_MAIN_MAC_TRAFFIC_LIGHT_POSITION };
  }

  return normalized;
}

function normalizeMacTrafficLightPosition(position) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
  };
}

function setMacTrafficLightPosition(position) {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'macOS traffic light positioning is only available on darwin',
    };
  }

  const normalized = normalizeMacTrafficLightPosition(position);
  if (!normalized) {
    return {
      success: false,
      error: 'Invalid macOS traffic light position',
    };
  }

  currentMainMacTrafficLightPosition = normalized;
  let appliedCount = 0;
  if (state.windows.main && !state.windows.main.isDestroyed()) {
    applyMacTrafficLightPosition(state.windows.main, currentMainMacTrafficLightPosition);
    appliedCount = 1;
  }

  return {
    success: true,
    position: { ...currentMainMacTrafficLightPosition },
    appliedCount,
  };
}

/**
 * Dependency injection container for cross-module functions
 * These are set by main.js after all modules are loaded
 */
const deps = {
  checkForUpdates: null,
  findSpecificBuild: null,
  beginMenuUpdateWorkflow: null,
  startStatusMonitoring: null,
  stopStatusMonitoring: null,
  startContinuousHealthChecks: null,
  stopContinuousHealthChecks: null,
  stopHostMcpo: null,
  stopHostMcpBridge: null
};

/**
 * Set dependencies from other modules
 * @param {Object} dependencies - Object containing dependency functions
 */
function setDependencies(dependencies) {
  Object.assign(deps, dependencies);
  console.log('[Windows] Dependencies set:', Object.keys(dependencies).join(', '));
}

/**
 * Get PROJECT_ROOT from bootstrap (lazy access)
 */
function getProjectRoot() {
  return bootstrap.PROJECT_ROOT;
}

/**
 * Reset config data on each load
 * Loads existing environment variables if .env file exists
 */
function resetConfigData() {
  const PROJECT_ROOT = getProjectRoot();

  state.configData.env = {};
  state.configData.mcpServers = {};
  state.configData.selectedServers = [];
  state.configData.mode = 'advanced';

  // Load existing environment variables if .env file exists
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const lines = envContent.split('\n');
      for (const line of lines) {
        if (line && !line.startsWith('#')) {
          const [key, ...valueParts] = line.split('=');
          if (key) {
            const value = valueParts.join('=').trim();
            state.configData.env[key.trim()] = value;
          }
        }
      }
    }
  } catch (error) {
    console.error('Error loading .env file in resetConfigData:', error);
  }
}

/**
 * Evaluate the current versioned setup requirement against userData completion state
 * and managed-root env sanity checks.
 */
function getSetupRequirementStatus() {
  try {
    const status = evaluateSetupRequirementStatus({
      projectRoot: getProjectRoot(),
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      appRoot: bootstrap.APP_ROOT,
    });

    if (status.hostPrerequisites) {
      console.log('[SetupGate] Host prerequisite readiness:', {
        ready: status.hostPrerequisites.isComplete,
        reason: status.hostPrerequisites.reason,
        selectedDeveloperDir:
          status.hostPrerequisites.developerTools?.selectedDeveloperDir || null,
        staplerPath: status.hostPrerequisites.developerTools?.staplerPath || null,
        orbStackAppPath: status.hostPrerequisites.orbStack?.appPath || null,
      });
    }

    if (status.needsSetup) {
      console.log(
        `[SetupGate] Guided setup required (${status.reason}): ${status.reasonMessage}`,
      );
    } else {
      console.log(
        `[SetupGate] Guided setup not required for requirement ${status.setupRequirementId}`,
      );
    }

    return status;
  } catch (error) {
    console.error('[SetupGate] Failed to evaluate setup requirement status:', error);
    return {
      needsSetup: true,
      reason: 'setup-evaluation-error',
      reasonMessage: error.message,
    };
  }
}

async function checkSetupWizardNeeded() {
  const action = getSetupLaunchDecision().action;
  return action === 'full_setup' || action === 'runtime_repair';
}

let activeSetupOperation = null;

function getSetupLaunchDecision() {
  let decision = classifySetupRequirementStatus(getSetupRequirementStatus());
  if (decision.action === 'continue') {
    activeSetupOperation = null;
  } else {
    const operationKey = [
      decision.action,
      decision.reason || 'none',
      decision.setupRequirementId || 'none',
    ].join(':');
    if (!activeSetupOperation || activeSetupOperation.key !== operationKey) {
      activeSetupOperation = {
        key: operationKey,
        id: `setup-${crypto.randomUUID()}`,
      };
    }
    decision = { ...decision, setupOperationId: activeSetupOperation.id };
  }
  console.log(
    `[Setup Audit] ${JSON.stringify({
      schemaVersion: 1,
      event: 'setup_decision',
      timestamp: new Date().toISOString(),
      setupOperationId: decision.setupOperationId || null,
      setupRequirementId: decision.setupRequirementId || null,
      action: decision.action,
      setupMode: decision.setupMode || null,
      setupReason: decision.reason || null,
      safeErrorCode: decision.safeErrorCode || null,
      source: 'startup',
      rootClassification: bootstrap.PROJECT_ROOT ? 'active-project-root' : 'project-root-missing',
      channel: bootstrap.getCurrentChannel?.() || 'unknown',
    })}`,
  );
  return decision;
}

/**
 * Treat "first run" as "setup is still required for the current requirement id".
 */
async function isFirstRun() {
  const action = getSetupLaunchDecision().action;
  return action === 'full_setup' || action === 'runtime_repair';
}

function setGuidedSetupLaunchContext(options = {}) {
  state.guidedSetupLaunchContext.source = typeof options.source === 'string' && options.source.trim()
    ? options.source.trim()
    : 'unknown';
  state.guidedSetupLaunchContext.trigger = typeof options.trigger === 'string' && options.trigger.trim()
    ? options.trigger.trim()
    : 'unknown';
  state.guidedSetupLaunchContext.startedAt = Date.now();
  state.guidedSetupLaunchContext.setupMode = typeof options.setupMode === 'string' && options.setupMode.trim()
    ? options.setupMode.trim()
    : null;
  state.guidedSetupLaunchContext.setupReason = typeof options.setupReason === 'string' && options.setupReason.trim()
    ? options.setupReason.trim()
    : null;
  state.guidedSetupLaunchContext.setupRequirementId = typeof options.setupRequirementId === 'string' && options.setupRequirementId.trim()
    ? options.setupRequirementId.trim()
    : null;
  state.guidedSetupLaunchContext.safeErrorCode = typeof options.safeErrorCode === 'string' && options.safeErrorCode.trim()
    ? options.safeErrorCode.trim()
    : null;
  state.guidedSetupLaunchContext.setupOperationId = typeof options.setupOperationId === 'string' && options.setupOperationId.trim()
    ? options.setupOperationId.trim()
    : null;
  state.guidedSetupLaunchContext.seedDefaults = options.seedDefaults === true;
}

/**
 * Create the guided setup window
 */
function createGuidedSetupWindow(options = {}) {
  setGuidedSetupLaunchContext(options);

  if (state.windows.guidedSetup && !state.windows.guidedSetup.isDestroyed()) {
    state.windows.guidedSetup.show();
    state.windows.guidedSetup.focus();
    return state.windows.guidedSetup;
  }

  const isMac = process.platform === 'darwin';

  // A 'full' launch skips the small welcome screen and renders the hello
  // mode-select stage immediately, which needs >860px of viewport for its two
  // cards to sit side by side (see the media query in guided-setup.css). Birth
  // the window at the hello size so first run opens correct instead of growing
  // into it; every other launch context keeps the compact welcome size.
  const startsOnHelloStage = options?.setupMode === 'full';
  const initialBounds = startsOnHelloStage
    ? { width: 1180, height: 820 }
    : { width: 740, height: 540 };

  state.windows.guidedSetup = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 700,
    minHeight: 520,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      webSecurity: true
    },
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: currentMacTrafficLightPosition,
    } : {
      titleBarStyle: 'hiddenInset',
    }),
    // Enable vibrancy on macOS unless opaque mode is set.
    ...(isMac ? {
      ...getMacWindowVisualOptions({ nativeTheme, defaultEnabled: false })
    } : {
      backgroundColor: '#3C4142'
    }),
    icon: getThemeIcon(),
    show: false
  });
  attachBrowserConsoleCapture(state.windows.guidedSetup, 'guided-setup');

  loadPrimaryAppPage(
    state.windows.guidedSetup,
    'guided-setup.html',
    'Guided setup',
  );
  state.appState.guidedSetupInitialBounds = { ...state.windows.guidedSetup.getBounds() };

  state.windows.guidedSetup.once('ready-to-show', () => {
    console.log('[Main] Guided setup window ready to show');
    state.windows.guidedSetup.show();
  });

  state.windows.guidedSetup.on('closed', () => {
    state.appState.guidedSetupInitialBounds = null;
    state.windows.guidedSetup = null;
  });

  return state.windows.guidedSetup;
}

function animateWindowBounds(windowRef, targetBounds, options = {}) {
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  const startBounds = windowRef.getBounds();
  const duration = Number.isFinite(options.duration) ? options.duration : 220;
  const steps = Number.isFinite(options.steps) ? options.steps : 16;
  const stepDuration = duration / steps;
  let currentStep = 0;

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const animateStep = () => {
    if (!windowRef || windowRef.isDestroyed()) {
      return;
    }

    currentStep += 1;
    const progress = easeOutCubic(currentStep / steps);
    const currentX = Math.round(startBounds.x + (targetBounds.x - startBounds.x) * progress);
    const currentY = Math.round(startBounds.y + (targetBounds.y - startBounds.y) * progress);
    const currentWidth = Math.round(startBounds.width + (targetBounds.width - startBounds.width) * progress);
    const currentHeight = Math.round(startBounds.height + (targetBounds.height - startBounds.height) * progress);

    windowRef.setBounds({
      x: currentX,
      y: currentY,
      width: currentWidth,
      height: currentHeight,
    });

    if (currentStep < steps) {
      setTimeout(animateStep, stepDuration);
    }
  };

  animateStep();
}

function computeCenteredBounds(windowRef, targetSize) {
  const currentBounds = windowRef.getBounds();
  const display = screen.getDisplayMatching(currentBounds);
  const {
    x: workAreaX,
    y: workAreaY,
    width: workAreaWidth,
    height: workAreaHeight,
  } = display.workArea;

  const width = Math.min(targetSize.width, workAreaWidth);
  const height = Math.min(targetSize.height, workAreaHeight);
  const x = workAreaX + Math.round((workAreaWidth - width) / 2);
  const y = workAreaY + Math.round((workAreaHeight - height) / 2);

  return { x, y, width, height };
}

function setLoadingWindowLogsDrawerOpen(open) {
  const loadingWindow = state.windows.loading;
  if (!loadingWindow || loadingWindow.isDestroyed()) {
    return false;
  }

  const target = open ? LOADING_WINDOW_BOUNDS.expanded : LOADING_WINDOW_BOUNDS.compact;
  loadingWindow.setMinimumSize(target.minWidth, target.minHeight);
  animateWindowBounds(loadingWindow, computeCenteredBounds(loadingWindow, target), {
    duration: 220,
    steps: 16,
  });
  return true;
}

/**
 * Create the loading window
 * @param {boolean} skipUpdateCheck - Skip the initial update check
 * @param {Object} pendingUpdateInfo - Update info if starting with pending update
 */
function createLoadingWindow(skipUpdateCheck = false, pendingUpdateInfo = null, forceRestart = false) {
  // Set the forceRestart flag in shared state for the initialization flow to read
  state.appState.forceRestart = forceRestart;

  const isMac = process.platform === 'darwin';

  state.windows.loading = new BrowserWindow({
    width: LOADING_WINDOW_BOUNDS.compact.width,
    height: LOADING_WINDOW_BOUNDS.compact.height,
    minWidth: LOADING_WINDOW_BOUNDS.compact.minWidth,
    minHeight: LOADING_WINDOW_BOUNDS.compact.minHeight,
    resizable: true,
    minimizable: true,
    maximizable: true,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 12 },
    backgroundColor: getLoadingWindowBackgroundColor(),
    icon: getThemeIcon(),
    show: false
  });
  attachBrowserConsoleCapture(state.windows.loading, 'loading');

  loadPrimaryAppPage(state.windows.loading, 'loading.html', 'Loading window');

  state.windows.loading.once('ready-to-show', () => {
    state.windows.loading.show();
  });

  // Make sure the window content is fully loaded before initializing
  state.windows.loading.webContents.once('did-finish-load', async () => {
    console.log('Loading window content loaded, ready for initialization');
    console.log('Skip update check flag:', skipUpdateCheck);
    console.log('Pending update info:', pendingUpdateInfo);

    // If we have pending update info (from main window), start update immediately
    if (pendingUpdateInfo) {
      console.log('Starting update from pending update info');
      setTimeout(() => {
        safeWebContentsSend(state.windows.loading, 'start-update', pendingUpdateInfo, {
          tag: 'loading-update-flow',
          meta: { source: 'pending-update-info' }
        });
      }, 500);
      return; // Don't do anything else
    }

    // Only perform update check if not explicitly skipped

    if (!skipUpdateCheck && deps.checkForUpdates) {
      try {
        console.log('Performing initial update check using Cloudsmith');
        const updateInfo = await deps.checkForUpdates();
        if (updateInfo.updateAvailable) {
          // PORTICO-376: a required update must not preempt required setup or repair.
          // Fresh installs, missing host prerequisites, and incomplete runtime
          // trees would dead-end at prep/apply. Run guided setup first; the
          // update is re-offered on the next launch once the machine is ready.
          const setupDecision = classifySetupRequirementStatus(getSetupRequirementStatus());
          if (shouldDeferRequiredUpdateForSetup(setupDecision)) {
            console.log(
              `[SetupGate] Deferring required update ${updateInfo.latestBuildNumber} until guided setup completes (${setupDecision.action}/${setupDecision.reason})`,
            );
            safeWebContentsSend(state.windows.loading, 'setup-wizard-needed', undefined, {
              tag: 'loading-init-flow',
              meta: { source: 'update-deferred-for-setup', updateDeferred: true }
            });
            return;
          }
          console.log('Update available on launch (Cloudsmith):', updateInfo.latestBuildNumber);
          // Launch gate mode: notify loading UI and pause initialization until
          // update preparation completes and startup auto-install begins.
          safeWebContentsSend(state.windows.loading, 'update-available', updateInfo, {
            tag: 'loading-update-flow',
            meta: { source: 'initial-check' }
          });
          return;
        }
        console.log('No Cloudsmith update available, continuing startup');

        const wizardNeeded = await checkSetupWizardNeeded();
        if (wizardNeeded) {
          console.log('Sending setup-wizard-needed signal');
          safeWebContentsSend(state.windows.loading, 'setup-wizard-needed', undefined, {
            tag: 'loading-init-flow',
            meta: { source: 'post-update-check' }
          });
        } else {
          console.log('Sending proceed-with-initialization signal');
          safeWebContentsSend(state.windows.loading, 'proceed-with-initialization', undefined, {
            tag: 'loading-init-flow',
            meta: { source: 'post-update-check' }
          });
        }
      } catch (error) {
        console.error('Initial update check failed:', error);
        // On error, check if setup wizard is needed
        const wizardNeeded = await checkSetupWizardNeeded();
        if (wizardNeeded) {
          console.log('Sending setup-wizard-needed signal');
          safeWebContentsSend(state.windows.loading, 'setup-wizard-needed', undefined, {
            tag: 'loading-init-flow',
            meta: { source: 'update-check-error' }
          });
        } else {
          console.log('Sending proceed-with-initialization signal');
          safeWebContentsSend(state.windows.loading, 'proceed-with-initialization', undefined, {
            tag: 'loading-init-flow',
            meta: { source: 'update-check-error' }
          });
        }
      }
    } else {
      console.log('Update check skipped but no pending update - checking wizard');
      const wizardNeeded = await checkSetupWizardNeeded();
      if (wizardNeeded) {
        console.log('Sending setup-wizard-needed signal');
        safeWebContentsSend(state.windows.loading, 'setup-wizard-needed', undefined, {
          tag: 'loading-init-flow',
          meta: { source: 'update-skip' }
        });
      } else {
        console.log('Sending proceed-with-initialization signal');
        safeWebContentsSend(state.windows.loading, 'proceed-with-initialization', undefined, {
          tag: 'loading-init-flow',
          meta: { source: 'update-skip' }
        });
      }
      return;
    }

    // Open dev tools for debugging
    if (process.env.DEBUG) {
      state.windows.loading.webContents.openDevTools();
    }
  });

  // Capture the window this handler belongs to. docker-start/docker-restart
  // close the PREVIOUS loading window right after taking the runtime mutation
  // lease, so an unguarded handler would both null out the newer window
  // reference and immediately release the lease that was just acquired for it.
  const loadingWindow = state.windows.loading;
  loadingWindow.on('closed', () => {
    if (state.windows.loading !== loadingWindow) {
      // A newer loading window already replaced this one; it owns the slot.
      return;
    }
    state.windows.loading = null;
    // Catch-all for every bring-up that ends without reaching
    // start-initialization: update-available, pending-update, auth failures,
    // or the user simply closing the window.
    state.releasePendingMcpRuntimeMutation('loading-window-closed');
  });
}

/**
 * Create the main window (control panel)
 */
function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const reduceTransparency = Boolean(
    systemPreferences?.isReduceTransparencyEnabled?.(),
  );
  const nativeSidebarVibrancy = isMacSidebarVibrancyEnabled({
    reduceTransparency,
  });

  state.windows.main = new BrowserWindow({
    width: 1440,
    height: 1000,
    center: true,
    minWidth: 640,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_SCRIPT,
      webviewTag: true,
      backgroundThrottling: true,
      ...(nativeSidebarVibrancy
        ? { additionalArguments: [NATIVE_SIDEBAR_VIBRANCY_ARGUMENT] }
        : {})
    },
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: currentMainMacTrafficLightPosition,
      ...getMacWindowVisualOptions({ nativeTheme, reduceTransparency })
    } : {
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#3C4142'
    }),
    icon: getThemeIcon(),
    show: false
  });
  attachBrowserConsoleCapture(state.windows.main, 'main');
  const hideMainTooltip = () => {
    hideMcpTooltip();
    hideUpdatePrepTooltip();
  };
  const syncMainWindowFullscreenState = () => {
    sendToMainWindow(
      'window-fullscreen-changed',
      Boolean(state.windows.main?.isFullScreen?.()),
    );
  };

  // Load manager interface
  loadPrimaryAppPage(state.windows.main, 'index.html', 'Main window');
  state.windows.main.webContents.on('did-finish-load', () => {
    syncMainWindowFullscreenState();
  });
  state.windows.main.on('enter-full-screen', syncMainWindowFullscreenState);
  state.windows.main.on('leave-full-screen', syncMainWindowFullscreenState);

  state.windows.main.once('ready-to-show', () => {
    state.windows.main.show();
    applyMacTrafficLightPosition(state.windows.main, currentMainMacTrafficLightPosition);
    const mcpTooltipWindow = ensureMcpTooltipWindow(state.windows.main);
    if (mcpTooltipWindow && tooltipLoadPromises.mcp) {
      void tooltipLoadPromises.mcp.catch((error) => {
        console.warn('[MCP Tooltip] Failed to prewarm tooltip window:', error.message);
      });
    }
    const updatePrepTooltipWindow = ensureUpdatePrepTooltipWindow(state.windows.main);
    if (updatePrepTooltipWindow && tooltipLoadPromises.updatePrep) {
      void tooltipLoadPromises.updatePrep.catch((error) => {
        console.warn('[Update Prep Tooltip] Failed to prewarm tooltip window:', error.message);
      });
    }
    if (state.appState.isManagerMode && deps.startStatusMonitoring) {
      deps.startStatusMonitoring();
    }
    // Start continuous health monitoring when main window opens
    console.log('[Main] Main window ready, starting health monitoring');
    if (deps.startContinuousHealthChecks) {
      deps.startContinuousHealthChecks();
    }
  });

  // Set permissions for clipboard access in iframes
  state.windows.main.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    // Allow clipboard permissions
    if (permission === 'clipboard-read' || permission === 'clipboard-write') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Set headers for clipboard access and proper CSP for localhost content
  state.windows.main.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    // Only modify headers for localhost (Open WebUI)
    if (details.url.includes('localhost:3789')) {
      // Remove restrictive CSP headers that might block clipboard
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['Content-Security-Policy'];

      // Add permissive feature policy for clipboard
      responseHeaders['Permissions-Policy'] = ['clipboard-read=*, clipboard-write=*'];
    }

    callback({ responseHeaders });
  });

  state.windows.main.webContents.setWindowOpenHandler(({ url }) => {
    void openHttpExternalUrl(shell, url).catch((error) => {
      logger.warn('[Windows] Blocked external URL from main window', {
        url,
        error: error.message,
      });
    });
    return { action: 'deny' };
  });

  state.windows.main.on('move', hideMainTooltip);
  state.windows.main.on('resize', hideMainTooltip);
  state.windows.main.on('blur', hideMainTooltip);
  state.windows.main.on('minimize', hideMainTooltip);

  state.windows.main.on('closed', () => {
    hideMcpTooltip({ destroy: true });
    hideUpdatePrepTooltip({ destroy: true });
    hideArtifactVersionMenu({ destroy: true, notifyOwner: false, reason: 'main-closed' });
    hideArtifactDividerOverlay({ destroy: true, notifyOwner: false, reason: 'main-closed' });
    hideLocalFindOverlay({ ownerWindowId: state.windows.main?.id, destroy: true, notifyOwner: false, reason: 'main-closed' });
    owuiViews.destroyViewsForWindow(state.windows.main?.id);
    if (state.appState.isManagerMode && deps.stopStatusMonitoring) {
      deps.stopStatusMonitoring();
    }
    if (state.windows.chat && !state.windows.chat.isDestroyed()) {
      state.windows.chat.close();
    }
    // Stop health monitoring when main window closes
    console.log('[Main] Main window closed, stopping health monitoring');
    if (deps.stopContinuousHealthChecks) {
      deps.stopContinuousHealthChecks();
    }
    state.windows.main = null;
  });
}

const TOOLTIP_WINDOW_CONFIG = Object.freeze({
  mcp: {
    stateKey: 'mcpTooltip',
    wrapperClass: 'mcp-tooltip',
    logLabel: 'MCP Tooltip',
    minWidth: 280,
    minHeight: 120,
  },
  updatePrep: {
    stateKey: 'updatePrepTooltip',
    wrapperClass: 'update-prep-tooltip',
    logLabel: 'Update Prep Tooltip',
    minWidth: 280,
    minHeight: 1,
  },
});
const tooltipLoadPromises = {
  mcp: null,
  updatePrep: null,
};

function getTooltipWindowConfig(kind) {
  return TOOLTIP_WINDOW_CONFIG[kind] || null;
}

function ensureShellTooltipWindow(kind, parentWindow = state.windows.main) {
  const config = getTooltipWindowConfig(kind);
  if (!config) {
    return null;
  }
  if (!parentWindow || parentWindow.isDestroyed()) {
    return null;
  }

  const existing = state.windows[config.stateKey];
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const tooltipWindow = new BrowserWindow({
    width: 720,
    height: 420,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: true,
    parent: parentWindow,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  tooltipWindow.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform !== 'darwin') {
    tooltipWindow.setAlwaysOnTop(true, 'pop-up-menu');
    tooltipWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  }
  tooltipWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  state.windows[config.stateKey] = tooltipWindow;
  tooltipLoadPromises[kind] = loadAppPage(
    tooltipWindow,
    'mcp-tooltip.html',
    { label: `${kind} tooltip` },
  );

  tooltipWindow.on('closed', () => {
    if (state.windows[config.stateKey] === tooltipWindow) {
      state.windows[config.stateKey] = null;
    }
    tooltipLoadPromises[kind] = null;
  });

  return tooltipWindow;
}

function ensureMcpTooltipWindow(parentWindow = state.windows.main) {
  return ensureShellTooltipWindow('mcp', parentWindow);
}

function ensureUpdatePrepTooltipWindow(parentWindow = state.windows.main) {
  return ensureShellTooltipWindow('updatePrep', parentWindow);
}

async function showShellTooltip(kind, options = {}) {
  const config = getTooltipWindowConfig(kind);
  if (!config) {
    return false;
  }
  const parentWindow = state.windows.main;
  if (!parentWindow || parentWindow.isDestroyed()) {
    return false;
  }

  if (
    typeof parentWindow.isFocused === 'function' &&
    !parentWindow.isFocused()
  ) {
    hideShellTooltip(kind);
    return false;
  }

  const tooltipWindow = ensureShellTooltipWindow(kind, parentWindow);
  if (!tooltipWindow) {
    return false;
  }

  if (tooltipLoadPromises[kind]) {
    await tooltipLoadPromises[kind];
  }

  const {
    html = '',
    theme = 'dark',
    x = 0,
    y = 0,
    width = 560,
    height = 320,
  } = options;
  const minWidth = Math.max(1, Math.round(Number(config.minWidth) || 280));
  const minHeight = Math.max(1, Math.round(Number(config.minHeight) || 120));

  const contentBounds = parentWindow.getContentBounds();
  const tooltipBounds = {
    x: Math.round(contentBounds.x + Number(x || 0)),
    y: Math.round(contentBounds.y + Number(y || 0)),
    width: Math.max(minWidth, Math.round(Number(width) || 0)),
    height: Math.max(minHeight, Math.round(Number(height) || 0)),
  };

  const shellHtml = `<div class="${config.wrapperClass}" id="${kind}-tooltip-window-shell">${html}</div>`;
  const script = `
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
    document.getElementById('tooltip-shell').innerHTML = ${JSON.stringify(shellHtml)};
  `;

  await tooltipWindow.webContents.executeJavaScript(script, true);
  tooltipWindow.setBounds(tooltipBounds);
  if (typeof tooltipWindow.showInactive === 'function') {
    tooltipWindow.showInactive();
  } else {
    tooltipWindow.show();
  }
  return true;
}

async function showMcpTooltip(options = {}) {
  return showShellTooltip('mcp', options);
}

async function showUpdatePrepTooltip(options = {}) {
  return showShellTooltip('updatePrep', options);
}

function hideShellTooltip(kind, options = {}) {
  const config = getTooltipWindowConfig(kind);
  if (!config) {
    return;
  }
  const { destroy = false } = options;
  const tooltipWindow = state.windows[config.stateKey];
  if (!tooltipWindow || tooltipWindow.isDestroyed()) {
    state.windows[config.stateKey] = null;
    return;
  }

  if (destroy) {
    tooltipWindow.destroy();
    return;
  }

  tooltipWindow.hide();
}

function hideMcpTooltip(options = {}) {
  hideShellTooltip('mcp', options);
}

function hideUpdatePrepTooltip(options = {}) {
  hideShellTooltip('updatePrep', options);
}

function getLocalFindOverlayEntry(ownerWindowId) {
  const normalizedOwnerWindowId = Number(ownerWindowId);
  if (!Number.isFinite(normalizedOwnerWindowId)) {
    return null;
  }

  return localFindOverlayEntries.get(normalizedOwnerWindowId) || null;
}

function findLocalFindOverlayEntryByWindow(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  for (const entry of localFindOverlayEntries.values()) {
    if (entry?.window && !entry.window.isDestroyed() && entry.window.id === windowRef.id) {
      return entry;
    }
  }

  return null;
}

function getLocalFindOverlayOwnerWindow(windowRef) {
  const entry = findLocalFindOverlayEntryByWindow(windowRef);
  if (!entry) {
    return null;
  }

  return getManagedWindowById(entry.ownerWindowId);
}

function resolveLocalFindOwnerWindow(windowRef) {
  const ownerWindow = getLocalFindOverlayOwnerWindow(windowRef);
  if (ownerWindow) {
    return ownerWindow;
  }

  if (findLocalFindOverlayEntryByWindow(windowRef)) {
    return null;
  }

  return windowRef || null;
}

function refreshMacWindowShadow(windowRef) {
  if (process.platform !== 'darwin' || !windowRef || windowRef.isDestroyed()) {
    return;
  }

  try {
    windowRef.setHasShadow(true);
  } catch (_error) {
    // best-effort shadow stability
  }

  try {
    if (typeof windowRef.invalidateShadow === 'function') {
      windowRef.invalidateShadow();
    }
  } catch (_error) {
    // best-effort shadow invalidation
  }
}

function clearLocalFindOverlayOwnerLifecycle(entry) {
  if (typeof entry?.ownerLifecycleCleanup === 'function') {
    entry.ownerLifecycleCleanup();
  }
  if (entry) {
    entry.ownerLifecycleCleanup = null;
  }
}

function sendLocalFindOverlayOwnerEvent(payload = {}, ownerWindowId) {
  const ownerWindow = getManagedWindowById(ownerWindowId);
  if (!ownerWindow) {
    return;
  }

  safeWebContentsSend(ownerWindow, LOCAL_FIND_OVERLAY_EVENT_CHANNEL, payload, {
    tag: 'local-find-overlay-owner-event',
    meta: {
      ownerWindowId: ownerWindow.id,
      type: payload?.type || 'unknown',
    },
  });
}

function isLocalFindOverlayFocusedForOwner(ownerWindow) {
  if (!ownerWindow || ownerWindow.isDestroyed()) {
    return false;
  }

  const entry = getLocalFindOverlayEntry(ownerWindow.id);
  if (!entry?.window || entry.window.isDestroyed()) {
    return false;
  }

  const overlayParentWindow =
    typeof entry.window.getParentWindow === 'function' ? entry.window.getParentWindow() : null;
  if (!overlayParentWindow || overlayParentWindow.isDestroyed() || overlayParentWindow.id !== ownerWindow.id) {
    return false;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return false;
  }

  return focusedWindow.id === entry.window.id;
}

function bindLocalFindOverlayOwnerLifecycle(parentWindow, entry) {
  if (!parentWindow || parentWindow.isDestroyed() || !entry?.window || entry.window.isDestroyed()) {
    return null;
  }

  const ownerWindowId = parentWindow.id;
  const syncBounds = () => {
    if (
      entry.ownerWindowId !== ownerWindowId ||
      !entry.window ||
      entry.window.isDestroyed() ||
      !entry.lastLocalBounds
    ) {
      return;
    }

    const nextBounds = localBoundsToScreen(parentWindow, entry.lastLocalBounds);
    if (!nextBounds) {
      return;
    }

    entry.window.setBounds(nextBounds);
  };
  const blurHandler = () => {
    setTimeout(() => {
      if (entry.ownerWindowId !== ownerWindowId) {
        return;
      }

      const ownerWindow = getManagedWindowById(ownerWindowId);
      if (!ownerWindow) {
        return;
      }

      if (isLocalFindOverlayFocusedForOwner(ownerWindow)) {
        return;
      }

      sendLocalFindOverlayOwnerEvent({ type: 'release-focus', reason: 'owner-blur' }, ownerWindowId);
    }, 0);
  };
  const minimizeHandler = () => {
    hideLocalFindOverlay({ ownerWindowId, notifyOwner: true, reason: 'parent-minimize' });
  };
  const closedHandler = () => {
    hideLocalFindOverlay({ ownerWindowId, destroy: true, notifyOwner: false, reason: 'parent-closed' });
  };

  parentWindow.on('move', syncBounds);
  parentWindow.on('resize', syncBounds);
  parentWindow.on('blur', blurHandler);
  parentWindow.on('minimize', minimizeHandler);
  parentWindow.on('closed', closedHandler);

  return () => {
    if (parentWindow.isDestroyed()) {
      return;
    }

    parentWindow.removeListener('move', syncBounds);
    parentWindow.removeListener('resize', syncBounds);
    parentWindow.removeListener('blur', blurHandler);
    parentWindow.removeListener('minimize', minimizeHandler);
    parentWindow.removeListener('closed', closedHandler);
  };
}

function ensureLocalFindOverlayWindow(parentWindow = state.windows.main) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return null;
  }

  const existing = getLocalFindOverlayEntry(parentWindow.id);
  if (existing?.window && !existing.window.isDestroyed()) {
    return existing;
  }

  const overlayWindow = new BrowserWindow({
    width: 408,
    height: LOCAL_FIND_OVERLAY_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    parent: parentWindow,
    webPreferences: {
      preload: path.join(APP_SERVICES, 'local-find-overlay-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.platform !== 'darwin') {
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    overlayWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  }

  const entry = {
    ownerWindowId: parentWindow.id,
    window: overlayWindow,
    loadPromise: loadAppPage(overlayWindow, 'local-find-overlay.html', {
      label: 'Local find overlay',
    }),
    ownerLifecycleCleanup: null,
    lastLocalBounds: null,
    lastPayload: null,
    isHiding: false,
  };
  localFindOverlayEntries.set(parentWindow.id, entry);

  overlayWindow.on('closed', () => {
    clearLocalFindOverlayOwnerLifecycle(entry);
    if (localFindOverlayEntries.get(parentWindow.id) === entry) {
      localFindOverlayEntries.delete(parentWindow.id);
    }
    entry.loadPromise = null;
    entry.lastLocalBounds = null;
    entry.lastPayload = null;
    entry.isHiding = false;
    sendLocalFindOverlayOwnerEvent({ type: 'close', reason: 'overlay-closed' }, entry.ownerWindowId);
  });

  return entry;
}

async function syncLocalFindOverlay(payload = {}, parentWindow = state.windows.main) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return { visible: false };
  }
  refreshMacWindowShadow(parentWindow);

  if (payload?.visible !== true) {
    hideLocalFindOverlay({
      ownerWindowId: parentWindow.id,
      destroy: true,
      notifyOwner: false,
      reason: payload?.reason || 'hidden',
    });
    return { visible: false };
  }

  const entry = ensureLocalFindOverlayWindow(parentWindow);
  if (!entry?.window || entry.window.isDestroyed()) {
    return { visible: false };
  }

  if (entry.loadPromise) {
    await entry.loadPromise;
  }

  const localBounds = clampLocalBoundsToContent(parentWindow, payload.bounds, {
    width: LOCAL_FIND_OVERLAY_MIN_WIDTH,
    height: LOCAL_FIND_OVERLAY_MIN_HEIGHT,
  });
  const screenBounds = localBoundsToScreen(parentWindow, localBounds);
  if (!localBounds || !screenBounds) {
    hideLocalFindOverlay({
      ownerWindowId: parentWindow.id,
      notifyOwner: false,
      reason: 'missing-bounds',
    });
    return { visible: false };
  }

  entry.ownerWindowId = parentWindow.id;
  entry.lastLocalBounds = localBounds;
  entry.lastPayload = {
    ...payload,
    bounds: localBounds,
  };
  if (!entry.ownerLifecycleCleanup || entry.ownerWindowId !== parentWindow.id) {
    clearLocalFindOverlayOwnerLifecycle(entry);
    entry.ownerLifecycleCleanup = bindLocalFindOverlayOwnerLifecycle(parentWindow, entry);
  }

  try {
    entry.window.setIgnoreMouseEvents(false);
  } catch (_error) {
    // best-effort reset in case a previous hide path enabled click-through mode
  }

  entry.window.webContents.send(LOCAL_FIND_OVERLAY_STATE_CHANNEL, entry.lastPayload);
  entry.window.setBounds(screenBounds);

  if (!entry.window.isVisible()) {
    if (payload.retainFocus === true) {
      entry.window.show();
    } else if (typeof entry.window.showInactive === 'function') {
      entry.window.showInactive();
    } else {
      entry.window.show();
    }
    refreshMacWindowShadow(parentWindow);
  }

  if (payload.retainFocus === true && BrowserWindow.getFocusedWindow()?.id !== entry.window.id) {
    entry.window.focus();
    setTimeout(() => refreshMacWindowShadow(parentWindow), 0);
  }

  return {
    visible: true,
    retainFocus: payload.retainFocus === true,
    bounds: localBounds,
  };
}

function hideLocalFindOverlay(options = {}) {
  const {
    ownerWindowId = null,
    destroy = false,
    notifyOwner = false,
    reason = 'dismiss',
  } = options;
  const entry = getLocalFindOverlayEntry(ownerWindowId);
  if (!entry?.window || entry.window.isDestroyed()) {
    if (ownerWindowId !== null) {
      localFindOverlayEntries.delete(Number(ownerWindowId));
    }
    return;
  }

  if (entry.isHiding) {
    return;
  }

  const ownerWindow = getManagedWindowById(entry.ownerWindowId);
  const shouldRefocusOwner =
    reason !== 'parent-minimize' &&
    reason !== 'parent-closed' &&
    reason !== 'main-closed' &&
    reason !== 'conversation-closed';

  entry.isHiding = true;
  try {
    clearLocalFindOverlayOwnerLifecycle(entry);
    entry.lastLocalBounds = null;
    entry.lastPayload = null;
    try {
      entry.window.blur();
    } catch (_error) {
      // best-effort blur before hide/destroy
    }
    if (destroy) {
      const normalizedOwnerWindowId = Number(entry.ownerWindowId);
      localFindOverlayEntries.delete(normalizedOwnerWindowId);
      try {
        entry.window.setIgnoreMouseEvents(true, { forward: true });
      } catch (_error) {
        // best-effort cleanup for orphaned overlays
      }
      entry.window.destroy();
    } else {
      try {
        entry.window.setIgnoreMouseEvents(true, { forward: true });
      } catch (_error) {
        // best-effort safety so hidden overlays cannot intercept pointer input
      }
      entry.window.hide();
    }

    if (notifyOwner) {
      sendLocalFindOverlayOwnerEvent({ type: 'close', reason }, entry.ownerWindowId);
    }
  } finally {
    entry.isHiding = false;
  }

  if (
    shouldRefocusOwner &&
    ownerWindow &&
    !ownerWindow.isDestroyed() &&
    !ownerWindow.isMinimized()
  ) {
    setTimeout(() => {
      if (!ownerWindow.isDestroyed() && !ownerWindow.isMinimized()) {
        refreshMacWindowShadow(ownerWindow);
        ownerWindow.focus();
        try {
          const owuiViews = require("./owui-views");
          const activeViewKey = owuiViews.getActiveViewKeyForWindow(ownerWindow.id);
          if (activeViewKey) {
            void owuiViews.focusView(activeViewKey).catch(() => {
              ownerWindow.webContents.focus();
            });
            return;
          }
        } catch (_error) {
          // Fall back to the shell renderer when no active OWUI view is available.
        }

        ownerWindow.webContents.focus();
      }
    }, 0);
  } else if (ownerWindow && !ownerWindow.isDestroyed()) {
    refreshMacWindowShadow(ownerWindow);
  }
}

function getManagedWindowById(windowId) {
  if (!Number.isFinite(Number(windowId))) {
    return null;
  }

  const windowRef = BrowserWindow.fromId(Number(windowId));
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  return windowRef;
}

function clampLocalBoundsToContent(windowRef, bounds = {}, minimums = {}) {
  if (!windowRef || windowRef.isDestroyed()) {
    return null;
  }

  const contentBounds = windowRef.getContentBounds();
  const minWidth = Math.max(1, Math.round(Number(minimums.width) || 1));
  const minHeight = Math.max(1, Math.round(Number(minimums.height) || 1));
  const width = Math.max(
    minWidth,
    Math.min(
      Math.round(Number(bounds.width) || 0),
      Math.max(minWidth, Math.round(Number(contentBounds.width) || 0)),
    ),
  );
  const height = Math.max(
    minHeight,
    Math.min(
      Math.round(Number(bounds.height) || 0),
      Math.max(minHeight, Math.round(Number(contentBounds.height) || 0)),
    ),
  );
  const x = Math.max(
    0,
    Math.min(
      Math.round(Number(bounds.x) || 0),
      Math.max(0, Math.round(Number(contentBounds.width) || 0) - width),
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      Math.round(Number(bounds.y) || 0),
      Math.max(0, Math.round(Number(contentBounds.height) || 0) - height),
    ),
  );

  return { x, y, width, height };
}

function localBoundsToScreen(windowRef, localBounds = {}) {
  if (!windowRef || windowRef.isDestroyed() || !localBounds) {
    return null;
  }

  const contentBounds = windowRef.getContentBounds();
  return {
    x: Math.round(contentBounds.x + Number(localBounds.x || 0)),
    y: Math.round(contentBounds.y + Number(localBounds.y || 0)),
    width: Math.max(1, Math.round(Number(localBounds.width) || 0)),
    height: Math.max(1, Math.round(Number(localBounds.height) || 0)),
  };
}

function bindOwnerLifecycle(windowRef, eventNames, handler) {
  if (!windowRef || windowRef.isDestroyed() || typeof handler !== 'function') {
    return null;
  }

  for (const eventName of eventNames) {
    windowRef.on(eventName, handler);
  }

  return () => {
    if (!windowRef || windowRef.isDestroyed()) {
      return;
    }

    for (const eventName of eventNames) {
      windowRef.removeListener(eventName, handler);
    }
  };
}

function clearArtifactVersionMenuOwnerLifecycle() {
  if (typeof artifactVersionMenuState.ownerLifecycleCleanup === 'function') {
    artifactVersionMenuState.ownerLifecycleCleanup();
  }
  artifactVersionMenuState.ownerLifecycleCleanup = null;
}

function clearArtifactDividerOverlayOwnerLifecycle() {
  if (typeof artifactDividerOverlayState.ownerLifecycleCleanup === 'function') {
    artifactDividerOverlayState.ownerLifecycleCleanup();
  }
  artifactDividerOverlayState.ownerLifecycleCleanup = null;
}

function sendArtifactVersionMenuOwnerEvent(payload = {}, ownerWindowId = artifactVersionMenuState.ownerWindowId) {
  const ownerWindow = getManagedWindowById(ownerWindowId);
  if (!ownerWindow) {
    return;
  }

  safeWebContentsSend(ownerWindow, ARTIFACT_VERSION_MENU_EVENT_CHANNEL, payload, {
    tag: 'artifact-version-menu-owner-event',
    meta: { ownerWindowId: ownerWindow.id },
  });
}

function sendArtifactDividerOverlayOwnerEvent(payload = {}, ownerWindowId = artifactDividerOverlayState.ownerWindowId) {
  const ownerWindow = getManagedWindowById(ownerWindowId);
  if (!ownerWindow) {
    return false;
  }

  return safeWebContentsSend(ownerWindow, ARTIFACT_DIVIDER_OVERLAY_EVENT_CHANNEL, payload, {
    tag: 'artifact-divider-overlay-owner-event',
    meta: { ownerWindowId: ownerWindow.id },
  });
}

function forwardArtifactDividerOverlayHover(payload = {}) {
  const type = payload?.type === 'hover-end' ? 'hover-end' : 'hover-start';
  return sendArtifactDividerOverlayOwnerEvent({ type });
}

function isArtifactVersionMenuFocusedForOwner(ownerWindow) {
  if (!ownerWindow || ownerWindow.isDestroyed()) {
    return false;
  }

  const menuWindow = state.windows.artifactVersionMenu;
  if (!menuWindow || menuWindow.isDestroyed()) {
    return false;
  }

  if (artifactVersionMenuState.ownerWindowId !== ownerWindow.id) {
    return false;
  }

  const menuParentWindow =
    typeof menuWindow.getParentWindow === 'function' ? menuWindow.getParentWindow() : null;
  if (!menuParentWindow || menuParentWindow.isDestroyed() || menuParentWindow.id !== ownerWindow.id) {
    return false;
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return false;
  }

  return focusedWindow.id === menuWindow.id;
}

function bindArtifactDividerOverlayOwnerLifecycle(parentWindow) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return null;
  }

  const ownerWindowId = parentWindow.id;
  const blurHandler = () => {
    setTimeout(() => {
      if (artifactDividerOverlayState.ownerWindowId !== ownerWindowId) {
        return;
      }

      const ownerWindow = getManagedWindowById(ownerWindowId);
      if (!ownerWindow) {
        return;
      }

      if (isArtifactVersionMenuFocusedForOwner(ownerWindow)) {
        return;
      }

      hideArtifactDividerOverlay({
        notifyOwner: artifactDividerOverlayState.dragActive,
        reason: 'parent-blur',
      });
    }, 0);
  };

  const baseCleanup = bindOwnerLifecycle(
    parentWindow,
    ['minimize', 'closed'],
    () => hideArtifactDividerOverlay({
      notifyOwner: artifactDividerOverlayState.dragActive,
      reason: 'parent-change',
    }),
  );

  parentWindow.on('blur', blurHandler);
  return () => {
    if (!parentWindow.isDestroyed()) {
      parentWindow.removeListener('blur', blurHandler);
    }
    if (typeof baseCleanup === 'function') {
      baseCleanup();
    }
  };
}

function ensureArtifactVersionMenuWindow(parentWindow = state.windows.main) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return null;
  }

  const existing = state.windows.artifactVersionMenu;
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const menuWindow = new BrowserWindow({
    width: 360,
    height: 240,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    parent: parentWindow,
    webPreferences: {
      preload: path.join(APP_SERVICES, 'artifact-version-menu-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  menuWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.platform !== 'darwin') {
    menuWindow.setAlwaysOnTop(true, 'pop-up-menu');
    menuWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  }

  state.windows.artifactVersionMenu = menuWindow;
  artifactOverlayLoadPromises.versionMenu = loadAppPage(
    menuWindow,
    'artifact-version-menu.html',
    { label: 'Artifact version menu' },
  );

  menuWindow.on('blur', () => {
    if (!artifactVersionMenuState.isHiding) {
      hideArtifactVersionMenu({ notifyOwner: true, reason: 'blur' });
    }
  });

  menuWindow.on('closed', () => {
    if (state.windows.artifactVersionMenu === menuWindow) {
      state.windows.artifactVersionMenu = null;
    }
    artifactOverlayLoadPromises.versionMenu = null;
    artifactVersionMenuState.ownerWindowId = null;
    artifactVersionMenuState.isHiding = false;
    clearArtifactVersionMenuOwnerLifecycle();
  });

  return menuWindow;
}

function ensureArtifactDividerOverlayWindow(parentWindow = state.windows.main) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return null;
  }

  const existing = state.windows.artifactDividerOverlay;
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const overlayWindow = new BrowserWindow({
    width: 12,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    parent: parentWindow,
    webPreferences: {
      preload: path.join(APP_SERVICES, 'artifact-divider-overlay-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.platform !== 'darwin') {
    overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    overlayWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  }

  state.windows.artifactDividerOverlay = overlayWindow;
  artifactOverlayLoadPromises.dividerOverlay = loadAppPage(
    overlayWindow,
    'artifact-divider-overlay.html',
    { label: 'Artifact divider overlay' },
  );

  overlayWindow.on('closed', () => {
    if (state.windows.artifactDividerOverlay === overlayWindow) {
      state.windows.artifactDividerOverlay = null;
    }
    artifactOverlayLoadPromises.dividerOverlay = null;
    artifactDividerOverlayState.ownerWindowId = null;
    artifactDividerOverlayState.handleBounds = null;
    artifactDividerOverlayState.dragActive = false;
    clearArtifactDividerOverlayOwnerLifecycle();
  });

  return overlayWindow;
}

async function showArtifactVersionMenu(options = {}, parentWindow = state.windows.main) {
  if (!parentWindow || parentWindow.isDestroyed()) {
    return false;
  }

  const menuWindow = ensureArtifactVersionMenuWindow(parentWindow);
  if (!menuWindow) {
    return false;
  }

  if (artifactOverlayLoadPromises.versionMenu) {
    await artifactOverlayLoadPromises.versionMenu;
  }

  const localBounds = clampLocalBoundsToContent(parentWindow, options, {
    width: 220,
    height: 48,
  });
  const screenBounds = localBoundsToScreen(parentWindow, localBounds);
  if (!localBounds || !screenBounds) {
    return false;
  }

  artifactVersionMenuState.ownerWindowId = parentWindow.id;
  clearArtifactVersionMenuOwnerLifecycle();
  artifactVersionMenuState.ownerLifecycleCleanup = bindOwnerLifecycle(
    parentWindow,
    ['move', 'resize', 'minimize', 'closed'],
    () => hideArtifactVersionMenu({ notifyOwner: true, reason: 'parent-change' }),
  );

  menuWindow.webContents.send('artifact-version-menu-state', {
    theme: options.theme || 'dark',
    versions: Array.isArray(options.versions) ? options.versions : [],
    currentVersion: Number.isFinite(Number(options.currentVersion))
      ? Number(options.currentVersion)
      : null,
  });

  menuWindow.setBounds(screenBounds);
  if (typeof menuWindow.show === 'function') {
    menuWindow.show();
  }
  menuWindow.focus();
  return true;
}

function hideArtifactVersionMenu(options = {}) {
  const {
    destroy = false,
    notifyOwner = false,
    reason = 'dismiss',
  } = options;
  const menuWindow = state.windows.artifactVersionMenu;
  const ownerWindowId = artifactVersionMenuState.ownerWindowId;
  if (!menuWindow || menuWindow.isDestroyed()) {
    state.windows.artifactVersionMenu = null;
    artifactVersionMenuState.ownerWindowId = null;
    clearArtifactVersionMenuOwnerLifecycle();
    if (notifyOwner && ownerWindowId !== null) {
      sendArtifactVersionMenuOwnerEvent({ type: 'close', reason }, ownerWindowId);
    }
    return;
  }

  if (artifactVersionMenuState.isHiding) {
    return;
  }

  artifactVersionMenuState.isHiding = true;
  try {
    if (destroy) {
      menuWindow.destroy();
    } else {
      menuWindow.hide();
    }

    if (notifyOwner) {
      sendArtifactVersionMenuOwnerEvent({ type: 'close', reason });
    }
  } finally {
    artifactVersionMenuState.ownerWindowId = null;
    clearArtifactVersionMenuOwnerLifecycle();
    artifactVersionMenuState.isHiding = false;
  }
}

async function syncArtifactDividerOverlay(options = {}, parentWindow = state.windows.main) {
  const bounds = options?.bounds || null;
  if (!parentWindow || parentWindow.isDestroyed() || !bounds) {
    hideArtifactDividerOverlay({ notifyOwner: false, reason: 'hidden' });
    return { visible: false, dragging: artifactDividerOverlayState.dragActive };
  }

  const overlayWindow = ensureArtifactDividerOverlayWindow(parentWindow);
  if (!overlayWindow) {
    return { visible: false, dragging: artifactDividerOverlayState.dragActive };
  }

  if (artifactOverlayLoadPromises.dividerOverlay) {
    await artifactOverlayLoadPromises.dividerOverlay;
  }

  const localBounds = clampLocalBoundsToContent(parentWindow, bounds, {
    width: ARTIFACT_DIVIDER_OVERLAY_MIN_WIDTH,
    height: 24,
  });
  const screenBounds = localBoundsToScreen(parentWindow, localBounds);
  if (!localBounds || !screenBounds) {
    hideArtifactDividerOverlay({ notifyOwner: false, reason: 'hidden' });
    return { visible: false, dragging: artifactDividerOverlayState.dragActive };
  }

  artifactDividerOverlayState.ownerWindowId = parentWindow.id;
  artifactDividerOverlayState.handleBounds = localBounds;
  clearArtifactDividerOverlayOwnerLifecycle();
  artifactDividerOverlayState.ownerLifecycleCleanup =
    bindArtifactDividerOverlayOwnerLifecycle(parentWindow);

  if (!artifactDividerOverlayState.dragActive) {
    overlayWindow.setBounds(screenBounds);
    overlayWindow.webContents.send('artifact-divider-overlay-state', { dragging: false });
  }

  if (typeof overlayWindow.showInactive === 'function') {
    overlayWindow.showInactive();
  } else {
    overlayWindow.show();
  }

  return { visible: true, dragging: artifactDividerOverlayState.dragActive };
}

function hideArtifactDividerOverlay(options = {}) {
  const {
    destroy = false,
    notifyOwner = false,
    reason = 'hidden',
  } = options;
  const overlayWindow = state.windows.artifactDividerOverlay;
  const wasDragging = artifactDividerOverlayState.dragActive;
  const ownerWindowId = artifactDividerOverlayState.ownerWindowId;

  artifactDividerOverlayState.dragActive = false;
  artifactDividerOverlayState.handleBounds = null;
  artifactDividerOverlayState.ownerWindowId = null;
  clearArtifactDividerOverlayOwnerLifecycle();

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    state.windows.artifactDividerOverlay = null;
    if (notifyOwner && wasDragging && ownerWindowId !== null) {
      sendArtifactDividerOverlayOwnerEvent({ type: 'drag-cancel', reason }, ownerWindowId);
    }
    return;
  }

  if (destroy) {
    overlayWindow.destroy();
  } else {
    overlayWindow.hide();
  }

  if (notifyOwner && wasDragging && ownerWindowId !== null) {
    sendArtifactDividerOverlayOwnerEvent({ type: 'drag-cancel', reason }, ownerWindowId);
  }
}

function beginArtifactDividerDrag(payload = {}) {
  if (artifactDividerOverlayState.dragActive) {
    return false;
  }

  const ownerWindow = getManagedWindowById(artifactDividerOverlayState.ownerWindowId);
  const overlayWindow = state.windows.artifactDividerOverlay;
  if (!ownerWindow || !overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  artifactDividerOverlayState.dragActive = true;
  overlayWindow.setBounds(ownerWindow.getContentBounds());
  overlayWindow.webContents.send('artifact-divider-overlay-state', { dragging: true });
  sendArtifactDividerOverlayOwnerEvent({
    type: 'drag-start',
    screenX: Number.isFinite(Number(payload.screenX)) ? Number(payload.screenX) : null,
  });
  return true;
}

function updateArtifactDividerDrag(payload = {}) {
  if (!artifactDividerOverlayState.dragActive) {
    return false;
  }

  sendArtifactDividerOverlayOwnerEvent({
    type: 'drag-move',
    screenX: Number.isFinite(Number(payload.screenX)) ? Number(payload.screenX) : null,
  });
  return true;
}

function finishArtifactDividerDrag(payload = {}, options = {}) {
  if (!artifactDividerOverlayState.dragActive) {
    return false;
  }

  artifactDividerOverlayState.dragActive = false;
  const overlayWindow = state.windows.artifactDividerOverlay;
  const ownerWindow = getManagedWindowById(artifactDividerOverlayState.ownerWindowId);
  const screenX = Number.isFinite(Number(payload.screenX)) ? Number(payload.screenX) : null;
  const cancelled = Boolean(options.cancelled);

  sendArtifactDividerOverlayOwnerEvent({
    type: cancelled ? 'drag-cancel' : 'drag-end',
    reason: options.reason || null,
    screenX,
  });

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (artifactDividerOverlayState.handleBounds && ownerWindow) {
      const handleScreenBounds = localBoundsToScreen(ownerWindow, artifactDividerOverlayState.handleBounds);
      overlayWindow.setBounds(handleScreenBounds);
      overlayWindow.webContents.send('artifact-divider-overlay-state', { dragging: false });
      if (typeof overlayWindow.showInactive === 'function') {
        overlayWindow.showInactive();
      } else {
        overlayWindow.show();
      }
    } else {
      overlayWindow.hide();
    }
  }

  return true;
}

/**
 * Close the main window.
 * @returns {boolean} true when a close was requested
 */
function closeMainWindow(_options = {}) {
  const mainWindow = state.windows.main;

  if (!mainWindow || mainWindow.isDestroyed()) {
    state.windows.main = null;
    return false;
  }

  mainWindow.close();
  return true;
}

/**
 * Create chat window (legacy - now redirects to main window)
 */
function createChatWindow() {
  // Legacy chat window is unused; focus main window instead
  if (state.windows.main && !state.windows.main.isDestroyed()) {
    state.windows.main.focus();
    return;
  }

  // If main window is not available, recreate it
  createMainWindow();
}

/**
 * Create a detached conversation window (chat or subagent).
 */
// Focus an already-open detached conversation window (if any) for this
// conversation. Returns true when a live window was focused. Lets callers (e.g.
// the Cost Dashboard bar click) avoid double-opening a chat that's already a
// window. Mirrors the dedup in createConversationWindow.
function focusConversationWindowIfOpen(conversationId) {
  if (!conversationId) {
    return false;
  }
  const { conversationWindows } = state;
  const existing = conversationWindows.get(conversationId);
  if (existing?.window && !existing.window.isDestroyed()) {
    existing.window.focus();
    return true;
  }
  if (existing) {
    conversationWindows.delete(conversationId);
    updateWindowMenu();
  }
  return false;
}

async function createConversationWindow({ conversationId, url, title, windowType, viewKey, x, y }) {
  if (!conversationId || !url) {
    return { success: false, error: 'Missing conversationId or url' };
  }

  const { conversationWindows, windows } = state;
  const windowKind = windowType === 'chat' ? 'chat' : 'subagent';
  const isMac = process.platform === 'darwin';

  if (conversationWindows.has(conversationId)) {
    const existing = conversationWindows.get(conversationId);
    if (existing?.window && !existing.window.isDestroyed()) {
      existing.window.focus();
      return { success: true, windowId: existing.windowId, alreadyDetached: true };
    }
    conversationWindows.delete(conversationId);
    updateWindowMenu();
  }

  let currentTheme = state.appState.currentTheme || 'dark';
  if (!state.appState.currentTheme) {
    try {
      if (windows.main && !windows.main.isDestroyed()) {
        const detectedTheme = await safeExecuteJavaScript(
          windows.main,
          "document.documentElement.getAttribute('data-theme') || localStorage.getItem('theme') || 'dark'",
          {
            tag: 'conversation-theme-detect',
            meta: { conversationId, windowType: windowKind }
          },
        );
        if (typeof detectedTheme === 'string' && detectedTheme) {
          currentTheme = detectedTheme;
        }
      }
    } catch (error) {
      console.log('[Conversation] Could not detect theme, defaulting to dark');
    }
  }

  const backgroundColor = currentTheme === 'light' ? '#f7f7f7' : '#1e2324';

  try {
    const width = 1100;
    const height = 800;
    const detachedConversationTrafficLightPosition =
      getDetachedConversationMacTrafficLightPosition();
    const windowOptions = {
      width,
      height,
      minWidth: 720,
      minHeight: 520,
      title: title || 'Subagent',
      ...(isMac ? {
        titleBarStyle: 'hidden',
        trafficLightPosition: detachedConversationTrafficLightPosition,
      } : {}),
      backgroundColor,
      icon: getThemeIcon(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: PRELOAD_SCRIPT,
      },
    };
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      const dropPoint = {
        x: Math.round(Number(x)),
        y: Math.round(Number(y)),
      };
      const display = screen.getDisplayNearestPoint(dropPoint);
      const workArea = display?.workArea;
      if (workArea) {
        windowOptions.x = Math.max(
          workArea.x,
          Math.min(
            dropPoint.x - Math.round(width / 2),
            workArea.x + workArea.width - width,
          ),
        );
        windowOptions.y = Math.max(
          workArea.y,
          Math.min(
            dropPoint.y - 28,
            workArea.y + workArea.height - height,
          ),
        );
      }
    }

    const conversationWindow = new BrowserWindow(windowOptions);
    attachBrowserConsoleCapture(
      conversationWindow,
      `conversation:${conversationId || windowKind}`,
    );
    applyMacTrafficLightPosition(
      conversationWindow,
      detachedConversationTrafficLightPosition,
    );

    conversationWindows.set(conversationId, {
      windowId: conversationWindow.id,
      window: conversationWindow,
      url,
      title: title || 'Subagent',
      windowType: windowKind,
      viewKey: viewKey || '',
    });
    updateWindowMenu();

    conversationWindow.on('closed', () => {
      hideLocalFindOverlay({
        ownerWindowId: conversationWindow.id,
        destroy: true,
        notifyOwner: false,
        reason: 'conversation-closed',
      });
      owuiViews.destroyViewsForWindow(conversationWindow.id);
      conversationWindows.delete(conversationId);
      updateWindowMenu();
    });

    await loadAppPage(conversationWindow, 'conversation-window.html', {
      label: `Detached ${windowKind} conversation`,
      query: {
        conversationId,
        url,
        theme: currentTheme,
        title: title || 'Subagent',
        windowType: windowKind,
        viewKey: viewKey || '',
      },
    });

    return { success: true, windowId: conversationWindow.id };
  } catch (error) {
    console.error('[Conversation] Failed to detach:', error);
    return { success: false, error: error.message };
  }
}

function setDetachedConversationWindowTitle(windowId, nextTitle) {
  const normalizedWindowId = Number(windowId);
  if (!Number.isFinite(normalizedWindowId)) {
    return { success: false, error: 'Missing detached window id' };
  }

  const entry = Array.from(state.conversationWindows.values()).find((info) => {
    return info?.windowId === normalizedWindowId || info?.window?.id === normalizedWindowId;
  });
  if (!entry?.window || entry.window.isDestroyed()) {
    return { success: false, error: 'Detached window not found' };
  }

  const fallbackTitle = entry.windowType === 'chat' ? 'Chat' : 'Subagent';
  const title =
    typeof nextTitle === 'string' && nextTitle.trim() ? nextTitle.trim() : entry.title || fallbackTitle;

  entry.title = title;
  entry.window.setTitle(title);
  updateWindowMenu();

  return { success: true, title };
}

/**
 * Open a new chat window pointing at the Open WebUI home page.
 */
function openNewChatWindow() {
  const conversationId = `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return createConversationWindow({
    conversationId,
    url: OPEN_WEBUI_HOME_URL,
    title: 'Chat',
    windowType: 'chat',
  });
}

async function startMenuUpdateWorkflow(updateInfo, options = {}) {
  if (!deps.beginMenuUpdateWorkflow) {
    return {
      success: false,
      error: "Menu update workflow dependency not set",
    };
  }

  const trigger = options.trigger || "menu";
  const postPreparationAction = options.postPreparationAction || "prompt";

  return deps.beginMenuUpdateWorkflow(updateInfo, {
    trigger,
    postPreparationAction,
    forcePreparation: true,
  });
}

/**
 * Check for updates from menu and show dialog
 */
async function checkForUpdatesFromMenu() {
  if (!deps.checkForUpdates) {
    console.error('checkForUpdates dependency not set');
    return;
  }

  try {
    console.log('Checking for updates from menu...');

    // Run the update check
    const updateInfo = await deps.checkForUpdates();
    if (!updateInfo || updateInfo.error) {
      throw new Error(updateInfo?.error || 'Update check returned no result');
    }
    updateInfo.updateSource = 'cloudsmith';

    // Show dialog based on result
    if (updateInfo.error) {
      dialog.showMessageBox(state.windows.main, {
        type: 'error',
        title: 'Update Check Failed',
        message: 'Failed to check for updates',
        detail: updateInfo.error,
        buttons: ['OK'],
        icon: getThemeIcon()
      });
    } else if (updateInfo.updateAvailable) {
      const workflowResult = await startMenuUpdateWorkflow(updateInfo, {
        trigger: "check",
        postPreparationAction: "prompt",
      });
      if (!workflowResult?.success) {
        dialog.showMessageBox(state.windows.main, {
          type: "error",
          title: "Update Preparation Failed",
          message: "Could not start update preparation",
          detail: workflowResult?.error || "Unknown error",
          buttons: ["OK"],
          icon: getThemeIcon(),
        });
      }
    } else {
      // No update available
      dialog.showMessageBox(state.windows.main, {
        type: 'info',
        title: 'No Updates Available',
        message: 'You are running the latest version',
        detail: `Current version: ${updateInfo.currentBuildNumber || 'unknown'}`,
        buttons: ['OK'],
        icon: getThemeIcon()
      });
    }
  } catch (error) {
    console.error('Failed to check for updates from menu:', error);
    dialog.showMessageBox(state.windows.main, {
      type: 'error',
      title: 'Update Check Failed',
      message: 'Failed to check for updates',
      detail: error.message,
      buttons: ['OK'],
      icon: getThemeIcon()
    });
  }
}

/**
 * Reinstall the latest available build from the current release channel
 */
async function reinstallLatestBuildFromMenu() {
  if (!deps.checkForUpdates) {
    console.error('checkForUpdates dependency not set');
    return;
  }

  try {
    console.log('Fetching latest build for reinstall...');
    const updateInfo = await deps.checkForUpdates();
    updateInfo.updateSource = 'cloudsmith';

    if (updateInfo.error) {
      dialog.showMessageBox(state.windows.main, {
        type: 'error',
        title: 'Reinstall Failed',
        message: 'Failed to fetch latest build',
        detail: updateInfo.error,
        buttons: ['OK'],
        icon: getThemeIcon()
      });
      return;
    }

    if (!updateInfo.downloadUrl || !updateInfo.latestBuildNumber) {
      dialog.showMessageBox(state.windows.main, {
        type: 'error',
        title: 'No Build Available',
        message: 'No build available to reinstall',
        detail: 'Could not find a valid build in the current release channel.',
        buttons: ['OK'],
        icon: getThemeIcon()
      });
      return;
    }

    const workflowResult = await startMenuUpdateWorkflow(updateInfo, {
      trigger: "reinstall",
      postPreparationAction: "auto-install",
    });
    if (!workflowResult?.success) {
      dialog.showMessageBox(state.windows.main, {
        type: "error",
        title: "Reinstall Failed",
        message: "Could not start reinstall preparation",
        detail: workflowResult?.error || "Unknown error",
        buttons: ["OK"],
        icon: getThemeIcon(),
      });
    }
  } catch (error) {
    console.error('Reinstall failed:', error);
    dialog.showMessageBox(state.windows.main, {
      type: 'error',
      title: 'Reinstall Failed',
      message: 'Failed to reinstall',
      detail: error.message,
      buttons: ['OK'],
      icon: getThemeIcon()
    });
  }
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showBuildIdPrompt({ channelLabel }) {
  return new Promise((resolve) => {
    const parent = state.windows.main && !state.windows.main.isDestroyed()
      ? state.windows.main
      : null;
    const promptWindow = new BrowserWindow({
      width: 520,
      height: 230,
      minWidth: 520,
      minHeight: 230,
      maxWidth: 640,
      maxHeight: 260,
      title: 'Install Specific Build',
      parent,
      modal: Boolean(parent),
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f7f7f7',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    try {
      promptWindow.setMenu(null);
    } catch (_) {
      // setMenu is unavailable on some platforms/Electron versions.
    }

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.destroy();
      }
    };

    const handlePromptNavigation = (event, navigationUrl) => {
      if (!navigationUrl || !navigationUrl.startsWith('portico-prompt://')) {
        return;
      }

      event.preventDefault();
      try {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.hostname === 'submit') {
          settle(parsedUrl.searchParams.get('value') || '');
        } else {
          settle(null);
        }
      } catch (_) {
        settle(null);
      }
    };

    promptWindow.webContents.on('will-navigate', handlePromptNavigation);
    promptWindow.webContents.on('will-redirect', handlePromptNavigation);
    promptWindow.once('closed', () => settle(null));
    promptWindow.once('ready-to-show', () => {
      if (!promptWindow.isDestroyed()) {
        promptWindow.show();
      }
    });

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install Specific Build</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 22px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
    .hint { font-size: 12px; opacity: 0.72; margin: 8px 0 18px; }
    input {
      box-sizing: border-box;
      width: 100%;
      padding: 9px 10px;
      border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
      border-radius: 7px;
      font-size: 14px;
      background: Canvas;
      color: CanvasText;
    }
    input:focus { outline: 3px solid color-mix(in srgb, Highlight 30%, transparent); border-color: Highlight; }
    .buttons { display: flex; justify-content: flex-end; gap: 10px; }
    button {
      min-width: 88px;
      border: 0;
      border-radius: 7px;
      padding: 8px 14px;
      font-size: 13px;
      color: ButtonText;
      background: ButtonFace;
    }
    button.primary { color: #fff; background: #0a84ff; }
  </style>
</head>
<body>
  <form id="build-form">
    <label for="build-id">Enter build ID (format: MMDDYYYY-xxxxxxxx):</label>
    <input id="build-id" name="build-id" type="text" placeholder="06232026-6021925b" autocomplete="off" autofocus>
    <div class="hint">Current release channel: ${htmlEscape(channelLabel)}</div>
    <div class="buttons">
      <button id="cancel" type="button">Cancel</button>
      <button class="primary" type="submit">Install</button>
    </div>
  </form>
  <script>
    const input = document.getElementById('build-id');
    const submit = (value) => {
      window.location.href = 'portico-prompt://submit?value=' + encodeURIComponent(value || '');
    };
    const cancel = () => {
      window.location.href = 'portico-prompt://cancel';
    };
    document.getElementById('build-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submit(input.value);
    });
    document.getElementById('cancel').addEventListener('click', cancel);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancel();
    });
    setTimeout(() => input.focus(), 0);
  </script>
</body>
</html>`;

    promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

function showReleaseChannelPromptOnce({ initialValue = '' } = {}) {
  return new Promise((resolve) => {
    const parent = state.windows.main && !state.windows.main.isDestroyed()
      ? state.windows.main
      : null;
    const promptWindow = new BrowserWindow({
      width: 540,
      height: 270,
      minWidth: 540,
      minHeight: 270,
      maxWidth: 680,
      maxHeight: 300,
      title: 'Custom Release Channel',
      parent,
      modal: Boolean(parent),
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f7f7f7',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    try {
      promptWindow.setMenu(null);
    } catch (_) {
      // setMenu is unavailable on some platforms/Electron versions.
    }

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.destroy();
      }
    };

    const handlePromptNavigation = (event, navigationUrl) => {
      if (!navigationUrl || !navigationUrl.startsWith('portico-channel-prompt://')) {
        return;
      }

      event.preventDefault();
      try {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.hostname === 'submit') {
          settle(parsedUrl.searchParams.get('value') || '');
        } else {
          settle(null);
        }
      } catch (_) {
        settle(null);
      }
    };

    promptWindow.webContents.on('will-navigate', handlePromptNavigation);
    promptWindow.webContents.on('will-redirect', handlePromptNavigation);
    promptWindow.once('closed', () => settle(null));
    promptWindow.once('ready-to-show', () => {
      if (!promptWindow.isDestroyed()) {
        promptWindow.show();
      }
    });

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Custom Release Channel</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 22px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
    .hint { font-size: 12px; line-height: 1.4; opacity: 0.72; margin: 8px 0 18px; }
    input {
      box-sizing: border-box;
      width: 100%;
      padding: 9px 10px;
      border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
      border-radius: 7px;
      font-size: 14px;
      background: Canvas;
      color: CanvasText;
    }
    input:focus { outline: 3px solid color-mix(in srgb, Highlight 30%, transparent); border-color: Highlight; }
    .buttons { display: flex; justify-content: flex-end; gap: 10px; }
    button {
      min-width: 88px;
      border: 0;
      border-radius: 7px;
      padding: 8px 14px;
      font-size: 13px;
      color: ButtonText;
      background: ButtonFace;
    }
    button.primary { color: #fff; background: #0a84ff; }
  </style>
</head>
<body>
  <form id="channel-form">
    <label for="channel-name">Release channel name:</label>
    <input id="channel-name" name="channel-name" type="text" value="${htmlEscape(initialValue)}" placeholder="team-alpha" autocomplete="off" autofocus>
    <div class="hint">Use 1–64 lowercase letters, numbers, hyphens, or underscores. Start and end with a letter or number.</div>
    <div class="buttons">
      <button id="cancel" type="button">Cancel</button>
      <button class="primary" type="submit">Use Channel</button>
    </div>
  </form>
  <script>
    const input = document.getElementById('channel-name');
    const submit = (value) => {
      window.location.href = 'portico-channel-prompt://submit?value=' + encodeURIComponent(value || '');
    };
    const cancel = () => {
      window.location.href = 'portico-channel-prompt://cancel';
    };
    document.getElementById('channel-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submit(input.value);
    });
    document.getElementById('cancel').addEventListener('click', cancel);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancel();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  </script>
</body>
</html>`;

    promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

async function showReleaseChannelPrompt({ initialValue = '' } = {}) {
  let nextInitialValue = initialValue;
  while (true) {
    const value = await showReleaseChannelPromptOnce({ initialValue: nextInitialValue });
    if (value === null) {
      return null;
    }

    const validation = validateCustomReleaseChannelName(value);
    if (validation.valid) {
      return validation.name;
    }

    const parent = state.windows.main && !state.windows.main.isDestroyed()
      ? state.windows.main
      : null;
    const options = {
      type: 'error',
      title: 'Invalid Release Channel',
      message: 'Enter a valid custom release channel',
      detail: validation.error,
      buttons: ['OK'],
      icon: getThemeIcon(),
    };
    if (parent) {
      await dialog.showMessageBox(parent, options);
    } else {
      await dialog.showMessageBox(options);
    }
    nextInitialValue = value;
  }
}

/**
 * Install a specific build by ID from the current release channel
 */
async function installSpecificBuildFromMenu() {
  const channelLabel = getCurrentChannelLabel();

  if (!deps.findSpecificBuild) {
    console.error('findSpecificBuild dependency not set');
    return;
  }

  try {
    // Show input prompt for build ID
    const buildId = await showBuildIdPrompt({ channelLabel });

    // User cancelled
    if (buildId === null) {
      console.log('[Install Specific] User cancelled input');
      return;
    }

    // Validate and trim input
    const trimmedBuildId = buildId.trim();
    if (!trimmedBuildId) {
      dialog.showMessageBox(state.windows.main, {
        type: 'error',
        title: 'Invalid Input',
        message: 'Please enter a build ID',
        detail: 'The build ID field cannot be empty.',
        buttons: ['OK'],
        icon: getThemeIcon()
      });
      return;
    }

    console.log(`[Install Specific] Searching for build: ${trimmedBuildId}`);

    // Search for the build
    const buildInfo = await deps.findSpecificBuild(trimmedBuildId);

    if (!buildInfo.found) {
      // Show error with helpful message
      dialog.showMessageBox(state.windows.main, {
        type: 'error',
        title: 'Build Not Found',
        message: `Could not find build: ${trimmedBuildId}`,
        detail: `${buildInfo.error || 'The build could not be found.'}\n\nThe build must exist in your current release channel.\n\nYour current release channel: ${channelLabel}\n\nTo change your release channel, go to:\nPortico → Switch Release Channel`,
        buttons: ['OK'],
        icon: getThemeIcon()
      });
      return;
    }

    const workflowResult = await startMenuUpdateWorkflow(buildInfo, {
      trigger: "specific",
      postPreparationAction: "auto-install",
    });
    if (!workflowResult?.success) {
      dialog.showMessageBox(state.windows.main, {
        type: "error",
        title: "Installation Failed",
        message: "Could not start build preparation",
        detail: workflowResult?.error || "Unknown error",
        buttons: ["OK"],
        icon: getThemeIcon(),
      });
    }
  } catch (error) {
    console.error('Install specific build failed:', error);
    dialog.showMessageBox(state.windows.main, {
      type: 'error',
      title: 'Installation Failed',
      message: 'Failed to install build',
      detail: error.message,
      buttons: ['OK'],
      icon: getThemeIcon()
    });
  }
}

/**
 * Send message to loading window (if it exists)
 * @param {string} channel - IPC channel name
 * @param {any} data - Data to send
 */
function sendToLoadingWindow(channel, data) {
  if (state.windows.loading && !state.windows.loading.isDestroyed()) {
    safeWebContentsSend(state.windows.loading, channel, data, {
      tag: 'loading-window-send',
      meta: { channel }
    });
  }
}

/**
 * Send message to main window (if it exists)
 * @param {string} channel - IPC channel name
 * @param {any} data - Data to send
 */
function sendToMainWindow(channel, data) {
  if (state.windows.main && !state.windows.main.isDestroyed()) {
    safeWebContentsSend(state.windows.main, channel, data, {
      tag: 'main-window-send',
      meta: { channel }
    });
  }
}

/**
 * Send message to chat window (if it exists)
 * @param {string} channel - IPC channel name
 * @param {any} data - Data to send
 */
function sendToChatWindow(channel, data) {
  if (state.windows.chat && !state.windows.chat.isDestroyed()) {
    safeWebContentsSend(state.windows.chat, channel, data, {
      tag: 'chat-window-send',
      meta: { channel }
    });
  }
}

/**
 * Send message to all windows
 * @param {string} channel - IPC channel name
 * @param {any} data - Data to send
 */
function sendToAllWindows(channel, data) {
  BrowserWindow.getAllWindows().forEach(window => {
    if (!window.isDestroyed()) {
      safeWebContentsSend(window, channel, data, {
        tag: 'broadcast-send',
        meta: { channel, targetWindowId: window.id }
      });
    }
  });
}

/**
 * Get window references (for backward compatibility)
 */
function getWindows() {
  return {
    main: state.windows.main,
    chat: state.windows.chat,
    loading: state.windows.loading,
    guidedSetup: state.windows.guidedSetup
  };
}

/**
 * Listen for theme changes and update window icons
 */
function setupThemeListener() {
  nativeTheme.on('updated', () => {
    console.log('System theme changed, updating icons...');
    updateAllWindowIcons();
  });
}

// Export all window functions
module.exports = {
  // Dependency injection
  setDependencies,

  // Window creation
  createGuidedSetupWindow,
  createLoadingWindow,
  setLoadingWindowLogsDrawerOpen,
  createMainWindow,
  createChatWindow,
  createConversationWindow,
  focusConversationWindowIfOpen,
  setDetachedConversationWindowTitle,
  openNewChatWindow,
  closeMainWindow,

  // Window helpers
  checkForUpdatesFromMenu,
  reinstallLatestBuildFromMenu,
  installSpecificBuildFromMenu,
  showReleaseChannelPrompt,
  checkSetupWizardNeeded,
  getSetupLaunchDecision,
  isFirstRun,
  resetConfigData,

  // Messaging helpers
  sendToLoadingWindow,
  sendToMainWindow,
  sendToChatWindow,
  sendToAllWindows,

  // Accessors
  getWindows,
  setMacTrafficLightPosition,
  showMcpTooltip,
  hideMcpTooltip,
  showUpdatePrepTooltip,
  hideUpdatePrepTooltip,
  showArtifactVersionMenu,
  hideArtifactVersionMenu,
  syncArtifactDividerOverlay,
  hideArtifactDividerOverlay,
  forwardArtifactDividerOverlayHover,
  beginArtifactDividerDrag,
  updateArtifactDividerDrag,
  finishArtifactDividerDrag,
  syncLocalFindOverlay,
  hideLocalFindOverlay,
  getLocalFindOverlayOwnerWindow,
  resolveLocalFindOwnerWindow,

  // Theme
  setupThemeListener
};
