// Guided Setup Entry Point
// Orchestrates all modules for the setup wizard
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

console.log('[guided-setup.js] ===== ORCHESTRATOR LOADING =====');

// Import services
const { setupState, getSetupState, setCurrentStage, setEnvVar, addConfiguredServer, addSkippedServer, setOnboardingMode } = require('../../services/guided-setup/setup-state');
const {
  getHydratedGuidedSetupSelectionIndices,
  getSelectedServerIdsFromIndices,
  getSelectedServerIndicesFromIds,
  isGuidedSetupSelectableServer,
  preserveGuidedSetupToggleState,
  recordGuidedSetupToggleChange,
  setGuidedSetupToggleBaseline,
} = require('../../services/guided-setup/server-selection-state');
const {
  getGuidedSetupDescription,
  getRequiredEnvVars,
  serverRequiresConfig,
} = require('../../services/guided-setup/server-requirements');
const { getGuidedSetupStageWindowOptions } = require('./guided-setup-stage-window');
const envManager = require('../../services/guided-setup/setup-env-manager');
const { parseMarkdownContent, substituteVariables } = require('../../services/guided-setup/setup-markdown-parser');

// Import utils
const { validateEnvValue, validateInputField, validateAllInputs } = require('../../utils/setup-validation');

// Import components
const { updateProgressTracker, isStepAccessible, toggleProgressVisibility } = require('../components/setup-progress');
const { createServerCard, selectServerCard, deselectServerCard, addConfiguredCheckmark, createHostWarning } = require('../components/setup-server-card');
const { createServerNavigation, updateServerNavigation, showServerNavContainer, hideServerNavContainer } = require('../components/setup-server-nav');
const { showBrowser: _showBrowser, hideBrowser: _hideBrowser, loadBrowserUrl, openExternalUrl, setupWebview, setupResizeHandle } = require('../components/setup-browser');
const { createInitialAccordions, markAccordionsAsCompleted, createAccordionSection, toggleAccordion, createAccordionsForVisibleContent } = require('../components/setup-accordion');
const { generateConfirmationCard, handleConfirmationYes: _handleConfirmationYes, handleConfirmationNo: _handleConfirmationNo, createWindowHandlers } = require('../components/setup-confirmation');
const { copyToClipboard, setupClipboardShortcuts } = require('../components/setup-copy');
require('../components/log-viewer-modal');

// Import screens
// NOTE: All screen functions renamed with underscore prefix to avoid shadowing window.* in onclick handlers
// In Electron with nodeIntegration, const declarations can shadow window properties in onclick handlers
console.log('[guided-setup.js] About to import screen modules...');
const { populateServerGrid: _populateServerGrid, toggleServerSelection: _toggleServerSelection, updateProceedButton: _updateProceedButton, updateSelectAllButtons: _updateSelectAllButtons, selectAllServers: _selectAllServers, selectAllUnconfigured: _selectAllUnconfigured, selectAllConfigured: _selectAllConfigured, skipServerSelection: _skipServerSelection, proceedToConfiguration: _proceedToConfiguration } = require('../screens/guided-setup/screen-server-selection');
const { loadServerConfiguration: _loadServerConfiguration, parseSetupMarkdown: _parseSetupMarkdown, generateConfigForm: _generateConfigForm, saveAndContinue: _saveAndContinue, skipServer: _skipServer, skipAllServers: _skipAllServers, previousServer: _previousServer, jumpToServer: _jumpToServer, handleSaveAndContinue: _handleSaveAndContinue, handleSkipServer: _handleSkipServer, handleSkipAllServers: _handleSkipAllServers, refreshConfigurationGuidance: _refreshConfigurationGuidance, handleConfigurationAccordionToggle: _handleConfigurationAccordionToggle, getNextPendingConfigurationIndex: _getNextPendingConfigurationIndex } = require('../screens/guided-setup/screen-configuration');
const { finalizeSetup: _finalizeSetup, generateEnvFile: _generateFinalEnvFile, generateMcpConfig: _generateMcpConfig } = require('../screens/guided-setup/screen-finalize');
const { launchApp: _launchApp } = require('../screens/guided-setup/screen-success');
const { analyzeOAuthServers: _analyzeOAuthServers, loadOAuthScreen: _loadOAuthScreen, proceedAfterOAuth: _proceedAfterOAuth } = require('../screens/guided-setup/screen-oauth');
const { selectAllOAuth: _selectAllOAuth, selectAllConfig: _selectAllConfig, selectAllReady: _selectAllReady } = require('../screens/guided-setup/screen-server-selection');
const {
  loadPrerequisitesScreen: _loadPrerequisitesScreen,
  bootstrapPrerequisitesSession: _bootstrapPrerequisitesSession,
  cleanupListeners: _cleanupPrerequisitesListeners,
  retryPrerequisites: _retryPrerequisites,
  getPrereqDebugSections: _getPrereqDebugSections,
  simulatePrerequisitesErrorState: _simulatePrerequisitesErrorState,
  clearSimulatedPrerequisitesErrorState: _clearSimulatedPrerequisitesErrorState,
} = require('../screens/guided-setup/screen-prerequisites');
const { loadVpnCheckScreen: _loadVpnCheckScreen, runVpnCheck: _runVpnCheck } = require('../screens/guided-setup/screen-vpn-check');
console.log('[guided-setup.js] Screen modules imported');

// Get project root from main process
let PROJECT_ROOT = null;
let setupAuthFlowInProgress = false;
let authenticatedSetupSession = null;
let helloModeSelectionInProgress = false;
const GUIDED_SETUP_DEBUG_MAX_ENTRIES = 1200;
const GUIDED_SETUP_DEBUG_SECTION_ORDER = ['setup-timeline', 'prerequisites', 'authorization', 'configuration', 'finalize'];
const guidedSetupDebugState = {
  entries: [],
  drawerOpen: false,
  refreshTimer: null,
  collecting: false,
  refreshing: false,
  lastDocument: '',
  simulatedPrereqRestore: null,
};

const BASIC_CURATED_SERVER_IDS = Object.freeze([
  'mcp-atlassian',
  'data-plat-mcp',
  'glean',
  'google_workspace',
  'slack',
]);
const { isContractorEmail, CONTRACTOR_EMAIL_SUFFIX } = require('../../services/user-identity');
const CONTRACTOR_GUIDED_SETUP_DISABLED_SERVER_ID = 'data-plat-mcp';
const CONTRACTOR_GUIDED_SETUP_DISABLED_TOOLTIP = 'Unavailable during guided setup for contractor accounts. You can enable it later from Control Plane after access is granted.';

const GUIDED_SETUP_DEBUG_SECTION_TITLES = Object.freeze({
  'setup-timeline': 'Setup Timeline',
  prerequisites: 'Prerequisites',
  authorization: 'Authorization',
  configuration: 'Configuration',
  finalize: 'Finalize'
});
const GUIDED_SETUP_DEBUG_PREREQ_ERROR_STATES = Object.freeze([
  { id: 'guided-setup-debug-force-error-generic', state: 'generic' },
  { id: 'guided-setup-debug-force-error-homebrew-auth-dialog-cancelled', state: 'homebrew_auth_dialog_cancelled' },
  { id: 'guided-setup-debug-force-error-homebrew-sudo-validation-failed', state: 'homebrew_sudo_validation_failed' },
  { id: 'guided-setup-debug-force-error-homebrew-admin-required', state: 'homebrew_admin_required' },
  { id: 'guided-setup-debug-force-error-homebrew-osascript-probe-failed', state: 'homebrew_osascript_probe_failed' },
  { id: 'guided-setup-debug-force-error-homebrew-outdated', state: 'homebrew_outdated' },
  { id: 'guided-setup-debug-force-error-orbstack-stale-artifact-conflict', state: 'orbstack_stale_artifact_conflict' },
  { id: 'guided-setup-debug-force-error-orbstack-cask-xattr-conflict', state: 'orbstack_cask_xattr_conflict' },
  { id: 'guided-setup-debug-force-error-orbstack-manual-recovery-required', state: 'orbstack_manual_recovery_required' },
  { id: 'guided-setup-debug-force-error-docker-pull-recovery-required', state: 'docker_pull_recovery_required' },
]);
const HELLO_LOGO_ASSET_BASE = '../assets/hello-logos';
const GUIDED_SETUP_WINDOW_DEFAULT_WIDTH = 1180;
const GUIDED_SETUP_WINDOW_DEFAULT_HEIGHT = 820;

function escapeDebugHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDebugTimestamp(timestamp) {
  try {
    return new Date(timestamp || Date.now()).toLocaleTimeString();
  } catch (_error) {
    return '--:--:--';
  }
}

function getGuidedSetupDebugBucket(stageName = setupState.currentStage) {
  switch (stageName) {
    case 'prerequisites':
    case 'vpn-check':
      return 'prerequisites';
    case 'oauth':
      return 'authorization';
    case 'configuration':
      return 'configuration';
    case 'finalize':
    case 'success':
      return 'finalize';
    default:
      return 'setup-timeline';
  }
}

function recordGuidedSetupDebugEntry(text, type = 'info', stageName = setupState.currentStage) {
  const entry = {
    text: String(text ?? ''),
    type,
    timestamp: Date.now(),
    bucket: getGuidedSetupDebugBucket(stageName)
  };

  guidedSetupDebugState.entries.push(entry);
  while (guidedSetupDebugState.entries.length > GUIDED_SETUP_DEBUG_MAX_ENTRIES) {
    guidedSetupDebugState.entries.shift();
  }

  if (guidedSetupDebugState.drawerOpen) {
    scheduleGuidedSetupDebugRefresh();
  }
}

function formatGuidedSetupDebugEntry(entry) {
  return `[${formatDebugTimestamp(entry.timestamp)}] [${String(entry.type || 'info').toUpperCase()}] ${entry.text}`;
}

function buildGuidedSetupTimelineSections() {
  const grouped = new Map(GUIDED_SETUP_DEBUG_SECTION_ORDER.map((key) => [key, []]));
  guidedSetupDebugState.entries.forEach((entry) => {
    const bucket = GUIDED_SETUP_DEBUG_SECTION_ORDER.includes(entry.bucket)
      ? entry.bucket
      : 'setup-timeline';
    grouped.get(bucket).push(entry);
  });

  return GUIDED_SETUP_DEBUG_SECTION_ORDER
    .map((bucket) => {
      const entries = grouped.get(bucket) || [];
      if (entries.length === 0) return null;
      return {
        id: `timeline-${bucket}`,
        title: GUIDED_SETUP_DEBUG_SECTION_TITLES[bucket] || 'Setup Timeline',
        meta: 'Renderer timeline',
        content: entries.map(formatGuidedSetupDebugEntry).join('\n')
      };
    })
    .filter(Boolean);
}

async function getOAuthDebugSections() {
  if (!window.electronAPI?.getWizardMcpServerLogs || !Array.isArray(setupState.oauthServers)) {
    return [];
  }

  const uniqueServers = [...new Map(
    setupState.oauthServers
      .filter((server) => server?.id)
      .map((server) => [server.id, server])
  ).values()];

  if (uniqueServers.length === 0) {
    return [];
  }

  const results = await Promise.all(uniqueServers.map(async (server) => {
    try {
      const logsResult = await window.electronAPI.getWizardMcpServerLogs(server.id, 100);
      const content = typeof logsResult?.logs === 'string' ? logsResult.logs.trim() : '';
      if (!content) return null;
      return {
        id: `authorization-container-${server.id}`,
        title: `Authorization · ${server.display_name || server.name || server.id}`,
        meta: 'Single-server runtime',
        content
      };
    } catch (_error) {
      return null;
    }
  }));

  return results.filter(Boolean);
}

function getGuidedSetupDebugElements() {
  return {
    toggle: document.getElementById('guided-setup-debug-toggle'),
    scrim: document.getElementById('guided-setup-debug-scrim'),
    drawer: document.getElementById('guided-setup-debug-drawer'),
    close: document.getElementById('guided-setup-debug-close'),
    copy: document.getElementById('guided-setup-debug-copy-btn'),
    collect: document.getElementById('guided-setup-debug-collect-btn'),
    testPanel: document.getElementById('guided-setup-debug-test-panel'),
    clearSimulatedError: document.getElementById('guided-setup-debug-clear-error-state'),
    status: document.getElementById('guided-setup-debug-status'),
    body: document.getElementById('guided-setup-debug-body'),
    overlay: document.getElementById('guided-setup-debug-overlay')
  };
}

function isGuidedSetupDevBuild() {
  return setupState.isDevBuild === true;
}

function setGuidedSetupDebugTestPanelVisible(visible) {
  const { testPanel } = getGuidedSetupDebugElements();
  if (!testPanel) {
    return;
  }

  const shouldShow = Boolean(visible);
  testPanel.hidden = !shouldShow;
  testPanel.style.display = shouldShow ? '' : 'none';
  if (shouldShow) {
    testPanel.setAttribute('aria-hidden', 'false');
  } else {
    testPanel.setAttribute('aria-hidden', 'true');
  }
}

function syncGuidedSetupDebugTestPanelVisibility() {
  const visible = isGuidedSetupDevBuild();
  setGuidedSetupDebugTestPanelVisible(visible);
  return visible;
}

async function resolveGuidedSetupDevBuildState() {
  let isDevBuild = false;
  try {
    const getBuildInfo = window.electronAPI?.getBuildInfo;
    if (typeof getBuildInfo === 'function') {
      const buildInfo = await getBuildInfo.call(window.electronAPI);
      isDevBuild = buildInfo?.buildNumber === 'dev-build';
    }
  } catch (_error) {
    isDevBuild = false;
  }

  setupState.isDevBuild = isDevBuild;
  setGuidedSetupDebugTestPanelVisible(isDevBuild);
  return isDevBuild;
}

function setGuidedSetupDebugStatus(message, kind = 'info') {
  const { status } = getGuidedSetupDebugElements();
  if (!status) return;

  if (!message) {
    status.style.display = 'none';
    status.textContent = '';
    status.classList.remove('error');
    return;
  }

  status.textContent = message;
  status.style.display = 'block';
  status.classList.toggle('error', kind === 'error');
}

function renderGuidedSetupDebugSections(sections) {
  const { body } = getGuidedSetupDebugElements();
  if (!body) return;

  if (!Array.isArray(sections) || sections.length === 0) {
    body.innerHTML = '<div class="guided-setup-debug-empty">Detailed guided setup logs will appear here.</div>';
    return;
  }

  body.innerHTML = sections.map((section) => `
    <section class="guided-setup-debug-section">
      <div class="guided-setup-debug-section-header">
        <div class="guided-setup-debug-section-title">${escapeDebugHtml(section.title || 'Logs')}</div>
        <div class="guided-setup-debug-section-meta">${escapeDebugHtml(section.meta || 'Guided setup')}</div>
      </div>
      <pre class="guided-setup-debug-section-body">${escapeDebugHtml(section.content || '')}</pre>
    </section>
  `).join('');
}

async function buildGuidedSetupDebugSections() {
  const sections = [
    ...buildGuidedSetupTimelineSections(),
    ...(_getPrereqDebugSections?.() || []),
    ...(await getOAuthDebugSections())
  ];

  if (window.electronAPI?.getGuidedSetupDebugSections) {
    try {
      const runtimeResult = await window.electronAPI.getGuidedSetupDebugSections();
      if (runtimeResult?.success && Array.isArray(runtimeResult.sections)) {
        sections.push(...runtimeResult.sections);
      }
    } catch (error) {
      sections.push({
        id: 'runtime-log-error',
        title: 'System / Runtime',
        meta: 'Guided setup debug',
        content: `Failed to gather runtime logs: ${error.message}`
      });
    }
  }

  return sections.filter((section) => section && section.content && section.content.trim().length > 0);
}

function buildGuidedSetupDebugDocument(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return 'Guided Setup Debug\n\nNo logs were captured yet.';
  }

  return [
    'Guided Setup Debug',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    ...sections.flatMap((section) => [
      `=== ${section.title || 'Logs'} ===`,
      section.meta ? `${section.meta}` : '',
      section.content || '',
      ''
    ])
  ].join('\n');
}

async function refreshGuidedSetupDebugDrawer() {
  if (guidedSetupDebugState.refreshing) {
    return guidedSetupDebugState.lastDocument;
  }

  guidedSetupDebugState.refreshing = true;
  try {
    const sections = await buildGuidedSetupDebugSections();
    guidedSetupDebugState.lastDocument = buildGuidedSetupDebugDocument(sections);
    renderGuidedSetupDebugSections(sections);
    return guidedSetupDebugState.lastDocument;
  } catch (error) {
    setGuidedSetupDebugStatus(`Failed to load debug logs: ${error.message}`, 'error');
    return guidedSetupDebugState.lastDocument;
  } finally {
    guidedSetupDebugState.refreshing = false;
  }
}

function scheduleGuidedSetupDebugRefresh() {
  clearTimeout(guidedSetupDebugState.refreshTimer);
  guidedSetupDebugState.refreshTimer = setTimeout(() => {
    if (guidedSetupDebugState.drawerOpen) {
      refreshGuidedSetupDebugDrawer();
    }
  }, 120);
}

function showGuidedSetupDebugDrawer(options = {}) {
  const { scrim, drawer } = getGuidedSetupDebugElements();
  if (!scrim || !drawer) return;

  guidedSetupDebugState.drawerOpen = true;
  scrim.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');

  if (options.refresh !== false) {
    refreshGuidedSetupDebugDrawer();
  }
}

function hideGuidedSetupDebugDrawer() {
  const { scrim, drawer } = getGuidedSetupDebugElements();
  if (!scrim || !drawer) return;

  guidedSetupDebugState.drawerOpen = false;
  scrim.classList.remove('open');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
}

async function copyGuidedSetupDebugLogs() {
  const documentText = guidedSetupDebugState.lastDocument || await refreshGuidedSetupDebugDrawer();
  if (!documentText) {
    setGuidedSetupDebugStatus('No logs are available yet.', 'error');
    return;
  }

  if (window.electronAPI?.copyToClipboard) {
    await window.electronAPI.copyToClipboard(documentText);
    setGuidedSetupDebugStatus('Copied all guided setup logs to your clipboard.');
  }
}

async function collectGuidedSetupDebugInfo() {
  if (guidedSetupDebugState.collecting) {
    return { success: false, error: 'Debug collection already in progress.' };
  }

  const { overlay } = getGuidedSetupDebugElements();
  guidedSetupDebugState.collecting = true;
  if (overlay) {
    overlay.classList.add('visible');
  }

  try {
    const documentText = guidedSetupDebugState.lastDocument || await refreshGuidedSetupDebugDrawer();
    if (documentText && window.electronAPI?.saveControlPaneLogs) {
      await window.electronAPI.saveControlPaneLogs(documentText);
    }

    const result = await window.electronAPI.collectDebugInfo();
    if (result?.success) {
      setGuidedSetupDebugStatus(
        result.zipFile
          ? `Debug information collected: ${result.zipFile}`
          : 'Debug information collected successfully.'
      );
    } else {
      setGuidedSetupDebugStatus(`Failed to collect debug information: ${result?.error || 'Unknown error'}`, 'error');
    }
    return result;
  } catch (error) {
    setGuidedSetupDebugStatus(`Failed to collect debug information: ${error.message}`, 'error');
    return { success: false, error: error.message };
  } finally {
    guidedSetupDebugState.collecting = false;
    if (overlay) {
      overlay.classList.remove('visible');
    }
  }
}

async function forceGuidedSetupPrereqErrorState(errorState) {
  if (!isGuidedSetupDevBuild()) {
    throw new Error('Prerequisite error simulation is only available in dev builds.');
  }

  if (typeof _simulatePrerequisitesErrorState !== 'function') {
    throw new Error('Prerequisite error simulation is unavailable.');
  }

  if (!guidedSetupDebugState.simulatedPrereqRestore) {
    guidedSetupDebugState.simulatedPrereqRestore = {
      currentStage: setupState.currentStage || 'welcome',
      prereqPolicy: setupState.prereqPolicy ? { ...setupState.prereqPolicy } : null,
      skipPrerequisites: setupState.skipPrerequisites,
      completedPrerequisites: Boolean(setupState.completedSteps?.prerequisites),
      prerequisitesWarning: Boolean(setupState.completedSteps?.prerequisitesWarning),
      prerequisitesManualVisit: Boolean(setupState.prerequisitesManualVisit),
    };
  }

  setupState.prereqPolicy = {
    ...(setupState.prereqPolicy || {}),
    showStep: true,
    noInteractiveWorkRequired: false,
    reason: 'debug-simulated-error',
  };
  setupState.skipPrerequisites = false;
  if (setupState.completedSteps) {
    setupState.completedSteps.prerequisites = false;
    setupState.completedSteps.prerequisitesWarning = false;
  }

  await showStage('prerequisites', {
    debugForcePrereqVisible: true,
    debugSkipPrereqResume: true,
    deferPrereqStart: true,
    manualVisit: false,
    suppressPrereqAutoAdvance: true,
  });

  const result = await _simulatePrerequisitesErrorState(errorState);
  recordGuidedSetupDebugEntry(`Forced prerequisite error state: ${errorState}`, 'warning', 'prerequisites');
  setGuidedSetupDebugStatus(`Showing simulated prerequisite error: ${errorState}`);
  scheduleGuidedSetupDebugRefresh();
  return result;
}

async function clearGuidedSetupPrereqErrorState() {
  if (typeof _clearSimulatedPrerequisitesErrorState !== 'function') {
    throw new Error('Prerequisite error simulation is unavailable.');
  }

  const restore = guidedSetupDebugState.simulatedPrereqRestore;
  const result = await _clearSimulatedPrerequisitesErrorState();
  if (restore) {
    guidedSetupDebugState.simulatedPrereqRestore = null;
    setupState.prereqPolicy = restore.prereqPolicy ? { ...restore.prereqPolicy } : null;
    setupState.skipPrerequisites = restore.skipPrerequisites;
    setupState.prerequisitesManualVisit = restore.prerequisitesManualVisit;
    if (setupState.completedSteps) {
      setupState.completedSteps.prerequisites = restore.completedPrerequisites;
      setupState.completedSteps.prerequisitesWarning = restore.prerequisitesWarning;
    }

    if (restore.currentStage && restore.currentStage !== 'prerequisites') {
      await showStage(restore.currentStage, {
        suppressOauthAutoAdvance: true,
      });
    } else if (restore.currentStage === 'prerequisites') {
      setupState.currentStage = 'prerequisites';
    }
  }
  recordGuidedSetupDebugEntry('Cleared simulated prerequisite error state.', 'info', 'prerequisites');
  setGuidedSetupDebugStatus('Cleared simulated prerequisite error state.');
  scheduleGuidedSetupDebugRefresh();
  return result;
}

function bindGuidedSetupDebugDrawer() {
  const elements = getGuidedSetupDebugElements();
  const debugTesterEnabled = syncGuidedSetupDebugTestPanelVisibility();
  if (!elements.toggle) {
    return;
  }

  if (elements.toggle.dataset.bound !== 'true') {
    elements.toggle.dataset.bound = 'true';
    elements.toggle.addEventListener('click', () => {
      if (guidedSetupDebugState.drawerOpen) {
        hideGuidedSetupDebugDrawer();
      } else {
        showGuidedSetupDebugDrawer({ refresh: true });
      }
    });

    elements.scrim?.addEventListener('click', hideGuidedSetupDebugDrawer);
    elements.close?.addEventListener('click', hideGuidedSetupDebugDrawer);
    elements.copy?.addEventListener('click', () => {
      copyGuidedSetupDebugLogs().catch((error) => {
        setGuidedSetupDebugStatus(`Failed to copy logs: ${error.message}`, 'error');
      });
    });
    elements.collect?.addEventListener('click', () => {
      collectGuidedSetupDebugInfo().catch((error) => {
        setGuidedSetupDebugStatus(`Failed to collect debug information: ${error.message}`, 'error');
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && guidedSetupDebugState.drawerOpen) {
        hideGuidedSetupDebugDrawer();
      }
    });
  }

  if (!debugTesterEnabled) {
    return;
  }

  GUIDED_SETUP_DEBUG_PREREQ_ERROR_STATES.forEach(({ id, state: errorState }) => {
    const button = document.getElementById(id);
    if (!button || button.dataset.bound === 'true') {
      return;
    }
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      if (!isGuidedSetupDevBuild()) {
        return;
      }
      forceGuidedSetupPrereqErrorState(errorState).catch((error) => {
        setGuidedSetupDebugStatus(`Failed to force prerequisite error: ${error.message}`, 'error');
      });
    });
  });

  if (elements.clearSimulatedError && elements.clearSimulatedError.dataset.bound !== 'true') {
    elements.clearSimulatedError.dataset.bound = 'true';
    elements.clearSimulatedError.addEventListener('click', () => {
      if (!isGuidedSetupDevBuild()) {
        return;
      }
      clearGuidedSetupPrereqErrorState().catch((error) => {
        setGuidedSetupDebugStatus(`Failed to clear simulated prerequisite error: ${error.message}`, 'error');
      });
    });
  }
}

const BASIC_CURATED_ICON_GROUPS = Object.freeze([
  {
    label: 'Glean',
    serverIds: ['glean'],
    tooltip: 'Company knowledge at your fingertips.',
    assetPath: `${HELLO_LOGO_ASSET_BASE}/glean.png`,
  },
  {
    label: 'Google Workspace',
    serverIds: ['google_workspace'],
    tooltip: 'Read and write access across all Google products!',
    assetPath: `${HELLO_LOGO_ASSET_BASE}/google-workspace.png`,
  },
  {
    label: 'Atlassian',
    serverIds: ['mcp-atlassian'],
    tooltip: 'Read and write to JIRA and Confluence.',
    assetPath: `${HELLO_LOGO_ASSET_BASE}/atlassian.png`,
  },
  {
    label: 'Portico',
    serverIds: ['data-plat-mcp'],
    tooltip: "Access to Portico's Data Platform.",
    assetPath: `${HELLO_LOGO_ASSET_BASE}/portico.png`,
  },
  {
    label: 'Slack',
    serverIds: ['slack'],
    tooltip: 'Read and send messages across your Slack workspace.',
    assetPath: `${HELLO_LOGO_ASSET_BASE}/slack.png`,
  },
]);

function applyPrereqSkipState() {
  return refreshPrereqPolicy();
}

function getGuidedSetupLaunchSource() {
  return setupState.launchContext?.source || 'unknown';
}

function refreshPrereqPolicy() {
  const readyForAuth = Boolean(setupState.prereqReadiness?.readyForAuth);
  const needsHostUpgrade = setupState.onboardingMode === 'power' && !setupState.hostModeSupported;

  let policy;
  if (getGuidedSetupLaunchSource() === 'required') {
    policy = {
      showStep: true,
      noInteractiveWorkRequired: readyForAuth && !needsHostUpgrade,
      reason: readyForAuth && !needsHostUpgrade ? 'required-no-op' : 'required-interactive'
    };
  } else if (!readyForAuth) {
    policy = {
      showStep: true,
      noInteractiveWorkRequired: false,
      reason: 'install-not-ready'
    };
  } else if (needsHostUpgrade) {
    policy = {
      showStep: true,
      noInteractiveWorkRequired: false,
      reason: 'host-upgrade'
    };
  } else {
    policy = {
      showStep: false,
      noInteractiveWorkRequired: false,
      reason: 'manual-ready'
    };
  }

  setupState.prereqPolicy = policy;
  setupState.skipPrerequisites = !policy.showStep;
  return policy;
}

function prerequisitesStepIsVisible() {
  return Boolean(setupState.prereqPolicy?.showStep);
}

function canAdvancePastPrerequisites() {
  return !prerequisitesStepIsVisible() || setupState.completedSteps.prerequisites;
}

function canNavigateToConfigurationStep() {
  if (setupState.serverConfigs.length === 0) {
    return false;
  }

  const oauthStepIncluded = Array.isArray(setupState.oauthServers) && setupState.oauthServers.length > 0;
  return setupState.currentStage === 'configuration' ||
    setupState.completedSteps.oauth === true ||
    !oauthStepIncluded;
}

function getProgressTrackerState() {
  return {
    oauthServers: setupState.oauthServers,
    completedOAuthServers: setupState.completedOAuthServers,
    connectedOAuthServers: setupState.connectedOAuthServers,
    skippedOAuthServers: setupState.skippedOAuthServers,
    configuredServers: setupState.configuredServers,
    preConfiguredServers: setupState.preConfiguredServers,
    skippedServers: setupState.skippedServers,
  };
}

function shouldStartPrereqBackgroundPrefetch() {
  return setupState.prereqReadiness?.readyForAuth !== true;
}

// Callbacks object to pass to modules
const callbacks = {
  // State management
  getSetupState,
  setCurrentStage,
  setEnvVar,
  addConfiguredServer,
  addSkippedServer,

  // Environment
  loadExistingEnvVars: async () => {
    const envVars = await envManager.loadExistingEnvVars();
    Object.assign(setupState.envVars, envVars);
    return envVars;
  },
  saveEnvVarImmediately: (key, value) => envManager.saveEnvVarImmediately(key, value),
  isServerConfigured: (server) => envManager.isServerConfigured(server, setupState.envVars),
  isPlaceholderValue: envManager.isPlaceholderValue,

  // Validation
  validateEnvValue,
  validateInputField,
  validateAllInputs,

  // Markdown parsing
  parseMarkdownContent: (content, envVars, context) => parseMarkdownContent(content, envVars, context, {
    generateConfirmationCard,
    copyToClipboard
  }),
  substituteVariables,

  // Progress tracking
  updateProgressTracker: () => updateProgressTracker(
    setupState.currentStage,
    setupState.completedSteps,
    setupState.serverConfigs,
    setupState.onboardingMode,
    setupState.prereqPolicy,
    setupState.oauthStepRequired,
    getProgressTrackerState()
  ),
  analyzeOAuthServers: (servers) => _analyzeOAuthServers(servers),

  // Server navigation
  createServerNavigation: () => createServerNavigation(setupState.serverConfigs, setupState.currentServerIndex, setupState.configuredServers, setupState.skippedServers, setupState.preConfiguredServers),
  updateServerNavigation: () => updateServerNavigation(setupState.serverConfigs, setupState.currentServerIndex, setupState.configuredServers, setupState.skippedServers, setupState.preConfiguredServers),

  // Server cards
  createServerCard: (server, index, isConfigured, hostModeSupported, options = {}) =>
    createServerCard(server, index, isConfigured, hostModeSupported, options),
  createHostWarning,

  // Accordion
  createInitialAccordions,
  markAccordionsAsCompleted,
  createAccordionsForVisibleContent: (container, context, options) => createAccordionsForVisibleContent(container, context, options),
  toggleAccordion,

  // Browser
  showBrowser: () => _showBrowser(setupState),
  hideBrowser: () => _hideBrowser(setupState),
  loadBrowserUrl,
  openExternalUrl,

  // Stage navigation - wrapped to ensure lookup at call time
  showStage: (stageName, options) => showStage(stageName, options),
  restartSetupWizardFromFinalize: () => restartSetupWizardFromFinalize(),
  navigateToStep: (stepName) => navigateToStep(stepName),
  advanceAfterPrerequisites: () => advanceAfterPrerequisites(),

  // Configuration
  loadServerConfiguration: (index) => _loadServerConfiguration(index, setupState, callbacks),
  findNextPendingConfigurationIndex: (startIndex = 0) => _getNextPendingConfigurationIndex(setupState, startIndex),
  refreshConfigurationGuidance: () => _refreshConfigurationGuidance(callbacks),
  handleConfigurationAccordionToggle: (details) => _handleConfigurationAccordionToggle(details, callbacks),
  setConfigurationLoadingState,
  getConfigurationScrollContainer: () => document.querySelector('.content-scroll-area'),
  finalizeSetup: () => _finalizeSetup(setupState, PROJECT_ROOT, callbacks),
  proceedToConfiguration: () => _proceedToConfiguration(setupState, callbacks),

  // Logging - wrapped to ensure lookup at call time
  addLog: (text, type) => addLog(text, type)
};

// Stage navigation
async function showStage(stageName, options = {}) {
  if (
    stageName === 'prerequisites' &&
    !prerequisitesStepIsVisible() &&
    options.debugForcePrereqVisible !== true
  ) {
    await advanceAfterPrerequisites();
    return;
  }

  let resolvedStage = stageName;

  document.querySelectorAll('.setup-stage').forEach(stage => {
    stage.classList.remove('active');
  });

  const stage = document.getElementById(`stage-${resolvedStage}`);
  if (stage) {
    stage.classList.add('active');
    setupState.currentStage = resolvedStage;
  }

  if (resolvedStage === 'server-selection') {
    setServerSelectionLoadingState(true);
  }
  if (resolvedStage === 'oauth') {
    setOauthLoadingState(true);
  }
  if (resolvedStage === 'configuration' && options.initialLoading === true) {
    setConfigurationLoadingState(true);
  }

  setupState.prerequisitesManualVisit =
    resolvedStage === 'prerequisites' && options.manualVisit === true;

  // Load Prerequisites content when showing that stage
  if (resolvedStage === 'prerequisites') {
    const resume = options.debugSkipPrereqResume === true
      ? false
      : setupState.completedSteps && setupState.completedSteps.prerequisites;
    await _loadPrerequisitesScreen(setupState, callbacks, {
      resume,
      deferStart: options.deferPrereqStart === true,
      manualVisit: setupState.prerequisitesManualVisit,
      suppressAutoAdvance: options.suppressPrereqAutoAdvance === true,
    });
  }

  if (resolvedStage === 'vpn-check') {
    _cleanupPrerequisitesListeners();
    await _loadVpnCheckScreen(setupState, callbacks, options);
  }

  if (resolvedStage === 'hello') {
    renderHelloStage();
  }

  const stageWindowOptions = getGuidedSetupStageWindowOptions(resolvedStage, setupState);
  if (stageWindowOptions) {
    maximizeGuidedSetupWindow(stageWindowOptions, `showStage:${resolvedStage}`);
  }

  // Reload MCP server configs and update grid when entering server-selection stage.
  // The initial loadMcpServerConfigs() at page load may return 0 servers because
  // prerequisites haven't populated mcp-configs/ yet.
  if (resolvedStage === 'server-selection') {
    try {
      await loadMcpServerConfigs();
      await hydrateServerSelectionFromCurrentToggles();
      _populateServerGrid(setupState, callbacks);
      _updateSelectAllButtons(setupState, callbacks);
    } finally {
      setServerSelectionLoadingState(false);
    }
  }

  // Load OAuth screen content when showing that stage
  if (resolvedStage === 'oauth') {
    try {
      await _loadOAuthScreen(setupState, callbacks, {
        suppressAutoAdvance: options.suppressOauthAutoAdvance === true,
        autoStartPending: options.autoStartPendingOAuth === true,
      });
    } finally {
      setOauthLoadingState(false);
    }
  }

  const activeStage = setupState.currentStage || resolvedStage;

  // Show panel header and progress tracker after welcome stage
  toggleProgressVisibility(
    activeStage,
    setupState.completedSteps,
    setupState.onboardingMode,
    setupState.prereqPolicy,
    { showPrerequisitesTracker: setupState.prerequisitesManualVisit },
  );

  // Hide browser on server selection stage
  if (activeStage === 'server-selection') {
    _hideBrowser(setupState);
  }

  // Hide browser on OAuth stage
  if (activeStage === 'oauth') {
    _hideBrowser(setupState);
  }

  // Auto-close browser when reaching finalize/success stages
  if (activeStage === 'finalize' || activeStage === 'success') {
    _hideBrowser(setupState);
  }

  // Update progress tracker
  updateProgressTracker(
    activeStage,
    setupState.completedSteps,
    setupState.serverConfigs,
    setupState.onboardingMode,
    setupState.prereqPolicy,
    setupState.oauthStepRequired,
    getProgressTrackerState()
  );

  // Load browser content
  loadBrowserContent(activeStage);
  if (guidedSetupDebugState.drawerOpen) {
    scheduleGuidedSetupDebugRefresh();
  }

  setTimeout(() => {
    const setupPanel = document.querySelector('.setup-panel');
    if (setupPanel) {
      setupPanel.scrollTop = 0;
    }
  }, 50);
}

// Navigate to specific step
function navigateToStep(stepName) {
  if (setupState.onboardingMode === 'basic' && (stepName === 'server-selection' || stepName === 'configuration')) {
    return;
  }
  if (stepName === 'hello' && setupState.currentStage !== 'welcome') {
    showStage('hello');
    return;
  }
  if (stepName === 'prerequisites' && !prerequisitesStepIsVisible()) {
    return;
  }
  if (stepName === 'prerequisites' && setupState.completedSteps.prerequisites) {
    showStage('prerequisites', { suppressPrereqAutoAdvance: true, manualVisit: true });
  } else if (stepName === 'server-selection' && canAdvancePastPrerequisites()) {
    showStage('server-selection');
  } else if (stepName === 'oauth' && setupState.completedSteps.serverSelection) {
    if (setupState.oauthServers && setupState.oauthServers.length > 0) {
      showStage('oauth', { suppressOauthAutoAdvance: true });
    }
  } else if (stepName === 'configuration' && canNavigateToConfigurationStep()) {
    if (setupState.currentServerIndex >= 0) {
      _loadServerConfiguration(setupState.currentServerIndex, setupState, callbacks);
    }
  } else if (stepName === 'finalize') {
    if (setupState.currentStage === 'finalize') {
      showStage('finalize');
    }
  }
}

// Browser content loader
function loadBrowserContent(stage) {
  // Keep current content - browser content is loaded dynamically
}

function setWelcomeAuthState({ loading = false, message = "First, let's get you logged in...", error = null } = {}) {
  const authState = document.getElementById('welcome-auth-state');
  const authMessage = document.getElementById('welcome-auth-message');
  const errorEl = document.getElementById('welcome-error');
  const startButton = document.getElementById('welcome-start-button');

  if (authState) {
    authState.style.display = loading ? 'block' : 'none';
  }
  if (authMessage) {
    authMessage.textContent = message;
  }
  if (errorEl) {
    errorEl.textContent = normalizeSetupAuthMessage(error, '');
    errorEl.style.display = error ? 'block' : 'none';
  }
  if (startButton) {
    startButton.disabled = loading;
    startButton.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
}

function getHelloFirstName(sessionSummary) {
  const user = sessionSummary?.user || {};
  const rawName =
    (typeof user.name === 'string' && user.name.trim()) ||
    (typeof user.preferredUsername === 'string' && user.preferredUsername.trim()) ||
    (typeof user.id === 'string' && user.id.trim()) ||
    'there';

  return rawName.split(/\s+/).filter(Boolean)[0] || 'there';
}

function normalizeGuidedSetupEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getAuthenticatedSetupEmail(sessionSummary = authenticatedSetupSession) {
  return sessionSummary?.user?.email || null;
}

function isContractorGuidedSetupEmail(email) {
  return isContractorEmail(email);
}

function isContractorGuidedSetupSession(sessionSummary = authenticatedSetupSession) {
  return isContractorGuidedSetupEmail(getAuthenticatedSetupEmail(sessionSummary));
}

function getGuidedSetupDisabledServerPolicy(sessionSummary = authenticatedSetupSession) {
  const disabledServerIds = new Set();
  const disabledTooltips = {};

  if (isContractorGuidedSetupSession(sessionSummary)) {
    disabledServerIds.add(CONTRACTOR_GUIDED_SETUP_DISABLED_SERVER_ID);
    disabledTooltips[CONTRACTOR_GUIDED_SETUP_DISABLED_SERVER_ID] =
      CONTRACTOR_GUIDED_SETUP_DISABLED_TOOLTIP;
  }

  return {
    disabledServerIds,
    disabledTooltips,
  };
}

function sanitizeGuidedSetupSelectedServers(selectedIndices = setupState.selectedServers) {
  return (Array.isArray(selectedIndices) ? selectedIndices : []).filter((index) => {
    const server = setupState.mcpServers?.[index];
    return isGuidedSetupSelectableServer(server, {
      hostModeSupported: setupState.hostModeSupported,
      guidedSetupDisabledServerIds: setupState.guidedSetupDisabledServerIds,
    });
  });
}

function syncGuidedSetupDisabledServerPolicy(sessionSummary = authenticatedSetupSession) {
  const { disabledServerIds, disabledTooltips } = getGuidedSetupDisabledServerPolicy(sessionSummary);

  setupState.guidedSetupDisabledServerIds.clear();
  disabledServerIds.forEach((serverId) => {
    setupState.guidedSetupDisabledServerIds.add(serverId);
  });
  setupState.guidedSetupDisabledTooltips = { ...disabledTooltips };
  setupState.selectedServers = sanitizeGuidedSetupSelectedServers(setupState.selectedServers);

  return {
    disabledServerIds,
    disabledTooltips,
  };
}

function getBasicCuratedServerIds(sessionSummary = authenticatedSetupSession) {
  const curatedServerIds = [...BASIC_CURATED_SERVER_IDS];
  if (!isContractorGuidedSetupSession(sessionSummary)) {
    return curatedServerIds;
  }

  return curatedServerIds.filter(
    (serverId) => serverId !== CONTRACTOR_GUIDED_SETUP_DISABLED_SERVER_ID,
  );
}

function escapeHelloAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createHelloLogoChip({ label, tooltip, icon }) {
  const safeLabel = escapeHelloAttr(label || 'Integration');
  const safeTooltip = escapeHelloAttr(tooltip || label || 'Integration');
  const chipKind = label === 'Portico' ? 'portico' : 'default';
  if (icon) {
    return `
      <div class="hello-logo-chip" data-logo-kind="${chipKind}" data-tooltip="${safeTooltip}" title="${safeTooltip}" aria-label="${safeTooltip}" tabindex="0">
        <img src="${escapeHelloAttr(icon)}" alt="${safeLabel}" onerror="this.parentElement.innerHTML='<span class=&quot;hello-logo-chip-fallback&quot;>${safeLabel.slice(0, 2).toUpperCase()}</span>'">
      </div>
    `;
  }

  return `
    <div class="hello-logo-chip" data-logo-kind="${chipKind}" data-tooltip="${safeTooltip}" title="${safeTooltip}" aria-label="${safeTooltip}" tabindex="0">
      <span class="hello-logo-chip-fallback">${safeLabel.slice(0, 2).toUpperCase()}</span>
    </div>
  `;
}

function setHelloModeSelectionState(isBusy) {
  const optionIds = ['hello-basic-option', 'hello-power-option'];
  optionIds.forEach((id) => {
    const option = document.getElementById(id);
    if (!option) return;
    option.disabled = isBusy;
    option.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  });
}

function normalizeOnboardingModeSelection(mode) {
  return mode === 'basic' || mode === 'power' ? mode : null;
}

function getRememberedHelloMode() {
  return normalizeOnboardingModeSelection(setupState.savedOnboardingMode);
}

function setHelloModeError(message = null) {
  const errorEl = document.getElementById('hello-mode-error');
  if (!errorEl) return;

  if (message) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    return;
  }

  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

function syncHelloModeSelectionUI(selectedMode = getRememberedHelloMode()) {
  [
    ['hello-basic-option', 'basic'],
    ['hello-power-option', 'power'],
  ].forEach(([id, mode]) => {
    const option = document.getElementById(id);
    if (!option) return;
    const isSelected = selectedMode === mode;
    option.classList.toggle('is-selected', isSelected);
    option.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  });
}

function renderHelloStage() {
  const helloTitle = document.getElementById('hello-title');
  const logoStrip = document.getElementById('hello-basic-logo-strip');

  if (helloTitle) {
    helloTitle.textContent = `Hello, ${getHelloFirstName(authenticatedSetupSession)}!`;
  }

  if (logoStrip) {
    const serversById = new Map(setupState.mcpServers.map((server) => [server.id, server]));
    const chips = BASIC_CURATED_ICON_GROUPS
      .map((group) => {
        const server = group.serverIds
          .map((serverId) => serversById.get(serverId))
          .find(Boolean);
        const icon = group.serverIds
          .map((serverId) => serversById.get(serverId))
          .find((entry) => entry?.icon)?.icon || server?.icon || group.assetPath || null;

        if (!icon) {
          return null;
        }

        return createHelloLogoChip({
          label: group.label,
          tooltip: group.tooltip,
          icon,
        });
      })
      .filter(Boolean)
      .join('');
    logoStrip.innerHTML = chips;
  }

  setHelloModeError(null);
  syncHelloModeSelectionUI();
  setHelloModeSelectionState(false);
}

function getGuidedSetupWindowResizeTargets(options = {}) {
  const requestedWidth = Number(options?.targetWidth);
  const requestedHeight = Number(options?.targetHeight);

  return {
    targetWidth: Number.isFinite(requestedWidth) && requestedWidth > 0
      ? requestedWidth
      : GUIDED_SETUP_WINDOW_DEFAULT_WIDTH,
    targetHeight: Number.isFinite(requestedHeight) && requestedHeight > 0
      ? requestedHeight
      : GUIDED_SETUP_WINDOW_DEFAULT_HEIGHT,
  };
}

function setGuidedSetupStageLoadingState({
  stageId,
  progressStageName,
  loadingShellId,
  readyContentId,
  isLoading,
}) {
  const stage = document.getElementById(stageId);
  const progressWrapper = document.getElementById('progress-tracker-wrapper');
  const loadingShell = document.getElementById(loadingShellId);
  const readyContent = document.getElementById(readyContentId);

  if (stage) {
    stage.classList.toggle('is-loading', isLoading);
  }

  if (progressWrapper && setupState.currentStage === progressStageName) {
    progressWrapper.style.display = isLoading ? 'none' : '';
  }

  if (loadingShell) {
    loadingShell.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
  }

  if (readyContent) {
    readyContent.setAttribute('aria-hidden', isLoading ? 'true' : 'false');
  }
}

function setServerSelectionLoadingState(isLoading) {
  setGuidedSetupStageLoadingState({
    stageId: 'stage-server-selection',
    progressStageName: 'server-selection',
    loadingShellId: 'server-selection-loading-shell',
    readyContentId: 'server-selection-ready-content',
    isLoading,
  });
}

function setOauthLoadingState(isLoading) {
  setGuidedSetupStageLoadingState({
    stageId: 'stage-oauth',
    progressStageName: 'oauth',
    loadingShellId: 'oauth-stage-loading-shell',
    readyContentId: 'oauth-stage-ready-content',
    isLoading,
  });
}

function setConfigurationLoadingState(isLoading) {
  setGuidedSetupStageLoadingState({
    stageId: 'stage-configuration',
    progressStageName: 'configuration',
    loadingShellId: 'configuration-stage-loading-shell',
    readyContentId: 'configuration-stage-ready-content',
    isLoading,
  });
}

function maximizeGuidedSetupWindow(options = {}, reason = 'unspecified') {
  const { targetWidth, targetHeight } = getGuidedSetupWindowResizeTargets(options);

  console.log(`[guided-setup] Resizing guided setup window: reason=${reason} targetWidth=${targetWidth} targetHeight=${targetHeight}`);

  try {
    window.electronAPI?.maximizeElectronApp?.(options);
  } catch (error) {
    console.error('[guided-setup] Failed to maximize guided setup window:', error);
  }
}

function startPrereqBackgroundPrefetch() {
  if (!window.electronAPI?.prerequisitesStartBackgroundPrefetch) {
    return;
  }

  window.electronAPI.prerequisitesStartBackgroundPrefetch().catch((error) => {
    console.warn('[guided-setup] Failed to start background prereq prefetch:', error.message);
  });
}

function normalizeSetupAuthMessage(value, fallback = 'Setup login failed. Please try again.') {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    const nestedCandidates = [
      value.message,
      value.error,
      value.error_description,
      value.description,
      value.details,
    ];

    for (const candidate of nestedCandidates) {
      const normalized = normalizeSetupAuthMessage(candidate, '');
      if (normalized) {
        return normalized;
      }
    }
  }

  return fallback;
}

const SAFE_SETUP_AUTH_UI_CODES = new Set([
  'access_denied',
  'access_denied_user_cancelled',
  'auth_storage_unavailable',
  'auth_timeout',
  'browser_open_failed',
  'callback_listener_failed',
  'discovery_failed',
  'discovery_invalid',
  'identity_email_unavailable',
  'identity_sync_failed',
  'identity_sync_invalid',
  'identity_sync_project_root_missing',
  'missing_authorization_code',
  'missing_refresh_token',
  'oauth_provider_error',
  'oauth_request_failed',
  'redirect_uri_mismatch',
  'refresh_failed',
  'setup_auth_failed',
  'state_mismatch',
  'token_exchange_failed',
]);

function getSafeSetupAuthUiCode(result = {}) {
  const candidate = result?.errorCode || result?.code;
  return SAFE_SETUP_AUTH_UI_CODES.has(candidate)
    ? candidate
    : 'setup_auth_failed';
}

function formatSetupAuthError(result = {}) {
  const errorCode = getSafeSetupAuthUiCode(result);

  switch (errorCode) {
    case 'access_denied_user_cancelled':
      return 'Sign-in was canceled. Try again when you are ready.';
    case 'access_denied':
      return 'Okta denied access to this app. Try again or confirm that your account can use this Okta application.';
    case 'auth_timeout':
      return 'Okta took too long to finish. Try again.';
    case 'state_mismatch':
    case 'redirect_uri_mismatch':
      return 'The Okta callback did not match the request. Try again.';
    case 'auth_storage_unavailable':
      return 'Secure token storage is unavailable on this device, so setup login cannot continue.';
    case 'callback_listener_failed':
      return 'The app could not open the local Okta callback port. Try again.';
    case 'browser_open_failed':
      return 'The app could not open Okta in your browser. Try again.';
    case 'discovery_failed':
      return 'The app could not contact Okta to start sign-in. Try again.';
    case 'discovery_invalid':
      return 'Okta returned an invalid sign-in configuration. Contact support.';
    case 'missing_authorization_code':
      return 'Okta did not return the code needed to finish sign-in. Try again.';
    case 'oauth_provider_error':
    case 'oauth_request_failed':
      return 'Okta could not complete sign-in. Try again.';
    case 'missing_refresh_token':
    case 'refresh_failed':
      return 'The saved Okta login could not be refreshed. Sign in again.';
    case 'token_exchange_failed':
      return 'Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.';
    case 'identity_sync_invalid':
      return 'The signed-in account is missing required identity information.';
    case 'identity_email_unavailable':
      return 'Sign-in finished, but your account did not provide an email address, which this app requires. Retry login; if it keeps happening, contact support.';
    case 'identity_sync_failed':
    case 'identity_sync_project_root_missing':
      return 'The signed-in account could not be saved locally. Try again.';
    default:
      return 'Setup login failed. Please try again.';
  }
}

// Intentional duplication of setup-auth-shared's normalizePlausibleEmail
// (this renderer bundle cannot require main-process modules): at least one
// character on each side of an @.
function sessionSummaryHasPlausibleEmail(sessionSummary) {
  const email = sessionSummary?.user?.email;
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  return atIndex >= 1 && atIndex < trimmed.length - 1;
}

async function persistAuthenticatedUser(sessionSummary) {
  const user = sessionSummary?.user || {};
  if (!user.id || !user.name) {
    const error = new Error('Authenticated setup session is missing required user claims');
    error.code = 'identity_sync_invalid';
    throw error;
  }

  // Identity persistence belongs exclusively to current-user in the main
  // process. The renderer validates claims but never writes identity values.
}

function validateBasicBundleSelection(sessionSummary = authenticatedSetupSession) {
  const serversById = new Map(setupState.mcpServers.map((server, index) => [server.id, { server, index }]));
  const selectedIndices = [];
  const missingServerIds = [];
  const invalidServerIds = [];
  const curatedServerIds = getBasicCuratedServerIds(sessionSummary);

  curatedServerIds.forEach((serverId) => {
    const entry = serversById.get(serverId);
    if (!entry) {
      missingServerIds.push(serverId);
      return;
    }

    const { server, index } = entry;
    const requiresConfig = serverRequiresConfig(server);
    const deploymentType = server.deploymentType || server.deployment_type || 'docker';
    const isHost = deploymentType === 'host';
    if (requiresConfig || isHost) {
      invalidServerIds.push(serverId);
      return;
    }

    selectedIndices.push(index);
  });

  if (missingServerIds.length > 0) {
    throw new Error(`The basic setup bundle is missing integrations: ${missingServerIds.join(', ')}`);
  }

  if (invalidServerIds.length > 0) {
    throw new Error(`The basic setup bundle includes unsupported integrations: ${invalidServerIds.join(', ')}`);
  }

  return selectedIndices;
}

function resetGuidedSetupProgressForRetry() {
  setOnboardingMode(null);
  preserveGuidedSetupToggleState(setupState);
  setupState.serverSelectionHydrated = false;
  setupState.selectedServers = [];
  setupState.oauthServers = [];
  setupState.oauthStepRequired = null;
  setupState.serverConfigs = [];
  setupState.currentOAuthIndex = 0;
  setupState.currentServerIndex = 0;
  setupState.completedSteps.prerequisites = false;
  setupState.completedSteps.prerequisitesWarning = false;
  setupState.completedSteps.serverSelection = false;
  setupState.completedSteps.oauth = false;
  setupState.completedSteps.servers = {};
  setupState.configuredServers.clear();
  setupState.preConfiguredServers?.clear?.();
  setupState.skippedServers.clear();
  setupState.completedOAuthServers.clear();
  setupState.connectedOAuthServers?.clear?.();
  setupState.skippedOAuthServers.clear();
}

async function restartSetupWizardFromFinalize() {
  resetGuidedSetupProgressForRetry();
  await showStage(authenticatedSetupSession ? 'hello' : 'welcome');
}

async function continueAfterModeSelection() {
  const prereqPolicy = refreshPrereqPolicy();
  if (!prereqPolicy.showStep) {
    await advanceAfterPrerequisites();
    return;
  }

  await showStage('prerequisites', { deferPrereqStart: true });

  void (async () => {
    if (prereqPolicy.noInteractiveWorkRequired) {
      await _bootstrapPrerequisitesSession({ shouldResume: false });
      return;
    }

    let vpnResult = null;
    if (window.electronAPI?.checkVpnConnectivity) {
      try {
        vpnResult = await window.electronAPI.checkVpnConnectivity();
      } catch (error) {
        vpnResult = {
          success: false,
          harbor: { ok: false, error: error.message },
          cloudsmith: { ok: false, error: error.message }
        };
      }
    }

    if (vpnResult && vpnResult.success === false) {
      await showStage('vpn-check', { initialResult: vpnResult });
      return;
    }

    const resume = setupState.completedSteps && setupState.completedSteps.prerequisites;
    await _bootstrapPrerequisitesSession({ shouldResume: Boolean(resume) });
  })().catch((error) => {
    console.error('[guided-setup] Failed to continue after mode selection:', error);
  });
}

async function handleSetupAuthSuccess(sessionSummary) {
  await persistAuthenticatedUser(sessionSummary);
  authenticatedSetupSession = sessionSummary;
  syncGuidedSetupDisabledServerPolicy(sessionSummary);

  if (setupState.launchContext?.setupMode === 'identity_repair') {
    const result = await window.electronAPI?.getSetupLaunchDecision?.();
    const decision = result?.decision;
    if (!result?.success || !decision) {
      throw new Error(result?.error || 'Identity repair could not be verified');
    }
    if (decision.action === 'reconcile_identity' || decision.action === 'identity_login') {
      throw new Error('The signed-in identity could not be synchronized. Retry identity repair.');
    }
    window.electronAPI.electronAppComplete();
    return;
  }

  if (
    setupState.launchContext?.setupMode === 'full' ||
    setupState.launchContext?.setupMode === 'runtime_repair'
  ) {
    const currentUserApi = window.electronAPI?.currentUser;
    if (typeof currentUserApi?.get !== 'function') {
      throw new Error('Current-user reconciliation is unavailable for required setup');
    }
    const identity = await currentUserApi.get();
    if (!identity?.success || !identity?.authenticated || !identity?.sessionSummary) {
      throw new Error(
        identity?.error || 'Required setup cannot open until login is reconciled',
      );
    }
    authenticatedSetupSession = identity.sessionSummary;
    syncGuidedSetupDisabledServerPolicy(identity.sessionSummary);
  }

  if (setupState.launchContext?.setupMode === 'runtime_repair') {
    refreshPrereqPolicy();
    setupPointerTrackedTooltips();
    setupClipboardShortcuts();
    await resolveGuidedSetupDevBuildState();
    bindGuidedSetupDebugDrawer();
    await continueAfterModeSelection();
    return;
  }

  await showStage('hello');
}

async function hydrateRequiredSetupSession() {
  const currentUserApi = window.electronAPI?.currentUser;
  if (typeof currentUserApi?.get !== 'function') {
    throw new Error('Current-user reconciliation is unavailable for required setup');
  }

  const identity = await currentUserApi.get();
  if (!identity?.success || !identity?.authenticated || !identity?.sessionSummary) {
    throw new Error(
      identity?.error || 'Required setup cannot open until login is reconciled',
    );
  }

  authenticatedSetupSession = identity.sessionSummary;
  syncGuidedSetupDisabledServerPolicy(identity.sessionSummary);
  return identity.sessionSummary;
}

function setupLeftPanelScroll() {
  const setupPanel = document.querySelector('.setup-panel');
  const scrollArea = document.querySelector('.content-scroll-area');
  if (!setupPanel || !scrollArea) return;

  setupPanel.addEventListener('wheel', (event) => {
    if (event.defaultPrevented) return;
    if (event.target.closest('.modal-overlay') || event.target.closest('.log-viewer-modal')) {
      return;
    }

    if (event.target.closest('.content-scroll-area')) {
      return;
    }

    scrollArea.scrollTop += event.deltaY;
    event.preventDefault();
  }, { passive: false });
}

function setupPointerTrackedTooltips() {
  document.querySelectorAll('[data-tooltip-follow="pointer"]').forEach((button) => {
    if (button.dataset.tooltipFollowBound === 'true') {
      return;
    }

    const updateTooltipAnchor = (event) => {
      if (typeof button.getBoundingClientRect !== 'function') {
        return;
      }

      const rect = button.getBoundingClientRect();
      const padding = Math.min(24, rect.width / 2);
      const verticalPadding = Math.min(10, rect.height / 2);
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const clampedX = Math.max(padding, Math.min(rect.width - padding, offsetX));
      const clampedY = Math.max(verticalPadding, Math.min(rect.height - verticalPadding, offsetY));
      button.style.setProperty('--tooltip-anchor-x', `${clampedX}px`);
      button.style.setProperty('--tooltip-anchor-y', `${clampedY}px`);
    };

    const clearTooltipAnchor = () => {
      button.style.removeProperty('--tooltip-anchor-x');
      button.style.removeProperty('--tooltip-anchor-y');
    };

    button.dataset.tooltipFollowBound = 'true';
    button.addEventListener('mouseenter', updateTooltipAnchor);
    button.addEventListener('mousemove', updateTooltipAnchor);
    button.addEventListener('mouseleave', clearTooltipAnchor);
    button.addEventListener('blur', clearTooltipAnchor);
  });
}

// Logging function
function addLog(text, type = 'info') {
  recordGuidedSetupDebugEntry(text, type);
}

// Initialize the application
async function initialize() {
  // Get project root from main process via secure IPC
  PROJECT_ROOT = await window.electronAPI.getProjectRoot();
  console.log('[guided-setup] Project root:', PROJECT_ROOT);

  let bootstrapState = null;
  try {
    if (window.electronAPI?.getGuidedSetupBootstrapState) {
      bootstrapState = await window.electronAPI.getGuidedSetupBootstrapState();
    }
  } catch (_error) {
    bootstrapState = null;
  }

  if (bootstrapState?.launchContext) {
    setupState.launchContext = {
      source: bootstrapState.launchContext.source || 'unknown',
      trigger: bootstrapState.launchContext.trigger || 'unknown',
      startedAt: bootstrapState.launchContext.startedAt || 0,
      setupMode: bootstrapState.launchContext.setupMode || null,
      setupReason: bootstrapState.launchContext.setupReason || null,
      setupRequirementId: bootstrapState.launchContext.setupRequirementId || null,
      safeErrorCode: bootstrapState.launchContext.safeErrorCode || null,
      setupOperationId: bootstrapState.launchContext.setupOperationId || null,
      seedDefaults: bootstrapState.launchContext.seedDefaults === true
    };
  }

  if (bootstrapState?.prereqReadiness) {
    setupState.prereqReadiness = {
      readyForAuth: Boolean(bootstrapState.prereqReadiness.readyForAuth),
      reason: bootstrapState.prereqReadiness.reason || 'unknown',
      missingImages: Array.isArray(bootstrapState.prereqReadiness.missingImages)
        ? bootstrapState.prereqReadiness.missingImages
        : []
    };
  }

  setupState.savedOnboardingMode = normalizeOnboardingModeSelection(
    bootstrapState?.savedOnboardingMode,
  );

  if (setupState.launchContext?.setupMode === 'identity_repair') {
    setupPointerTrackedTooltips();
    setupClipboardShortcuts();
    await resolveGuidedSetupDevBuildState();
    bindGuidedSetupDebugDrawer();
    await showStage('welcome');
    return;
  }

  if (
    setupState.launchContext?.setupMode === 'full' ||
    setupState.launchContext?.setupMode === 'runtime_repair'
  ) {
    await hydrateRequiredSetupSession();
  }

  if (setupState.launchContext?.setupMode === 'runtime_repair') {
    refreshPrereqPolicy();
    setupPointerTrackedTooltips();
    setupClipboardShortcuts();
    await resolveGuidedSetupDevBuildState();
    bindGuidedSetupDebugDrawer();
    await continueAfterModeSelection();
    return;
  }

  // Initialize env manager with project root
  envManager.init(PROJECT_ROOT);

  // Load existing environment variables
  await callbacks.loadExistingEnvVars();

  // Load MCP server configurations
  await loadMcpServerConfigs();

  // Check HOST mode support
  if (typeof bootstrapState?.hostModeEnabled === 'boolean') {
    setupState.hostModeSupported = bootstrapState.hostModeEnabled;
  } else {
    await checkHostModeSupport();
  }

  refreshPrereqPolicy();

  // Setup components
  setupWebview();
  setupResizeHandle();
  setupLeftPanelScroll();
  setupPointerTrackedTooltips();
  setupClipboardShortcuts();
  await resolveGuidedSetupDevBuildState();
  bindGuidedSetupDebugDrawer();

  // Setup confirmation card window handlers
  createWindowHandlers({
    markAccordionsAsCompleted,
    createAccordionsForVisibleContent,
    addLog,
    refreshConfigurationGuidance: () => _refreshConfigurationGuidance(callbacks),
    handleConfigurationAccordionToggle: (details) => _handleConfigurationAccordionToggle(details, callbacks),
    getConfigurationScrollContainer: () => document.querySelector('.content-scroll-area'),
    handleSkipServer: () => _handleSkipServer(setupState, callbacks),
    showStage
  });

  // Setup input field observers
  setupInputFieldObservers();

  // Load initial content in browser
  loadBrowserContent('welcome');
  setWelcomeAuthState({ loading: false, error: null });
  if (shouldStartPrereqBackgroundPrefetch()) {
    startPrereqBackgroundPrefetch();
  }
  if (setupState.launchContext?.setupMode === 'full') {
    await showStage('hello');
  }
}

// Load MCP server configurations via IPC
async function loadMcpServerConfigs() {
  const preservedSelectedServerIds = getSelectedServerIdsFromIndices(
    setupState.mcpServers,
    setupState.selectedServers,
  );

  try {
    const result = await window.electronAPI.loadMcpServers();
    if (result.success) {
      // Map the data to include needed properties
      setupState.mcpServers = result.data.map(server => ({
        ...server,
        // Ensure these properties exist for compatibility
        required_env_vars: getRequiredEnvVars(server),
        use_cases: server.useCases || server.use_cases || [],
        approval_warning: server.approvalWarning || false,
        approval_note: server.approvalNote || '',
        display_name: server.display_name || server.name,
        description: server.description || '',
        setupMarkdown: server.setupMarkdown || null,
        fragment: server.fragment || '{}',
        logoKind: server.logoKind || server.logo_kind || null,
        // OAuth configuration from YAML
        oauth: server.oauth || null,
        guidedSetupDescription: getGuidedSetupDescription(server)
      }));
      if (typeof envManager.configureSensitiveRequiredEnvVars === 'function') {
        envManager.configureSensitiveRequiredEnvVars(setupState.mcpServers);
        for (const server of setupState.mcpServers) {
          for (const envVar of server.required_env_vars || []) {
            if (envVar?.sensitive === true && envVar.name) {
              delete setupState.envVars[envVar.name];
            }
          }
        }
      }

      console.log('[guided-setup] Loaded', setupState.mcpServers.length, 'MCP servers');
      setupState.selectedServers = getSelectedServerIndicesFromIds(
        setupState.mcpServers,
        preservedSelectedServerIds,
      );
      setupState.selectedServers = sanitizeGuidedSetupSelectedServers(setupState.selectedServers);
    } else {
      console.error('[guided-setup] Failed to load MCP servers:', result.error);
      addLog('Failed to load MCP server configurations', 'error');
      setupState.mcpServers = [];
      setupState.selectedServers = [];
    }
  } catch (err) {
    console.error('[guided-setup] Error loading MCP servers:', err);
    addLog('Error loading MCP server configurations', 'error');
    setupState.mcpServers = [];
    setupState.selectedServers = [];
  }
}

async function loadGuidedSetupHealthStatus() {
  const candidateLoaders = [
    () => window.electronAPI?.getLastHealthStatus?.(),
    () => window.electronAPI?.getHealthStatus?.(),
  ];

  for (const loader of candidateLoaders) {
    try {
      const result = await loader();
      if (result && !result.error && result.servers && typeof result.servers === 'object') {
        return result;
      }
    } catch (_error) {
      // Try the next available health source.
    }
  }

  return null;
}

async function loadGuidedSetupToggleBaseline() {
  if (setupState.mcpToggleState?.baseline?.loaded === true) {
    return setupState.mcpToggleState.baseline.toggles;
  }
  if (typeof window.electronAPI?.loadGuidedSetupMcpToggles !== 'function') {
    throw new Error('Guided setup MCP toggle state is unavailable');
  }

  const result = await window.electronAPI.loadGuidedSetupMcpToggles();
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to load MCP toggle state');
  }
  const toggles = result.data && typeof result.data === 'object'
    ? result.data
    : {};
  setGuidedSetupToggleBaseline(setupState, toggles, {
    exists: result.exists === true,
    contentHash: result.contentHash || null,
    parseError: result.parseError || null,
  });
  return toggles;
}

async function hydrateServerSelectionFromCurrentToggles() {
  if (setupState.onboardingMode !== 'power' || setupState.serverSelectionHydrated === true) {
    return;
  }

  try {
    const toggles = await loadGuidedSetupToggleBaseline();
    const currentSelectedIds = getSelectedServerIdsFromIndices(
      setupState.mcpServers,
      setupState.selectedServers,
    );
    const serversById = new Map(
      setupState.mcpServers.map((server) => [server.id, server]),
    );
    const hasExplicitNonCoreToggleState = Object.entries(toggles).some(
      ([serverId, enabled]) =>
        typeof enabled === 'boolean' &&
        serversById.has(serverId) &&
        serversById.get(serverId)?.isCore !== true,
    );
    const defaultSelectedIds =
      setupState.launchContext?.seedDefaults === true &&
      !hasExplicitNonCoreToggleState
      ? getBasicCuratedServerIds(authenticatedSetupSession)
      : [];
    setupState.selectedServers = getHydratedGuidedSetupSelectionIndices({
      servers: setupState.mcpServers,
      selectedIndices: getSelectedServerIndicesFromIds(
        setupState.mcpServers,
        [...currentSelectedIds, ...defaultSelectedIds],
      ),
      toggles,
      hostModeSupported: setupState.hostModeSupported,
      guidedSetupDisabledServerIds: setupState.guidedSetupDisabledServerIds,
    });
    for (const serverId of defaultSelectedIds) {
      recordGuidedSetupToggleChange(setupState, serverId, true);
    }
    setupState.serverSelectionHydrated = true;
  } catch (error) {
    console.error('[guided-setup] Failed to hydrate guided setup selection:', error.message);
    throw error;
  }
}

async function advanceAfterPrerequisites() {
  setupState.completedSteps.prerequisites = true;
  setupState.completedSteps.prerequisitesWarning = false;
  updateProgressTracker(
    setupState.currentStage,
    setupState.completedSteps,
    setupState.serverConfigs,
    setupState.onboardingMode,
    setupState.prereqPolicy,
    setupState.oauthStepRequired,
    getProgressTrackerState()
  );

  if (setupState.launchContext?.setupMode === 'runtime_repair') {
    const result = await window.electronAPI?.getSetupLaunchDecision?.();
    const decision = result?.decision;
    if (!result?.success || !decision) {
      throw new Error(result?.error || 'Runtime repair could not be verified');
    }
    if (decision.action === 'runtime_repair') {
      throw new Error('Runtime prerequisites are still incomplete. Retry repair.');
    }
    window.electronAPI.electronAppComplete();
    return;
  }

  if (setupState.onboardingMode === 'basic') {
    await loadMcpServerConfigs();
    await loadGuidedSetupToggleBaseline();
    setupState.selectedServers = validateBasicBundleSelection(authenticatedSetupSession);
    for (const index of setupState.selectedServers) {
      const serverId = setupState.mcpServers[index]?.id;
      recordGuidedSetupToggleChange(setupState, serverId, true);
    }
    await _proceedToConfiguration(setupState, callbacks);
    return;
  }

  await showStage('server-selection');
}

// Check HOST mode support via secure IPC
async function checkHostModeSupport() {
  try {
    const result = await window.electronAPI.checkHostMode();
    setupState.hostModeSupported = result.supported === true;
    console.log('[guided-setup] HOST mode supported:', setupState.hostModeSupported);
  } catch (err) {
    console.log('[guided-setup] HOST_MODE check failed, assuming not supported');
    setupState.hostModeSupported = false;
  }
}

// Setup input field observers for paste functionality
function setupInputFieldObservers() {
  const fixInputField = (input) => {
    input.removeAttribute('readonly');
    input.style.webkitUserSelect = 'text';
    input.style.userSelect = 'text';
    input.style.pointerEvents = 'auto';
  };

  // Apply to existing input fields
  document.querySelectorAll('.input-field').forEach(fixInputField);

  // Watch for new input fields
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) {
          if (node.classList && node.classList.contains('input-field')) {
            fixInputField(node);
          }
          node.querySelectorAll && node.querySelectorAll('.input-field').forEach(fixInputField);
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Make key functions globally available for button onclick handlers
console.log('[guided-setup.js] ===== SETTING WINDOW FUNCTIONS =====');
console.log('[guided-setup.js] window.startSetup BEFORE:', typeof window.startSetup);

window.loadBrowserUrl = loadBrowserUrl;
window.openExternalUrl = openExternalUrl;
window.goBackToWelcome = () => {
  authenticatedSetupSession = null;
  setupState.guidedSetupDisabledServerIds.clear();
  setupState.guidedSetupDisabledTooltips = {};
  setOnboardingMode(null);
  preserveGuidedSetupToggleState(setupState);
  setupState.serverSelectionHydrated = false;
  setWelcomeAuthState({ loading: false, error: null });
  showStage('welcome');
};
window.startSetup = async function() {
  if (setupAuthFlowInProgress) {
    console.log('[guided-setup] Setup auth is already running');
    return;
  }

  const currentUserApi = window.electronAPI?.currentUser;
  const setupAuthApi = window.electronAPI?.setupAuth;
  const clearError =
    currentUserApi?.clearError ||
    setupAuthApi?.clearError ||
    (async () => null);
  const ensureAuthenticated =
    currentUserApi?.ensureAuthenticated ||
    setupAuthApi?.start;
  if (typeof ensureAuthenticated !== 'function') {
    console.error('[guided-setup] No setup auth API is available');
    setWelcomeAuthState({
      loading: false,
      error: 'Setup login is unavailable right now. Please try again.'
    });
    return;
  }

  setupAuthFlowInProgress = true;
  maximizeGuidedSetupWindow({}, 'startSetup');
  setWelcomeAuthState({
    loading: true,
    message: "First, let's get you logged in...",
    error: null
  });

  try {
    await clearError();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const result = await ensureAuthenticated();
    if (!result?.success || !result?.authenticated || !result?.sessionSummary) {
      const errorCode = getSafeSetupAuthUiCode(result);
      const message = formatSetupAuthError({ code: errorCode });
      console.error(`[guided-setup] Setup auth failed (${errorCode})`);
      setWelcomeAuthState({
        loading: false,
        error: message
      });
      return;
    }

    // PORTICO-414: identity-repair sign-ins exist to restore the session email.
    // A sign-in that succeeded WITHOUT one must error in-stage — completing
    // here would relaunch the loading gate, which detects the email-less
    // session again and loops right back to this window. Sessions missing
    // id/name fall through to the legacy identity_sync_invalid handling.
    if (
      result.sessionSummary?.user?.id &&
      result.sessionSummary?.user?.name &&
      !sessionSummaryHasPlausibleEmail(result.sessionSummary)
    ) {
      console.error('[guided-setup] Setup auth failed (identity_email_unavailable)');
      setWelcomeAuthState({
        loading: false,
        error: formatSetupAuthError({ code: 'identity_email_unavailable' })
      });
      return;
    }

    await handleSetupAuthSuccess(result.sessionSummary);
  } catch (error) {
    const errorCode = getSafeSetupAuthUiCode(error);
    console.error(`[guided-setup] Setup auth failed (${errorCode})`);
    setWelcomeAuthState({
      loading: false,
      error: formatSetupAuthError({ code: errorCode })
    });
  } finally {
    setupAuthFlowInProgress = false;
  }
};

window.selectHelloMode = async function selectHelloMode(mode) {
  if ((mode !== 'basic' && mode !== 'power') || helloModeSelectionInProgress) {
    return;
  }

  const previousSavedMode = setupState.savedOnboardingMode;
  setHelloModeError(null);
  syncHelloModeSelectionUI(mode);
  helloModeSelectionInProgress = true;
  setHelloModeSelectionState(true);

  try {
    let savePreferenceResult;
    try {
      savePreferenceResult = await window.electronAPI?.saveGuidedSetupModePreference?.(mode);
    } catch (error) {
      const errorMessage = error?.message || 'We could not remember your setup choice. Please try again.';
      setupState.savedOnboardingMode = previousSavedMode;
      syncHelloModeSelectionUI(previousSavedMode);
      setHelloModeError(errorMessage);
      addLog(`Failed to persist guided setup mode preference: ${errorMessage}`, 'error');
      console.error('[guided-setup] Error while persisting guided setup mode preference:', error);
      return;
    }

    if (savePreferenceResult?.success !== true) {
      const errorMessage = savePreferenceResult?.error || 'We could not remember your setup choice. Please try again.';
      setupState.savedOnboardingMode = previousSavedMode;
      syncHelloModeSelectionUI(previousSavedMode);
      setHelloModeError(errorMessage);
      addLog(`Failed to persist guided setup mode preference: ${errorMessage}`, 'error');
      console.warn('[guided-setup] Failed to persist guided setup mode preference:', errorMessage);
      return;
    }

    setupState.savedOnboardingMode = mode;
    preserveGuidedSetupToggleState(setupState);
    setupState.serverSelectionHydrated = false;
    setupState.selectedServers = [];
    setupState.oauthServers = [];
    setupState.oauthStepRequired = null;
    setupState.serverConfigs = [];
    setupState.completedSteps.serverSelection = false;
    setupState.completedSteps.oauth = false;
    setupState.currentOAuthIndex = 0;
    setupState.currentServerIndex = 0;
    setupState.configuredServers.clear();
    setupState.preConfiguredServers?.clear?.();
    setupState.skippedServers.clear();
    setupState.completedOAuthServers.clear();
    setupState.connectedOAuthServers?.clear?.();
    setupState.skippedOAuthServers.clear();
    setOnboardingMode(mode);
    refreshPrereqPolicy();
    await continueAfterModeSelection();
  } finally {
    helloModeSelectionInProgress = false;
    if (setupState.currentStage === 'hello') {
      syncHelloModeSelectionUI();
      setHelloModeSelectionState(false);
    }
  }
};

console.log('[guided-setup.js] window.startSetup AFTER:', typeof window.startSetup);
console.log('[guided-setup.js] window.startSetup source:', window.startSetup.toString().substring(0, 100));
window.selectAllServers = () => _selectAllServers(setupState, callbacks);
window.selectAllUnconfigured = () => _selectAllUnconfigured(setupState, callbacks);
window.selectAllConfigured = () => _selectAllConfigured(setupState, callbacks);
window.selectAllOAuth = () => _selectAllOAuth(setupState, callbacks);
window.selectAllConfig = () => _selectAllConfig(setupState, callbacks);
window.selectAllReady = () => _selectAllReady(setupState, callbacks);
window.skipServerSelection = () => _skipServerSelection(setupState, callbacks);
window.proceedToConfiguration = () => _proceedToConfiguration(setupState, callbacks);
window.previousServer = () => _previousServer(setupState, callbacks);
window.skipServer = () => _skipServer(setupState, callbacks);
window.skipAllServers = () => _skipAllServers(setupState, callbacks);
window.saveAndContinue = () => _saveAndContinue(setupState, false, callbacks);
window.handleSaveAndContinue = () => _handleSaveAndContinue(setupState, callbacks);
window.handleSkipServer = () => _handleSkipServer(setupState, callbacks);
window.handleSkipAllServers = () => _handleSkipAllServers(setupState, callbacks);
window.showBrowser = () => _showBrowser(setupState);
window.hideBrowser = () => _hideBrowser(setupState);
window.showGuidedSetupDebugDrawer = showGuidedSetupDebugDrawer;
window.hideGuidedSetupDebugDrawer = hideGuidedSetupDebugDrawer;
window.notifyGuidedSetupDebugUpdate = scheduleGuidedSetupDebugRefresh;
window.collectGuidedSetupDebugInfo = collectGuidedSetupDebugInfo;
window.jumpToServer = (index) => _jumpToServer(index, setupState, callbacks);
window.launchApp = _launchApp;
window.navigateToStep = navigateToStep;
window.updateProgressTracker = () => updateProgressTracker(
  setupState.currentStage,
  setupState.completedSteps,
  setupState.serverConfigs,
  setupState.onboardingMode,
  setupState.prereqPolicy,
  setupState.oauthStepRequired,
  getProgressTrackerState()
);
window.setupWebview = setupWebview;
window.toggleAccordion = toggleAccordion;
window.copyToClipboard = copyToClipboard;
window.showStage = showStage;
window.addLog = addLog;
window.retryPrerequisites = _retryPrerequisites;
window.checkVpnAndContinue = () => _runVpnCheck(setupState, callbacks);

// DOMContentLoaded handler
document.addEventListener('DOMContentLoaded', () => {
  initialize().catch(err => {
    console.error('[guided-setup] Initialization failed:', err);
    addLog('Failed to initialize setup wizard', 'error');
  });
});

// Export for testing
module.exports = {
  initialize,
  showStage,
  navigateToStep,
  addLog,
  callbacks,
  _test: {
    escapeDebugHtml,
    formatDebugTimestamp,
    getGuidedSetupDebugBucket,
    recordGuidedSetupDebugEntry,
    formatGuidedSetupDebugEntry,
    buildGuidedSetupTimelineSections,
    buildGuidedSetupDebugDocument,
    getOAuthDebugSections,
    setGuidedSetupDebugStatus,
    renderGuidedSetupDebugSections,
    buildGuidedSetupDebugSections,
    refreshGuidedSetupDebugDrawer,
    scheduleGuidedSetupDebugRefresh,
    showGuidedSetupDebugDrawer,
    hideGuidedSetupDebugDrawer,
    copyGuidedSetupDebugLogs,
    collectGuidedSetupDebugInfo,
    isGuidedSetupDevBuild,
    setGuidedSetupDebugTestPanelVisible,
    syncGuidedSetupDebugTestPanelVisibility,
    resolveGuidedSetupDevBuildState,
    forceGuidedSetupPrereqErrorState,
    clearGuidedSetupPrereqErrorState,
    bindGuidedSetupDebugDrawer,
    refreshPrereqPolicy,
    prerequisitesStepIsVisible,
    canAdvancePastPrerequisites,
    shouldStartPrereqBackgroundPrefetch,
    applyPrereqSkipState,
    getGuidedSetupLaunchSource,
    setWelcomeAuthState,
    getHelloFirstName,
    escapeHelloAttr,
    createHelloLogoChip,
    setHelloModeSelectionState,
    normalizeOnboardingModeSelection,
    getRememberedHelloMode,
    setHelloModeError,
    syncHelloModeSelectionUI,
    renderHelloStage,
    maximizeGuidedSetupWindow,
    startPrereqBackgroundPrefetch,
    normalizeSetupAuthMessage,
    getSafeSetupAuthUiCode,
    formatSetupAuthError,
    getAuthenticatedSetupEmail,
    isContractorGuidedSetupEmail,
    isContractorGuidedSetupSession,
    getGuidedSetupDisabledServerPolicy,
    syncGuidedSetupDisabledServerPolicy,
    getBasicCuratedServerIds,
    sanitizeGuidedSetupSelectedServers,
    persistAuthenticatedUser,
    validateBasicBundleSelection,
    resetGuidedSetupProgressForRetry,
    restartSetupWizardFromFinalize,
    continueAfterModeSelection,
    loadMcpServerConfigs,
    loadGuidedSetupHealthStatus,
    hydrateServerSelectionFromCurrentToggles,
    advanceAfterPrerequisites,
    checkHostModeSupport,
    setupLeftPanelScroll,
    setupPointerTrackedTooltips,
    setupInputFieldObservers,
    setGuidedSetupDebugState(nextState = {}) {
      Object.assign(guidedSetupDebugState, nextState);
    },
    getGuidedSetupDebugState() {
      return guidedSetupDebugState;
    },
    setAuthenticatedSetupSession(sessionSummary) {
      authenticatedSetupSession = sessionSummary;
      syncGuidedSetupDisabledServerPolicy(sessionSummary);
    },
  },
};
