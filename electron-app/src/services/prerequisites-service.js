// prerequisites-service.js - Electron main process orchestrator for prerequisite shell scripts
// Orchestrates 4 phases: Download, Dependencies, Docker Setup, Host Mode Check
// Streams stdout/stderr to renderer, parses progress markers, handles retries

const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, powerSaveBlocker } = require('electron');

const stopGuard = require('./managed-runtime-stop-guard');
const state = require('./shared-state');
const bootstrap = require('./bootstrap');
const { getPrereqLogger, logPrereq } = require('./prereq-logger');
const cloudsmithConfig = require('../config/cloudsmith-config');
const { buildDockerImagesToPull, harborToLocalImageRef, HARBOR_IMAGE_BASE } = require('./docker-image-plan');
const { resolveMcpOrcBinary } = require('./mcp-orc-cli');
const { resolvePrerequisitesDownloadTarget } = require('./prerequisites-download-target');
const {
  describeBuildIdentity,
  getPreparedRuntimeRepairCandidate,
  readBuildInfoFile,
  resolveBuildIdentity,
} = require('./runtime-repair');
const { createRuntimeShellEnv } = require('./runtime-shell-env');
const { resolveBuildChannel } = require('../utils/build-info');
const {
  getPackageSlug,
  isUpdateReadyPackage,
  resolveEolRedirectForPackage,
  UPDATE_READY_TAG,
} = require('./cloudsmith-release-routing');
const {
  evaluateSetupRequirementStatus,
  inspectRequiredHostPrerequisites,
} = require('./setup-completion');
const { buildEnhancedPath } = require('./env-paths');
const { readHostModeFileSync } = require('./host-mode-state');
const { runManagedProcess } = require('./managed-process');
const {
  secureCloudsmithBootstrapSecrets,
} = require('../config/runtime-secrets-config');
const {
  appendUpdateHistory,
  persistApplyAudit,
} = require('./update-apply-audit');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_MANAGED_ROOT = path.join(os.homedir(), 'portico', 'portico-managed');
const NODE_VERSION_REQUIRED = process.env.NODE_VERSION_REQUIRED || '20.19.0';
const DEFAULT_RUNTIME_SETTINGS = {
  MCP_ORC_MODE: 'rust-full',
  MCP_ORC_BACKEND: 'rust-full',
  LLM_GATEWAY_MODE: 'bifrost'
};

function isRootPath(candidate) {
  if (!candidate) return true;
  const resolved = path.resolve(candidate);
  return resolved === path.parse(resolved).root;
}

function ensureWritableDir(dirPath) {
  if (!dirPath || isRootPath(dirPath)) return false;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    return false;
  }
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function getSafeProjectRoot() {
  const configuredRoot = bootstrap.PROJECT_ROOT;
  if (ensureWritableDir(configuredRoot)) {
    return configuredRoot;
  }

  if (ensureWritableDir(DEFAULT_MANAGED_ROOT)) {
    return DEFAULT_MANAGED_ROOT;
  }

  return process.cwd();
}

function secureCloudsmithBootstrapAfterManagedRuntimeUpdate(options = {}) {
  const isPackagedApp = options.isPackagedApp ?? app.isPackaged;
  const platform = options.platform || process.platform;
  if (!isPackagedApp || platform !== 'darwin') {
    return { skipped: true };
  }

  const managedRoot = options.managedRoot || getSafeProjectRoot();
  const result = secureCloudsmithBootstrapSecrets({
    env: options.env || process.env,
    projectRoot: options.projectRoot || managedRoot,
    resourcesPath: options.resourcesPath || process.resourcesPath,
    managedRoot,
    isPackagedApp: true,
    platform,
  });
  console.log(
    '[Prerequisites] Cloudsmith bootstrap values verified in Keychain and scrubbed from the managed runtime',
  );
  return result;
}

function readEnvValueFromFile(filePath, key) {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function getRuntimeFilePath(projectRoot = getSafeProjectRoot()) {
  return path.join(projectRoot, '.env.runtime');
}

function getEnvFilePath(projectRoot = getSafeProjectRoot()) {
  return path.join(projectRoot, '.env');
}

function getConfiguredRuntimeValue(key, env = process.env, projectRoot = getSafeProjectRoot()) {
  return env[key] ||
    readEnvValueFromFile(getRuntimeFilePath(projectRoot), key) ||
    readEnvValueFromFile(getEnvFilePath(projectRoot), key) ||
    '';
}

function buildRuntimePlanningEnv(env = process.env, projectRoot = getSafeProjectRoot()) {
  const planningEnv = { ...env };

  for (const [key, fallbackValue] of Object.entries(DEFAULT_RUNTIME_SETTINGS)) {
    if (!getConfiguredRuntimeValue(key, env, projectRoot)) {
      planningEnv[key] = fallbackValue;
    }
  }

  return planningEnv;
}

function upsertRuntimeEnvValue(content, key, value) {
  const normalized = typeof content === 'string' ? content : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (pattern.test(normalized)) {
    return normalized.replace(pattern, line);
  }

  if (!normalized.trim()) {
    return `${line}\n`;
  }

  const suffix = normalized.endsWith('\n') ? '' : '\n';
  return `${normalized}${suffix}${line}\n`;
}

function ensureManagedRuntimeDefaults(targetWindow = null) {
  const emitToWindow = createEmitter(targetWindow);
  const projectRoot = getSafeProjectRoot();
  const runtimeFile = getRuntimeFilePath(projectRoot);
  const envFile = getEnvFilePath(projectRoot);

  let runtimeContent = fs.existsSync(runtimeFile)
    ? fs.readFileSync(runtimeFile, 'utf8')
    : '';
  let changed = false;
  const applied = {};

  for (const [key, value] of Object.entries(DEFAULT_RUNTIME_SETTINGS)) {
    const currentValue = getConfiguredRuntimeValue(key, process.env, projectRoot);
    if (currentValue) {
      continue;
    }

    runtimeContent = upsertRuntimeEnvValue(runtimeContent, key, value);
    applied[key] = value;
    changed = true;
  }

  if (!changed) {
    return { changed: false, applied };
  }

  ensureWritableDir(projectRoot);
  fs.writeFileSync(runtimeFile, runtimeContent, 'utf8');
  addLogLine(
    `Seeded runtime defaults in ${path.relative(projectRoot, runtimeFile) || '.env.runtime'}: ${Object.entries(applied).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    'info',
    emitToWindow
  );

  if (!fs.existsSync(envFile)) {
    addLogLine(
      `No .env found in managed runtime tree; continuing with defaults from ${path.basename(runtimeFile)}.`,
      'info',
      emitToWindow
    );
  }

  return { changed: true, applied };
}

// Scripts directory (relative to PROJECT_ROOT)
const getProjectScriptsDir = () => {
  if (bootstrap.PROJECT_ROOT && !isRootPath(bootstrap.PROJECT_ROOT) && bootstrap.SCRIPTS_DIR) {
    return bootstrap.SCRIPTS_DIR;
  }
  return path.join(getSafeProjectRoot(), 'src', 'scripts');
};

function checkLocalDockerImageExists(imageRef) {
  try {
    const enhancedPath = buildEnhancedPath(process.env.PATH || '');
    execSync(`docker image inspect "${imageRef}"`, {
      stdio: 'pipe',
      env: { ...process.env, PATH: enhancedPath }
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePrereqScriptPath(scriptName) {
  if (typeof bootstrap.resolveScriptPath === 'function') {
    const resolved = bootstrap.resolveScriptPath(scriptName);
    if (resolved) return resolved;
  }
  if (typeof bootstrap.ensureProjectScript === 'function') {
    const staged = bootstrap.ensureProjectScript(scriptName);
    if (staged) return staged;
  }
  return path.join(getProjectScriptsDir(), scriptName);
}

// Phase configuration with retry counts
const PHASES = {
  1: { script: 'prereq-download.sh', label: 'Downloading auxiliary data...', retries: 2 },
  2: { script: 'prereq-dependencies.sh', label: 'Installing core dependencies...', retries: 1 },
  3: { script: 'prereq-docker-setup.sh', label: 'Preparing workspace...', retries: 1 },
  4: { script: 'prereq-host-mode.sh', label: 'Setting up host mode...', retries: 0 }
};

// Timeouts per phase (ms)
const PHASE_TIMEOUTS = {
  1: 3600000,  // 60 min safety cap for download/setup
  2: 2400000,  // 40 min for dependencies (CLT install can be slow)
  3: 600000,  // 10 min for docker setup
  4: 60000    // 1 min for host mode check
};
const RUNTIME_UPDATE_TIMEOUT_MS = 900000;  // 15 min for staged runtime update
const PHASE1_DOWNLOAD_STALL_TIMEOUT_MS = 20 * 60 * 1000;
const PHASE1_DOWNLOAD_STALLED_CODE = 'phase1_download_stalled';
const PHASE1_DOWNLOAD_STALLED_MESSAGE =
  'The setup download stopped receiving new bytes for 20 minutes. Check your network or VPN, then click Retry.';

// Retry configuration
const RETRY_BASE_DELAY = 2000;  // 2 seconds
const RETRY_MAX_DELAY = 30000;  // 30 seconds max

// Log buffer configuration
const MAX_LOG_LINES = 500;
const LOG_THROTTLE_MS = 100;

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let activeProcess = null;
let activePhase = null;
let cancelled = false;
let isRunning = false;
let startedAt = null;
let lastError = null;
let lineBuffer = '';  // For handling partial lines across chunks
let logRingBuffer = [];
let lastLogEmit = 0;
let phaseStepFailures = {};
let prefetchPromise = null;
let backgroundContinuationPromise = null;
let interactiveContinuationPromise = null;
let sessionCounter = 0;
const activeDockerPullControllers = new Map();
let currentDockerPullWave = null;
let activeSnapshotStoreRecovery = null;

function createEmptyDockerPullState() {
  return {
    running: false,
    totalImages: 0,
    completedCount: 0,
    failedCount: 0,
    deferredCount: 0,
    currentLabel: null,
    aggregatePercent: 0,
    images: {}
  };
}

function createEmptySession() {
  return {
    id: 0,
    startedAt: null,
    mode: null,
    buildNumber: null,
    targetWindow: null,
    activeStep: null,
    currentSequence: 'idle',
    startedEventEmitted: false,
    phaseResults: {
      phase1: null,
      phase2: null,
      phase3: null,
      dockerPull: null,
      phase4: null
    },
    blockingReady: false,
    backgroundReady: false,
    lastError: null,
    lastFailureCode: null,
    lastFailureDetails: [],
    lastFailureRecovery: null,
    skipHomebrewAuthOnRetry: false,
    failedPhase: null,
    dockerPull: createEmptyDockerPullState(),
    phase1Progress: createEmptyPhase1Progress()
  };
}

let prerequisitesSession = createEmptySession();

function resetRuntimeState({ preserveLogs = false } = {}) {
  activeProcess = null;
  activePhase = null;
  cancelled = false;
  isRunning = false;
  startedAt = null;
  lastError = null;
  lineBuffer = '';
  lastLogEmit = 0;
  phaseStepFailures = {};
  if (!preserveLogs) {
    logRingBuffer = [];
  }
}

function resetPrerequisitesSession(options = {}) {
  const { onboardingMode, buildNumber, targetWindow, preserveLogs = false } = options;
  prerequisitesSession = createEmptySession();
  prerequisitesSession.id = ++sessionCounter;
  prerequisitesSession.mode = normalizeOnboardingMode(onboardingMode);
  prerequisitesSession.buildNumber = typeof buildNumber === 'string' ? buildNumber : null;
  prerequisitesSession.targetWindow = targetWindow || null;
  resetRuntimeState({ preserveLogs });
  return prerequisitesSession;
}

function shouldResetSession(options = {}) {
  if (!prerequisitesSession.startedAt) {
    return true;
  }
  if (prerequisitesSession.currentSequence === 'complete') {
    return false;
  }
  if (prerequisitesSession.currentSequence === 'failed' || prerequisitesSession.currentSequence === 'cancelled') {
    return true;
  }
  if (typeof options.buildNumber === 'string' && prerequisitesSession.buildNumber && prerequisitesSession.buildNumber !== options.buildNumber) {
    return true;
  }
  return false;
}

function ensurePrerequisitesSession(options = {}) {
  const {
    onboardingMode,
    buildNumber,
    targetWindow,
    preserveLogs = true,
    previousFailureCode = null,
    skipHomebrewAuthOnRetry = false,
  } = options;
  if (shouldResetSession(options)) {
    resetPrerequisitesSession({ onboardingMode, buildNumber, targetWindow, preserveLogs: false });
  }

  const normalizedOnboardingMode = normalizeOnboardingMode(onboardingMode);
  if (normalizedOnboardingMode) {
    prerequisitesSession.mode = normalizedOnboardingMode;
  }

  if (typeof buildNumber === 'string' && buildNumber.trim()) {
    prerequisitesSession.buildNumber = buildNumber.trim();
  }
  if (targetWindow) {
    prerequisitesSession.targetWindow = targetWindow;
  }
  if (typeof previousFailureCode === 'string' && previousFailureCode.trim()) {
    prerequisitesSession.lastFailureCode = previousFailureCode.trim();
  }
  if (skipHomebrewAuthOnRetry && isHomebrewAuthFailureCode(prerequisitesSession.lastFailureCode)) {
    prerequisitesSession.skipHomebrewAuthOnRetry = true;
  }
  if (!prerequisitesSession.startedAt) {
    prerequisitesSession.startedAt = Date.now();
    startedAt = prerequisitesSession.startedAt;
    if (!preserveLogs) {
      logRingBuffer = [];
    }
    const prereqLogger = getPrereqLogger();
    if (prereqLogger) {
      prereqLogger.startSession();
    }
  }

  return prerequisitesSession;
}

function createSessionEmitter(targetWindow = null) {
  return createEmitter(targetWindow || prerequisitesSession.targetWindow || null);
}

function normalizeOnboardingMode(onboardingMode) {
  if (onboardingMode === 'basic' || onboardingMode === 'power') {
    return onboardingMode;
  }
  return null;
}

function getEffectiveSessionMode(fallbackMode = 'power') {
  return normalizeOnboardingMode(prerequisitesSession.mode) || fallbackMode;
}

function isHomebrewAuthFailureCode(code) {
  return code === 'homebrew_auth_dialog_cancelled' ||
    code === 'homebrew_sudo_validation_failed' ||
    code === 'homebrew_admin_required' ||
    code === 'homebrew_osascript_probe_failed';
}

function clearFailureMetadata() {
  prerequisitesSession.lastFailureCode = null;
  prerequisitesSession.lastFailureDetails = [];
  prerequisitesSession.lastFailureRecovery = null;
}

function cloneFailureRecovery(recovery = null) {
  if (!recovery || typeof recovery !== 'object') {
    return null;
  }

  return {
    title: typeof recovery.title === 'string' ? recovery.title : null,
    diagnosis: typeof recovery.diagnosis === 'string' ? recovery.diagnosis : null,
    command: typeof recovery.command === 'string' ? recovery.command : null,
    restartOnRetry: recovery.restartOnRetry === true,
  };
}

function setFailureMetadata({ code = null, details = [], recovery = null } = {}) {
  prerequisitesSession.lastFailureCode = typeof code === 'string' && code.trim()
    ? code.trim()
    : null;
  prerequisitesSession.lastFailureDetails = Array.isArray(details)
    ? details
        .map((detail) => (typeof detail === 'string' ? detail.trim() : String(detail || '').trim()))
        .filter(Boolean)
        .slice(-20)
    : [];
  prerequisitesSession.lastFailureRecovery = cloneFailureRecovery(recovery);
}

function createEmptyPhase1Progress() {
  return {
    step: 'idle',
    activity: 'Preparing your setup...',
    percent: 0,
    bytesDownloaded: 0,
    totalBytes: null,
    downloadComplete: false,
    updatedAt: null
  };
}

function resetPhase1Progress() {
  prerequisitesSession.phase1Progress = createEmptyPhase1Progress();
}

function clampPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function setPhase1Progress(updates = {}) {
  prerequisitesSession.phase1Progress = {
    ...createEmptyPhase1Progress(),
    ...prerequisitesSession.phase1Progress,
    ...updates,
    updatedAt: Date.now()
  };
}

function updatePhase1ProgressFromMarker(metric, rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  switch (metric) {
    case 'phase1_step':
      setPhase1Progress({ step: value || 'working' });
      return;
    case 'phase1_activity':
      setPhase1Progress({ activity: value || 'Preparing your setup...' });
      return;
    case 'download_percent':
      setPhase1Progress({ percent: clampPercent(value) });
      return;
    case 'download_bytes':
      setPhase1Progress({ bytesDownloaded: Math.max(0, Number(value) || 0) });
      return;
    case 'download_total_bytes': {
      const totalBytes = Math.max(0, Number(value) || 0);
      setPhase1Progress({ totalBytes: totalBytes > 0 ? totalBytes : null });
      return;
    }
    case 'download_complete':
      setPhase1Progress({ downloadComplete: value === 'true' || value === '1', percent: 100 });
      return;
    default:
      return;
  }
}

function emitPrerequisitesStartIfNeeded(targetWindow = null) {
  const session = prerequisitesSession;
  if (session.startedEventEmitted) {
    return;
  }
  session.startedEventEmitted = true;
  const emitToWindow = createSessionEmitter(targetWindow);
  emitToWindow('prerequisites-start', { totalPhases: 4 });
  const prereqLogger = getPrereqLogger();
  if (prereqLogger) prereqLogger.logIpcEvent('prerequisites-start', { totalPhases: 4 });
}

function updateDerivedSessionState() {
  const session = prerequisitesSession;
  const phaseResults = session.phaseResults;
  session.blockingReady = Boolean(phaseResults.phase1?.success && phaseResults.phase2?.success);
  const dockerPlanReady =
    phaseResults.dockerPull?.success === true ||
    (session.dockerPull.totalImages > 0 && (session.dockerPull.completedCount + session.dockerPull.deferredCount) >= session.dockerPull.totalImages);
  const hostReady =
    session.mode === 'basic' ||
    (phaseResults.phase4?.success === true && phaseResults.phase4?.skipped !== true);

  session.backgroundReady = Boolean(phaseResults.phase3?.success && dockerPlanReady && hostReady);
  lastError = session.lastError;
}

function markSessionFailure(errorMessage, failedPhase = activePhase || null) {
  prerequisitesSession.lastError = errorMessage || 'Prerequisites failed';
  prerequisitesSession.failedPhase = failedPhase;
  prerequisitesSession.activeStep = null;
  prerequisitesSession.currentSequence = 'failed';
  lastError = prerequisitesSession.lastError;
  isRunning = false;
  updateDerivedSessionState();
}

function markSessionCancelled() {
  prerequisitesSession.currentSequence = 'cancelled';
  prerequisitesSession.lastError = 'Cancelled';
  prerequisitesSession.activeStep = null;
  lastError = 'Cancelled';
  isRunning = false;
  updateDerivedSessionState();
}

function setSessionDockerPlan(images = []) {
  const dockerState = prerequisitesSession.dockerPull;
  dockerState.running = images.length > 0;
  dockerState.totalImages = images.length;
  dockerState.completedCount = 0;
  dockerState.failedCount = 0;
  dockerState.deferredCount = 0;
  dockerState.currentLabel = null;
  dockerState.aggregatePercent = 0;
  dockerState.images = {};

  images.forEach((imageSpec) => {
    const imageRef = `${imageSpec.name}:${imageSpec.tag}`;
    dockerState.images[imageRef] = {
      image: imageRef,
      label: imageSpec.label || imageRef,
      status: 'waiting',
      percent: 0,
      eta: null
    };
  });

  updateDerivedSessionState();
}

function updateSessionDockerImage(imageRef, updates = {}) {
  if (!imageRef) return;
  const dockerState = prerequisitesSession.dockerPull;
  const existing = dockerState.images[imageRef] || {
    image: imageRef,
    label: updates.label || imageRef,
    status: 'waiting',
    percent: 0,
    eta: null
  };
  const next = {
    ...existing,
    ...updates
  };
  dockerState.images[imageRef] = next;
  if (next.status === 'pulling' || next.status === 'extracting' || next.status === 'retrying' || next.status === 'starting') {
    dockerState.currentLabel = next.label || imageRef;
  }

  const imageStates = Object.values(dockerState.images);
  dockerState.completedCount = imageStates.filter((item) => item.status === 'complete').length;
  dockerState.failedCount = imageStates.filter((item) => item.status === 'failed').length;
  dockerState.deferredCount = imageStates.filter((item) => item.status === 'deferred').length;
  dockerState.aggregatePercent = imageStates.length === 0
    ? 0
    : Math.round(imageStates.reduce((sum, item) => sum + Math.max(0, Math.min(100, Number(item.percent) || 0)), 0) / imageStates.length);
  updateDerivedSessionState();
}

function finalizeSessionDockerPlan({ success = false } = {}) {
  const dockerState = prerequisitesSession.dockerPull;
  dockerState.running = false;
  if (success) {
    dockerState.aggregatePercent = 100;
  }
  updateDerivedSessionState();
}

function getDockerImagePlanSummary() {
  let dockerImages = [];
  try {
    dockerImages = getDockerImagesToPull().map((spec) => ({
      name: spec.name,
      tag: spec.tag,
      label: spec.label,
      image: `${spec.name}:${spec.tag}`
    }));
  } catch (error) {
    console.warn('[Prerequisites] Failed to build Docker image plan for status:', error.message);
  }
  return dockerImages;
}

function buildDetailedStatus() {
  updateDerivedSessionState();
  return {
    running: isRunning,
    cancelled,
    activePhase,
    activeStep: prerequisitesSession.activeStep,
    startedAt: prerequisitesSession.startedAt || startedAt,
    lastError: prerequisitesSession.lastError || lastError,
    elapsedMs: prerequisitesSession.startedAt ? Date.now() - prerequisitesSession.startedAt : null,
    dockerImages: getDockerImagePlanSummary(),
    recentLogs: logRingBuffer.slice(-50),
    currentSequence: prerequisitesSession.currentSequence,
    onboardingMode: prerequisitesSession.mode,
    blockingReady: prerequisitesSession.blockingReady,
    backgroundReady: prerequisitesSession.backgroundReady,
    lastFailureCode: prerequisitesSession.lastFailureCode,
    lastFailureDetails: [...(prerequisitesSession.lastFailureDetails || [])],
    lastFailureRecovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
    failedPhase: prerequisitesSession.failedPhase,
    phaseResults: prerequisitesSession.phaseResults,
    phase1Progress: { ...prerequisitesSession.phase1Progress },
    dockerPull: {
      ...prerequisitesSession.dockerPull,
      images: Object.values(prerequisitesSession.dockerPull.images || {})
    }
  };
}

const GENERIC_GUIDED_SETUP_PREREQ_ERROR =
  'Oops, something went wrong. Please navigate to the prereqs step.';

function getHostDockerArchitecture() {
  switch (os.arch()) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'amd64';
    default:
      return os.arch();
  }
}

function inspectDockerImageArchitecture(imageRef) {
  try {
    const enhancedPath = buildEnhancedPath(process.env.PATH || '');
    const arch = execSync(`docker image inspect --format '{{.Architecture}}' "${imageRef}"`, {
      stdio: 'pipe',
      env: { ...process.env, PATH: enhancedPath }
    }).toString().trim();
    return arch || null;
  } catch {
    return null;
  }
}

function isDockerImageReady(imageRef) {
  if (!checkLocalDockerImageExists(imageRef)) {
    return false;
  }
  const expectedArch = getHostDockerArchitecture();
  const imageArch = inspectDockerImageArchitecture(imageRef);
  return Boolean(imageArch && imageArch === expectedArch);
}

function getBundledBuildNumber() {
  const buildInfo = readBundledBuildInfo();
  const buildNumber = buildInfo.success && typeof buildInfo.data?.buildNumber === 'string'
    ? buildInfo.data.buildNumber.trim()
    : '';
  return buildNumber;
}

function isPackagedManagedBuild() {
  if (!app.isPackaged) {
    return false;
  }

  const buildNumber = getBundledBuildNumber();
  if (!buildNumber) {
    return true;
  }

  return buildNumber !== 'dev-build';
}

function isLocalImageAliasAllowedForSpec(imageSpec) {
  if (!imageSpec?.name || !imageSpec?.tag) {
    return true;
  }

  const exactRef = `${imageSpec.name}:${imageSpec.tag}`;
  if (!harborToLocalImageRef(exactRef)) {
    return true;
  }

  return !isPackagedManagedBuild();
}

function getCandidateImageRefsForSpec(imageSpec) {
  if (!imageSpec?.name || !imageSpec?.tag) return [];
  const exactRef = `${imageSpec.name}:${imageSpec.tag}`;
  const candidateRefs = [exactRef];
  if (isLocalImageAliasAllowedForSpec(imageSpec)) {
    candidateRefs.push(harborToLocalImageRef(exactRef));
  }
  return [...new Set(candidateRefs.filter(Boolean))];
}

function inspectRequiredImageSpec(imageSpec) {
  const wrongArchitectureImages = [];

  for (const imageRef of getCandidateImageRefsForSpec(imageSpec)) {
    if (!checkLocalDockerImageExists(imageRef)) {
      continue;
    }

    const expectedArch = getHostDockerArchitecture();
    const imageArch = inspectDockerImageArchitecture(imageRef);
    if (imageArch && imageArch === expectedArch) {
      return {
        readyRef: imageRef,
        wrongArchitectureImages,
      };
    }

    if (imageArch) {
      wrongArchitectureImages.push({
        image: imageRef,
        actualArch: imageArch,
        expectedArch,
      });
    }
  }

  return {
    readyRef: null,
    wrongArchitectureImages,
  };
}

function resolveReadyImageForSpec(imageSpec) {
  return inspectRequiredImageSpec(imageSpec).readyRef;
}

function formatWrongArchitectureImageList(wrongArchitectureImages = []) {
  if (!Array.isArray(wrongArchitectureImages) || wrongArchitectureImages.length === 0) {
    return '';
  }

  const details = wrongArchitectureImages
    .slice(0, 3)
    .map(({ image, actualArch, expectedArch }) => `${image} (${actualArch} on ${expectedArch})`)
    .join(', ');
  const remaining = wrongArchitectureImages.length - 3;
  return remaining > 0 ? `${details}, plus ${remaining} more` : details;
}

function buildImageReadinessError(imageState, fallbackError) {
  const wrongArchitectureImages = Array.isArray(imageState?.wrongArchitectureImages)
    ? imageState.wrongArchitectureImages
    : [];
  if (wrongArchitectureImages.length > 0) {
    return `Required Docker images use the wrong architecture for this Mac: ${formatWrongArchitectureImageList(wrongArchitectureImages)}`;
  }

  return fallbackError || GENERIC_GUIDED_SETUP_PREREQ_ERROR;
}

function buildAuthorizeRequiredImageSpecs() {
  const tag = getHarborImageTag();
  return [
    { name: 'nginx', tag: 'alpine', label: 'Nginx' },
    { name: `${HARBOR_IMAGE_BASE}/mcp-orc-rust`, tag, label: 'MCP Runtime' }
  ];
}

function isAuthorizeCriticalImageSpec(imageSpec) {
  if (!imageSpec?.name || !imageSpec?.tag) {
    return false;
  }

  return (
    (imageSpec.name === 'nginx' && imageSpec.tag === 'alpine') ||
    (imageSpec.name === `${HARBOR_IMAGE_BASE}/mcp-orc-rust` && imageSpec.tag === getHarborImageTag())
  );
}

function prioritizeDockerImagesForPull(images = []) {
  return images
    .map((imageSpec, index) => ({
      imageSpec,
      index,
      priority: isAuthorizeCriticalImageSpec(imageSpec) ? 0 : 1
    }))
    .sort((left, right) => (
      left.priority - right.priority ||
      left.index - right.index
    ))
    .map((entry) => entry.imageSpec);
}

function calculateRequiredImageProgress(requiredSpecs = []) {
  if (!Array.isArray(requiredSpecs) || requiredSpecs.length === 0) {
    return {
      readyCount: 0,
      total: 0,
      percent: 100,
      missing: [],
      readyImages: [],
      wrongArchitectureImages: [],
    };
  }

  const readyImages = [];
  const missing = [];
  const wrongArchitectureImages = [];
  let totalPercent = 0;

  requiredSpecs.forEach((spec) => {
    const exactRef = `${spec.name}:${spec.tag}`;
    const readiness = inspectRequiredImageSpec(spec);
    const readyRef = readiness.readyRef;
    if (readyRef) {
      readyImages.push(readyRef);
      totalPercent += 100;
      return;
    }

    wrongArchitectureImages.push(...readiness.wrongArchitectureImages);
    const dockerEntry = prerequisitesSession.dockerPull.images[exactRef];
    totalPercent += Math.max(0, Math.min(100, Number(dockerEntry?.percent) || 0));
    missing.push(exactRef);
  });

  return {
    readyCount: readyImages.length,
    total: requiredSpecs.length,
    percent: Math.round(totalPercent / requiredSpecs.length),
    missing,
    readyImages,
    wrongArchitectureImages,
  };
}

function buildReadinessPayload({ requiredSpecs, blockingInstallStillRunning, errorMessage }) {
  const imageState = calculateRequiredImageProgress(requiredSpecs);
  const ready = imageState.readyCount === imageState.total;
  return {
    ready,
    waiting: !ready && blockingInstallStillRunning,
    progressPercent: ready ? 100 : imageState.percent,
    requiredImages: requiredSpecs.map((spec) => `${spec.name}:${spec.tag}`),
    readyImages: imageState.readyImages,
    missingImages: imageState.missing,
    wrongArchitectureImages: imageState.wrongArchitectureImages,
    error: !ready && !blockingInstallStillRunning
      ? buildImageReadinessError(imageState, errorMessage)
      : null
  };
}

function buildBlockedReadiness(requiredSpecs, errorMessage) {
  return {
    ready: false,
    waiting: false,
    progressPercent: 0,
    requiredImages: requiredSpecs.map((spec) => `${spec.name}:${spec.tag}`),
    readyImages: [],
    missingImages: requiredSpecs.map((spec) => `${spec.name}:${spec.tag}`),
    wrongArchitectureImages: [],
    error: errorMessage || GENERIC_GUIDED_SETUP_PREREQ_ERROR
  };
}

function isHostModeEnabled(projectRoot = getSafeProjectRoot()) {
  return readHostModeFileSync(path.join(projectRoot, 'HOST_MODE'));
}

function normalizeInstalledReadinessScope(scope) {
  return scope === 'authorize' ? 'authorize' : 'finalize';
}

function getRequiredSpecsForInstalledReadiness(scope = 'finalize') {
  return scope === 'authorize'
    ? buildAuthorizeRequiredImageSpecs()
    : getDockerImagesToPull();
}

function normalizeSelectedServerIds(selectedServerIds = []) {
  if (!Array.isArray(selectedServerIds)) {
    return [];
  }

  return [...new Set(
    selectedServerIds
      .map((serverId) => (typeof serverId === 'string' ? serverId.trim() : ''))
      .filter(Boolean)
  )];
}

function mergeImageSpecs(baseSpecs = [], extraSpecs = []) {
  const merged = [];
  const seen = new Set();

  for (const image of [...baseSpecs, ...extraSpecs]) {
    if (!image?.name || !image?.tag) continue;
    const key = `${image.name}:${image.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(image);
  }

  return merged;
}

function getOptionalServerImageSpecs(selectedServerIds = []) {
  const optionalImagesByServerId = {
    'n8n-community-mcp': [
      { name: 'harbor.example.invalid/n8n/n8n-mcp', tag: 'latest', label: 'n8n MCP (Community Fork)' }
    ]
  };

  return normalizeSelectedServerIds(selectedServerIds).flatMap((serverId) => {
    const images = optionalImagesByServerId[serverId];
    return Array.isArray(images) ? images : [];
  });
}

function readSelectedServerImagePlatform(projectRoot, serverId) {
  if (!projectRoot || typeof serverId !== 'string' || !serverId.trim()) {
    return '';
  }

  const normalizedServerId = serverId.trim();
  const yamlCandidates = [
    path.join(projectRoot, 'mcp-configs', normalizedServerId, `${normalizedServerId}.yaml`),
    path.join(projectRoot, 'mcp-configs-user', normalizedServerId, `${normalizedServerId}.yaml`)
  ];

  for (const yamlPath of yamlCandidates) {
    if (!fs.existsSync(yamlPath)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(yamlPath, 'utf8');
      const match = raw.match(/^[ \t]*image_platform:[ \t]*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m);
      if (match && match[1]?.trim()) {
        return match[1].trim();
      }
    } catch {
      // Ignore YAML read failures and preserve the current blocking behavior.
    }
  }

  return '';
}

function buildOptionalImagePlatformWarning(warningArchitectureImages = []) {
  return `Optional Docker images will run via their declared platform override: ${formatWrongArchitectureImageList(warningArchitectureImages)}`;
}

function applyFinalizeOptionalImagePlatformWarnings(readiness, options = {}) {
  const payload = readiness || buildBlockedReadiness([], GENERIC_GUIDED_SETUP_PREREQ_ERROR);
  const selectedServerIds = normalizeSelectedServerIds(options.selectedServerIds);
  if (selectedServerIds.length === 0) {
    return payload;
  }

  const warningSpecs = mergeImageSpecs(
    [],
    selectedServerIds
      .filter((serverId) => (
        getOptionalServerImageSpecs([serverId]).length > 0 &&
        Boolean(readSelectedServerImagePlatform(options.projectRoot, serverId))
      ))
      .flatMap((serverId) => getOptionalServerImageSpecs([serverId]))
  );
  if (warningSpecs.length === 0) {
    return payload;
  }

  const warningRefs = new Set(
    warningSpecs.map((imageSpec) => `${imageSpec.name}:${imageSpec.tag}`)
  );
  const warningArchitectureImages = Array.isArray(payload.wrongArchitectureImages)
    ? payload.wrongArchitectureImages.filter((entry) => warningRefs.has(entry.image))
    : [];
  if (warningArchitectureImages.length === 0) {
    return payload;
  }

  const warningImages = new Set(warningArchitectureImages.map((entry) => entry.image));
  const remainingMissingImages = Array.isArray(payload.missingImages)
    ? payload.missingImages.filter((image) => !warningImages.has(image))
    : [];
  const remainingWrongArchitectureImages = Array.isArray(payload.wrongArchitectureImages)
    ? payload.wrongArchitectureImages.filter((entry) => !warningImages.has(entry.image))
    : [];
  const hasBlockingImages =
    remainingMissingImages.length > 0 || remainingWrongArchitectureImages.length > 0;

  return {
    ...payload,
    ready: !hasBlockingImages,
    waiting: hasBlockingImages ? payload.waiting === true : false,
    progressPercent: hasBlockingImages ? payload.progressPercent : 100,
    missingImages: remainingMissingImages,
    wrongArchitectureImages: remainingWrongArchitectureImages,
    warning: buildOptionalImagePlatformWarning(warningArchitectureImages),
    warningArchitectureImages,
    error: hasBlockingImages
      ? (
          payload.waiting === true
            ? null
            : buildImageReadinessError(
                { wrongArchitectureImages: remainingWrongArchitectureImages },
                options.errorMessage || GENERIC_GUIDED_SETUP_PREREQ_ERROR
              )
        )
      : null
  };
}

async function evaluateInstalledPrereqReadiness(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const scope = normalizeInstalledReadinessScope(options.scope);
  const userDataPath = options.userDataPath ||
    (app && typeof app.getPath === 'function' ? app.getPath('userData') : undefined);
  const setupStatus = evaluateSetupRequirementStatus({
    projectRoot,
    userDataPath,
    resourcesPath: options.resourcesPath || process.resourcesPath,
    appRoot: options.appRoot || path.join(projectRoot, 'electron-app')
  });

  if (setupStatus.needsSetup) {
    return {
      skip: false,
      reason: setupStatus.reason,
      setupStatus
    };
  }

  const buildMatch = doesInstalledBuildMatchBundledBuild(projectRoot);
  if (!buildMatch.matches) {
    return {
      skip: false,
      reason: buildMatch.reason || 'build-mismatch',
      setupStatus,
      buildMatch
    };
  }

  const requiredSpecs = getRequiredSpecsForInstalledReadiness(scope);
  const imageState = calculateRequiredImageProgress(requiredSpecs);
  if (imageState.readyCount !== imageState.total) {
    return {
      skip: false,
      reason: scope === 'authorize' ? 'authorize-images-missing' : 'finalize-images-missing',
      setupStatus,
      buildMatch,
      missingImages: imageState.missing,
      wrongArchitectureImages: imageState.wrongArchitectureImages
    };
  }

  if (scope === 'finalize' && options.includeFinalizeGenerator === true) {
    const generatorReadiness = getFinalizeGeneratorReadiness();
    if (!generatorReadiness.ready) {
      return {
        skip: false,
        reason: 'finalize-generator-missing',
        setupStatus,
        buildMatch,
        readyImages: imageState.readyImages,
        error: generatorReadiness.error
      };
    }
  }

  return {
    skip: true,
    reason: 'installed-build-ready',
    setupStatus,
    buildMatch,
    readyImages: imageState.readyImages
  };
}

async function getInstalledPrereqReadiness(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const readiness = await evaluateInstalledPrereqReadiness({
    ...options,
    projectRoot
  });

  return {
    ...readiness,
    hostModeEnabled: isHostModeEnabled(projectRoot)
  };
}

function canUseInstalledPrereqFastPath({ onboardingMode, installedReadiness }) {
  return Boolean(
    installedReadiness?.skip &&
    (onboardingMode === 'basic' || installedReadiness?.hostModeEnabled === true)
  );
}

function markSessionReadyFromExistingRuntime({
  onboardingMode,
  hostModeEnabled,
  requiresHost = onboardingMode !== 'basic',
  source = 'installed'
}) {
  const sourceLabel = source === 'runtime' ? 'existing runtime assets' : 'existing installed build';
  prerequisitesSession.currentSequence = 'complete';
  prerequisitesSession.lastError = null;
  prerequisitesSession.failedPhase = null;
  prerequisitesSession.phaseResults.phase1 = {
    success: true,
    skipped: true,
    message: `Using ${sourceLabel}`
  };
  prerequisitesSession.phaseResults.phase2 = {
    success: true,
    skipped: true,
    message: 'Core dependencies already available'
  };
  prerequisitesSession.phaseResults.phase3 = {
    success: true,
    skipped: true,
    message: 'Workspace already prepared'
  };
  prerequisitesSession.phaseResults.dockerPull = {
    success: true,
    skipped: true,
    message: 'Required Docker images already available'
  };
  prerequisitesSession.phaseResults.phase4 = onboardingMode === 'basic'
    ? {
      success: true,
      skipped: true,
      message: 'Host mode is not required for basic mode'
    }
    : !requiresHost
      ? {
        success: true,
        skipped: true,
        message: 'Host mode is not required for the current selection'
      }
    : {
      success: Boolean(hostModeEnabled),
      skipped: false,
      message: hostModeEnabled
        ? 'Host mode is already enabled'
        : 'Host mode still needs setup'
    };
  prerequisitesSession.phase1Progress = {
    ...createEmptyPhase1Progress(),
    step: 'complete',
    activity: 'Setup already complete.',
    percent: 100,
    downloadComplete: true
  };
  prerequisitesSession.dockerPull.running = false;
  prerequisitesSession.dockerPull.aggregatePercent = 100;
  updateDerivedSessionState();
}

function shouldUseSessionFinalizeReadiness(waiting = false) {
  return Boolean(
    waiting ||
    prerequisitesSession.blockingReady ||
    prerequisitesSession.backgroundReady ||
    prerequisitesSession.currentSequence === 'complete'
  );
}

function applyFinalizeReadinessChecks(readiness, options = {}) {
  const payload = readiness || buildBlockedReadiness([], GENERIC_GUIDED_SETUP_PREREQ_ERROR);
  const requiresHost = options.requiresHost === true;
  const hostReady = options.hostReady !== false;
  const waiting = options.waiting === true;
  const errorMessage = options.errorMessage || GENERIC_GUIDED_SETUP_PREREQ_ERROR;

  if (payload.ready) {
    const generatorReadiness = getFinalizeGeneratorReadiness();
    if (!generatorReadiness.ready) {
      return {
        ...payload,
        ready: false,
        waiting: false,
        error: generatorReadiness.error
      };
    }
  }

  if (payload.ready && requiresHost && !hostReady) {
    if (waiting) {
      return {
        ...payload,
        ready: false,
        waiting: true,
        progressPercent: Math.max(payload.progressPercent, 95),
        error: null
      };
    }

    return {
      ...payload,
      ready: false,
      waiting: false,
      error: errorMessage
    };
  }

  return payload;
}

function applyRequiredHostPrerequisiteReadiness(readiness, options = {}) {
  const payload = readiness || buildBlockedReadiness([], GENERIC_GUIDED_SETUP_PREREQ_ERROR);
  const hostPrerequisites = options.hostPrerequisites || inspectRequiredHostPrerequisites(options);
  if (hostPrerequisites.isComplete) {
    return { ...payload, hostPrerequisites };
  }

  return {
    ...payload,
    ready: false,
    waiting: options.waiting === true,
    error: options.waiting === true ? null : hostPrerequisites.reasonMessage,
    prerequisiteReason: hostPrerequisites.reason,
    hostPrerequisites,
  };
}

function summarizeReadinessForLog(readiness) {
  return {
    ready: readiness?.ready === true,
    waiting: readiness?.waiting === true,
    progressPercent: Number(readiness?.progressPercent) || 0,
    error: readiness?.error || null,
    warning: readiness?.warning || null,
    missingImages: Array.isArray(readiness?.missingImages) ? readiness.missingImages : [],
    wrongArchitectureImages: Array.isArray(readiness?.wrongArchitectureImages)
      ? readiness.wrongArchitectureImages
      : [],
    warningArchitectureImages: Array.isArray(readiness?.warningArchitectureImages)
      ? readiness.warningArchitectureImages
      : [],
  };
}

function getRuntimeFinalizeReadiness(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const requiredSpecs = options.requiredSpecs || getFinalizeRequiredImageSpecs(options);
  const requiresHost = options.mode === 'power' && options.hasHostSelections === true;
  const hostModeEnabled = isHostModeEnabled(projectRoot);
  const payload = applyFinalizeOptionalImagePlatformWarnings(
    buildReadinessPayload({
      requiredSpecs,
      blockingInstallStillRunning: false,
      errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
    }),
    {
      projectRoot,
      selectedServerIds: options.selectedServerIds,
      errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
    }
  );

  const readiness = applyFinalizeReadinessChecks(payload, {
    requiresHost,
    hostReady: !requiresHost || hostModeEnabled,
    waiting: false,
    errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
  });

  return {
    ...applyRequiredHostPrerequisiteReadiness(readiness, options),
    hostModeEnabled
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Add log line to ring buffer and emit (throttled)
 * Also logs to prereq logger with batching
 */
function addLogLine(text, type, emitToWindow) {
  const cleanText = stripAnsi(text);

  // Add to ring buffer
  logRingBuffer.push({ text: cleanText, type, timestamp: Date.now() });
  if (logRingBuffer.length > MAX_LOG_LINES) {
    logRingBuffer.shift();
  }

  // Throttle IPC emissions
  const now = Date.now();
  if (now - lastLogEmit >= LOG_THROTTLE_MS) {
    lastLogEmit = now;
    emitToWindow('prerequisites-log', { text: cleanText, type });
  }

  // Log to prereq logger (batched internally)
  const prereqLogger = getPrereqLogger();
  if (prereqLogger) {
    prereqLogger.logShellOutput(cleanText, type);
  }
}

function registerActiveDockerPullController(imageRef, controller) {
  if (!imageRef || !controller) {
    return;
  }
  activeDockerPullControllers.set(imageRef, controller);
}

function unregisterActiveDockerPullController(imageRef, controller) {
  if (!imageRef) {
    return;
  }

  if (controller && activeDockerPullControllers.get(imageRef) !== controller) {
    return;
  }

  activeDockerPullControllers.delete(imageRef);
}

function handleSystemResume() {
  if (currentDockerPullWave) {
    currentDockerPullWave.sawSystemResume = true;
  }

  if (activeDockerPullControllers.size === 0) {
    return;
  }

  const emitToWindow = createSessionEmitter();
  addLogLine('System resumed from sleep; reset Docker pull inactivity timers.', 'info', emitToWindow);
  logPrereq('Docker', 'INFO', 'System resumed from sleep; reset Docker pull inactivity timers.');

  for (const controller of activeDockerPullControllers.values()) {
    try {
      controller.resetInactivityTimer?.('resume');
    } catch (error) {
      console.warn('[Prerequisites] Failed to reset Docker pull inactivity timer after resume:', error.message);
      logPrereq('Docker', 'WARN', `Failed to reset Docker pull inactivity timer after resume: ${error.message}`);
    }
  }
}

async function restartOrbStackForDockerRecovery(options = {}) {
  const { targetWindow = null, reason = 'retry' } = options;
  const emitToWindow = createSessionEmitter(targetWindow);
  const { restartOrbStackAndWaitForDocker } = require('./docker-mcp');
  const introMessage = reason === 'wave-recovery'
    ? 'Docker stalled after a resume event; restarting OrbStack before retrying pulls.'
    : 'Restarting OrbStack before retrying Docker image downloads.';
  addLogLine(introMessage, 'warning', emitToWindow);
  logPrereq('Docker', 'WARN', introMessage);

  const recovery = await restartOrbStackAndWaitForDocker({
    projectRoot: getSafeProjectRoot(),
    onLog: (message, type = 'info') => addLogLine(message, type, emitToWindow),
    onStatus: (message) => addLogLine(message, 'info', emitToWindow),
  });

  if (recovery?.success) {
    const successMessage = 'OrbStack restarted successfully. Retrying Docker image downloads.';
    addLogLine(successMessage, 'success', emitToWindow);
    logPrereq('Docker', 'INFO', successMessage);
    return true;
  }

  const failureMessage = `OrbStack restart failed during Docker recovery: ${recovery?.error || 'Unknown error'}`;
  addLogLine(failureMessage, 'warning', emitToWindow);
  logPrereq('Docker', 'WARN', failureMessage);
  return false;
}

/**
 * Create safe window emitter that checks window validity
 */
function createEmitter(targetWindow) {
  return (channel, data) => {
    const win = targetWindow || state.windows.guidedSetup;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };
}

// ============================================================================
// BUILD INFO
// ============================================================================

/**
 * Read build-info.json from app resources (bundled in DMG)
 * Falls back to PROJECT_ROOT for dev mode
 */
let bundledBuildInfoCache = null;

function readBundledBuildInfo() {
  try {
    // In packaged app: Contents/Resources/build-info.json
    const bundledPath = path.join(process.resourcesPath, 'build-info.json');

    if (fs.existsSync(bundledPath)) {
      if (bundledBuildInfoCache?.path === bundledPath) {
        return bundledBuildInfoCache.result;
      }
      const content = fs.readFileSync(bundledPath, 'utf8');
      console.log('[Prerequisites] Read build-info.json from bundled resources');
      const result = { success: true, data: JSON.parse(content) };
      bundledBuildInfoCache = { path: bundledPath, result };
      return result;
    }

    // Fallback for dev mode
    const devPath = path.join(bootstrap.PROJECT_ROOT, 'electron-app', 'build-info.json');
    if (fs.existsSync(devPath)) {
      const content = fs.readFileSync(devPath, 'utf8');
      console.log('[Prerequisites] Read build-info.json from dev path');
      return { success: true, data: JSON.parse(content) };
    }

    console.warn('[Prerequisites] build-info.json not found in any location');
    return { success: false, error: 'build-info.json not found' };
  } catch (err) {
    console.error('[Prerequisites] Error reading build-info.json:', err.message);
    return { success: false, error: err.message };
  }
}

function readInstalledBuildInfo(projectRoot = getSafeProjectRoot()) {
  const buildInfoPath = path.join(projectRoot, 'electron-app', 'build-info.json');
  const result = readBuildInfoFile(buildInfoPath);
  if (result.success) {
    return result;
  }

  return {
    success: false,
    path: buildInfoPath,
    error: result.error === 'build-info.json not found'
      ? 'installed build-info.json not found'
      : result.error
  };
}

function getResolvedChannelKeyword(buildInfo = {}) {
  try {
    return resolveBuildChannel(buildInfo);
  } catch {
    return 'portico';
  }
}

function doesInstalledBuildMatchBundledBuild(projectRoot = getSafeProjectRoot()) {
  const bundledBuild = readBundledBuildInfo();
  const installedBuild = readInstalledBuildInfo(projectRoot);

  if (!bundledBuild.success || !installedBuild.success) {
    return {
      success: false,
      matches: false,
      bundledBuild,
      installedBuild,
      reason: bundledBuild.success ? installedBuild.error : bundledBuild.error
    };
  }

  const bundledBuildNumber = bundledBuild.data?.buildNumber || null;
  const installedBuildNumber = installedBuild.data?.buildNumber || null;
  const bundledChannel = getResolvedChannelKeyword(bundledBuild.data || {});
  const installedChannel = getResolvedChannelKeyword(installedBuild.data || {});
  const matches = Boolean(
    bundledBuildNumber &&
    installedBuildNumber &&
    bundledBuildNumber === installedBuildNumber &&
    bundledChannel === installedChannel
  );

  return {
    success: true,
    matches,
    bundledBuild,
    installedBuild,
    reason: matches ? null : 'installed build does not match bundled app build'
  };
}

function resolvePreparedRuntimeUpdateScript(projectRoot, prepared) {
  const normalizedProjectRoot = projectRoot || getSafeProjectRoot();
  const candidates = [];

  if (prepared?.managedRootDir) {
    candidates.push(
      path.join(prepared.managedRootDir, 'electron-app', 'src', 'scripts', 'apply-prepared-update.sh')
    );
  }

  candidates.push(
    path.join(normalizedProjectRoot, 'electron-app', 'src', 'scripts', 'apply-prepared-update.sh')
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function stopManagedRuntimeForUpdate(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const dockerComposeScript = path.join(
    projectRoot,
    'src',
    'scripts',
    'docker-compose.sh'
  );
  const scriptExists = fs.existsSync(dockerComposeScript);
  const executeWithStreaming = options.executeWithStreaming ||
    (scriptExists ? require('./docker-mcp').executeWithStreaming : null);
  return stopGuard.stopManagedRuntimeForUpdate({
    stopScriptPath: dockerComposeScript,
    scriptExists,
    executeWithStreaming,
    timeoutMs: options.timeoutMs || 60000
  });
}

function runRuntimeUpdateScript(scriptPath, args = [], targetWindow = null) {
  return new Promise((resolve) => {
    const emitToWindow = createEmitter(targetWindow);
    const startedAt = new Date();
    const projectRoot = getSafeProjectRoot();
    const updateKey = args[6] || 'runtime-update';

    if (cancelled) {
      return resolve({ success: false, error: 'Prerequisites cancelled', retryable: false });
    }

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return resolve({
        success: false,
        error: `Runtime repair script not found: ${scriptPath || 'unknown'}`,
        retryable: false
      });
    }

    let enhancedEnv;
    try {
      enhancedEnv = createRuntimeShellEnv({
        baseEnv: process.env,
        overrides: {
          PATH: buildEnhancedPath(process.env.PATH || ''),
          NODE_VERSION_REQUIRED
        },
        isPackagedApp: app.isPackaged === true,
        resourcesPath: process.resourcesPath
      });
    } catch (error) {
      const message = error?.message || 'Failed to resolve secure runtime credentials.';
      addLogLine(`[Runtime Update] ${message}\n`, 'error', emitToWindow);
      return resolve({ success: false, error: message, retryable: false });
    }
    delete enhancedEnv.CI;

    const child = spawn('bash', [scriptPath, ...args], {
      cwd: getSafeProjectRoot(),
      env: enhancedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    activeProcess = child;
    activePhase = 'runtime-update';

    let output = '';
    let errorOutput = '';
    let combinedOutput = '';
    let resolved = false;
    const timeoutId = setTimeout(() => {
      killProcessGroup(child);
      finish({
        success: false,
        error: `Timeout after ${RUNTIME_UPDATE_TIMEOUT_MS / 1000}s`,
        retryable: false
      });
    }, RUNTIME_UPDATE_TIMEOUT_MS);

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      activeProcess = null;
      activePhase = null;
      const auditResult = persistApplyAudit({
        projectRoot,
        updateKey,
        startedAt,
        finishedAt: new Date(),
        command: ['bash', scriptPath, ...args],
        combinedOutput,
        result
      });
      if (!auditResult.success) {
        console.warn(
          `[Runtime Update] Could not persist apply audit: ${auditResult.error}`
        );
      }
      resolve({
        ...result,
        auditLogFile: auditResult.success ? auditResult.path : null
      });
    };

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      combinedOutput += text;
      addLogLine(text, 'info', emitToWindow);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      combinedOutput += `[stderr] ${text}`;
      addLogLine(text, 'error', emitToWindow);
    });

    child.on('close', (code) => {
      finish({
        success: code === 0,
        output,
        error: code === 0 ? undefined : (errorOutput || output || `Exit code ${code}`),
        code,
        retryable: false
      });
    });

    child.on('error', (error) => {
      finish({ success: false, error: error.message, retryable: false });
    });
  });
}

async function updateInstalledRuntimeToBundledBuild(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const targetWindow = options.targetWindow || null;
  const emitToWindow = createEmitter(targetWindow);

  if (!app.isPackaged) {
    return {
      success: true,
      updated: false,
      source: 'not-packaged',
      reason: null
    };
  }

  resetPrerequisitesCancellation();

  const bundledBuild = readBundledBuildInfo();
  const installedBuild = readInstalledBuildInfo(projectRoot);
  const bundledIdentity = resolveBuildIdentity(bundledBuild.data || {});
  const installedIdentity = resolveBuildIdentity(installedBuild.data || {});

  if (!bundledBuild.success || !bundledIdentity.buildNumber) {
    return {
      success: false,
      updated: false,
      source: 'bundled-build-info',
      reason: 'bundled-build-metadata-missing',
      bundledBuildNumber: bundledIdentity.buildNumber,
      installedBuildNumber: installedIdentity.buildNumber,
      error: bundledBuild.error || 'Bundled build-info.json is missing or invalid.'
    };
  }

  const resolvedUpdateTarget = resolvePrerequisitesDownloadTarget({
    buildNumber: bundledIdentity.buildNumber,
    buildInfo: bundledBuild.data || null
  });
  if (resolvedUpdateTarget.success && resolvedUpdateTarget.localOnly) {
    return {
      success: true,
      updated: false,
      source: 'local-dev-build',
      reason: 'local-only-bundled-build',
      bundledBuildNumber: bundledIdentity.buildNumber,
      installedBuildNumber: installedIdentity.buildNumber
    };
  }

  const initialMatch = doesInstalledBuildMatchBundledBuild(projectRoot);
  if (initialMatch.matches) {
    return {
      success: true,
      updated: false,
      source: 'already-matched',
      reason: null,
      bundledBuildNumber: bundledIdentity.buildNumber,
      installedBuildNumber: installedIdentity.buildNumber
    };
  }

  addLogLine(
    `[Runtime Update] bundled-build-mismatch: installed ${describeBuildIdentity(installedBuild.data || {})} vs bundled ${describeBuildIdentity(bundledBuild.data || {})}\n`,
    'warning',
    emitToWindow
  );

  let preparedCandidate = null;
  let preparedCandidateError = null;
  let updatePreparation = null;
  let runtimeStoppedForUpdate = false;

  const ensureRuntimeStoppedForUpdate = async (source) => {
    if (runtimeStoppedForUpdate) {
      return { success: true };
    }
    addLogLine(
      `[Runtime Update] Stopping the managed runtime before ${source}.\n`,
      'info',
      emitToWindow
    );
    const stopResult = await stopManagedRuntimeForUpdate({ projectRoot });
    if (stopResult.success) {
      runtimeStoppedForUpdate = true;
      addLogLine(
        '[Runtime Update] Managed runtime stopped; update reconciliation has exclusive access.\n',
        'info',
        emitToWindow
      );
    } else {
      addLogLine(
        `[Runtime Update] Could not stop the managed runtime: ${stopResult.error}\n`,
        'error',
        emitToWindow
      );
    }
    return stopResult;
  };

  try {
    updatePreparation = require('./update-preparation');
    preparedCandidate = getPreparedRuntimeRepairCandidate({
      bundledBuild: bundledBuild.data || {},
      preparedState: updatePreparation.getPreparationStatus(),
      validatePreparedArtifactsForInstall: updatePreparation.validatePreparedArtifactsForInstall
    });
  } catch (error) {
    preparedCandidateError = error.message;
  }

  if (preparedCandidate?.matches && preparedCandidate.prepared) {
    const updateScript = resolvePreparedRuntimeUpdateScript(projectRoot, preparedCandidate.prepared);
    if (updateScript) {
      const stopResult = await ensureRuntimeStoppedForUpdate(
        'prepared update reconciliation'
      );
      if (!stopResult.success) {
        return {
          success: false,
          updated: false,
          source: 'prepared-update',
          reason: 'runtime-stop-failed',
          bundledBuildNumber: bundledIdentity.buildNumber,
          installedBuildNumber: installedIdentity.buildNumber,
          error:
            `Managed runtime update was cancelled because services could not be stopped safely: ${stopResult.error}`
        };
      }
      addLogLine(
        `[Runtime Update] Applying prepared runtime artifacts for ${describeBuildIdentity(preparedCandidate.preparedBuild.data || {})}\n`,
        'info',
        emitToWindow
      );
      const preparedResult = await runRuntimeUpdateScript(
        updateScript,
        [
          projectRoot,
          preparedCandidate.prepared.managedRootDir,
          preparedCandidate.prepared.selectedAppBundle,
          preparedCandidate.prepared.selectedDmg,
          preparedCandidate.prepared.buildInfoPath,
          preparedCandidate.prepared.fullBackupPath || 'none',
          preparedCandidate.prepared.updateKey || 'runtime-update'
        ],
        targetWindow
      );
      const preparedMatch = doesInstalledBuildMatchBundledBuild(projectRoot);
      if (preparedResult.success && preparedMatch.matches) {
        try {
          secureCloudsmithBootstrapAfterManagedRuntimeUpdate({
            managedRoot: projectRoot,
            projectRoot,
          });
        } catch (error) {
          return {
            success: false,
            updated: false,
            source: 'prepared-update',
            reason: 'cloudsmith-bootstrap-hardening-failed',
            bundledBuildNumber: bundledIdentity.buildNumber,
            installedBuildNumber: resolveBuildIdentity(
              preparedMatch.installedBuild?.data || {},
            ).buildNumber,
            error:
              `Managed runtime update completed, but Cloudsmith bootstrap hardening failed: ${error.message}`,
          };
        }
        const consumeResult = updatePreparation?.consumePreparedArtifacts?.(
          preparedCandidate.prepared.updateKey,
        );
        if (consumeResult && !consumeResult.success) {
          addLogLine(
            `[Runtime Update] Reconciliation succeeded, but staged artifact cleanup was deferred: ${consumeResult.error || consumeResult.reason}\n`,
            'warning',
            emitToWindow
          );
        }
        const finalInstalledIdentity = resolveBuildIdentity(
          preparedMatch.installedBuild?.data || {}
        );
        return {
          success: true,
          updated: true,
          source: 'prepared-update',
          reason: 'bundled-build-mismatch',
          bundledBuildNumber: bundledIdentity.buildNumber,
          installedBuildNumber: finalInstalledIdentity.buildNumber
        };
      }

      preparedCandidateError = preparedResult.error ||
        preparedMatch.reason ||
        'Prepared runtime update did not align the managed runtime build.';
      addLogLine(
        `[Runtime Update] Prepared runtime update did not complete successfully; falling back to exact-build download. ${preparedCandidateError}\n`,
        'warning',
        emitToWindow
      );
    } else {
      preparedCandidateError = 'Prepared runtime update script not found.';
    }
  } else if (preparedCandidate?.reason === 'prepared-build-mismatch') {
    addLogLine(
      `[Runtime Update] Ignoring prepared artifacts for ${describeBuildIdentity(preparedCandidate.preparedBuild?.data || {})}; bundled app requires ${describeBuildIdentity(bundledBuild.data || {})}\n`,
      'info',
      emitToWindow
    );
  } else if (preparedCandidate?.error) {
    preparedCandidateError = preparedCandidate.error;
  }

  if (preparedCandidateError) {
    addLogLine(
      `[Runtime Update] Prepared artifact path unavailable. ${preparedCandidateError}\n`,
      'info',
      emitToWindow
    );
  }

  addLogLine(
    `[Runtime Update] Downloading exact bundled build ${describeBuildIdentity(bundledBuild.data || {})} to update the managed runtime\n`,
    'info',
    emitToWindow
  );
  const stopResult = await ensureRuntimeStoppedForUpdate(
    'exact-build update reconciliation'
  );
  if (!stopResult.success) {
    return {
      success: false,
      updated: false,
      source: 'cloudsmith-phase1',
      reason: 'runtime-stop-failed',
      bundledBuildNumber: bundledIdentity.buildNumber,
      installedBuildNumber: installedIdentity.buildNumber,
      error:
        `Managed runtime update was cancelled because services could not be stopped safely: ${stopResult.error}`
    };
  }
  const phase1Result = await runPhase1Download(bundledIdentity.buildNumber, targetWindow);
  const finalMatch = doesInstalledBuildMatchBundledBuild(projectRoot);
  if (phase1Result.success && finalMatch.matches) {
    if (preparedCandidate?.matches && preparedCandidate.prepared && updatePreparation) {
      const consumeResult = updatePreparation.consumePreparedArtifacts?.(
        preparedCandidate.prepared.updateKey,
      );
      if (consumeResult && !consumeResult.success) {
        addLogLine(
          `[Runtime Update] Exact-build reconciliation succeeded, but staged artifact cleanup was deferred: ${consumeResult.error || consumeResult.reason}\n`,
          'warning',
          emitToWindow
        );
      }
    }
    const finalInstalledIdentity = resolveBuildIdentity(
      finalMatch.installedBuild?.data || {}
    );
    return {
      success: true,
      updated: true,
      source: 'cloudsmith-phase1',
      reason: 'bundled-build-mismatch',
      bundledBuildNumber: bundledIdentity.buildNumber,
      installedBuildNumber: finalInstalledIdentity.buildNumber
    };
  }

  return {
    success: false,
    updated: false,
    source: 'cloudsmith-phase1',
    reason: 'bundled-build-mismatch',
    bundledBuildNumber: bundledIdentity.buildNumber,
    installedBuildNumber: resolveBuildIdentity(finalMatch.installedBuild?.data || {}).buildNumber,
    error:
      phase1Result.error ||
      finalMatch.reason ||
      'Managed runtime update completed but the installed build still does not match the bundled app build.'
  };
}

/**
 * Fetch latest build number from Cloudsmith for a specific package channel
 * @returns {Promise<{success: boolean, buildNumber?: string, channel?: string, error?: string}>}
 */
async function fetchLatestBuildFromCloudsmith(channelKeyword) {
  const {
    CLOUDSMITH_OWNER,
    CLOUDSMITH_REPO,
    CLOUDSMITH_API_BASE,
    CLOUDSMITH_READ_TOKEN,
    CLOUDSMITH_API_KEY,
  } = cloudsmithConfig;
  const normalizedChannelKeyword =
    typeof channelKeyword === 'string' && channelKeyword.trim()
      ? channelKeyword.trim()
      : 'portico';
  const discoveryApiKey = CLOUDSMITH_READ_TOKEN || CLOUDSMITH_API_KEY;

  const selectLatestPackageForChannel = async (targetChannel) => {
    const escapedChannelKeyword = targetChannel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const packageQuery = encodeURIComponent(
      `name:^${targetChannel}$ format:raw tag:^${UPDATE_READY_TAG}$`,
    );
    const apiUrl = `${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/` +
      `?query=${packageQuery}&page_size=10&sort=-date`;
    const headers = { 'Accept': 'application/json' };
    headers['X-Api-Key'] = discoveryApiKey;

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      throw new Error(`Cloudsmith API request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const packages = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.results)
          ? payload.results
          : [];

    const zipPackages = packages.filter(pkg =>
      pkg.filename && pkg.filename.endsWith('.zip') && isUpdateReadyPackage(pkg)
    );

    if (zipPackages.length === 0) {
      return null;
    }

    const latest = zipPackages.sort((a, b) =>
      new Date(b.uploaded_at || b.created_at || 0) - new Date(a.uploaded_at || a.created_at || 0)
    )[0];

    const filename = latest.filename;
    const pattern = new RegExp(`${escapedChannelKeyword}-(\\d{8})-([a-f0-9]{8,40})\\.zip$`);
    const match = filename.match(pattern);

    if (!match) {
      throw new Error(`Could not parse build number from: ${filename}`);
    }

    const buildNumber = `${match[1]}-${match[2]}`;
    return {
      ...latest,
      buildNumber,
      channel: targetChannel,
    };
  };

  try {
    console.log(
      `[Prerequisites] Fetching latest build from Cloudsmith channel: ${normalizedChannelKeyword}`,
    );

    if (!discoveryApiKey) {
      throw new Error(
        'Cloudsmith API key is not configured; cannot fetch update package data from the private update repository.',
      );
    }

    const latest = await selectLatestPackageForChannel(normalizedChannelKeyword);
    if (!latest) {
      return {
        // PORTICO-344: actionable message for the empty-channel case (e.g. a
        // reinstall/fetch-latest against Stable/Dev, which have no builds).
        success: false,
        error:
          `No builds are available on the "${normalizedChannelKeyword}" release channel. ` +
          `Switch Release Channel (Portico menu) to one that has builds (e.g. Beta), then retry.`,
      };
    }

    console.log('[Prerequisites] Latest binary:', latest.filename);
    if (getPackageSlug(latest)) {
      console.log('[Prerequisites] Latest Cloudsmith package slug:', getPackageSlug(latest));
    }

    const redirectResult = await resolveEolRedirectForPackage({
      cloudsmithConfig,
      sourceChannel: normalizedChannelKeyword,
      sourcePackage: latest,
      fetchLatestPackageForChannel: selectLatestPackageForChannel,
      logPrefix: '[Prerequisites]',
      logger: console,
    });

    if (redirectResult.redirected) {
      console.log(
        `[Prerequisites] Cloudsmith EOL redirect ${normalizedChannelKeyword} -> ${redirectResult.channel}`,
      );
      console.log(`[Prerequisites] Extracted build number: ${redirectResult.package.buildNumber}`);
      return {
        success: true,
        buildNumber: redirectResult.package.buildNumber,
        channel: redirectResult.channel,
        eolRedirect: redirectResult.eolRedirect,
      };
    }

    console.log(`[Prerequisites] Extracted build number: ${latest.buildNumber}`);
    return { success: true, buildNumber: latest.buildNumber, channel: normalizedChannelKeyword };
  } catch (err) {
    console.error('[Prerequisites] Error fetching latest build:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================================
// MARKER PARSING
// ============================================================================

/**
 * Parse [PREREQ:*] markers and emit appropriate IPC events
 * Uses line buffering to handle markers split across chunks
 * Also logs parsed markers to prereq logger
 */
function parseAndEmitMarkers(text, emitToWindow, options = {}) {
  // Add new text to buffer and split into lines
  lineBuffer += text;
  const lines = lineBuffer.split('\n');

  // Keep the last incomplete line in buffer (if any)
  lineBuffer = lines.pop() || '';

  const prereqLogger = getPrereqLogger();

  for (const line of lines) {
    // Phase markers
    const phaseMatch = line.match(/\[PREREQ:PHASE:(\d+):(START|COMPLETE)\]/);
    if (phaseMatch) {
      const [, phaseNum, action] = phaseMatch;
      prerequisitesSession.activeStep = null;
      if (action === 'START') {
        emitToWindow('prerequisites-phase-start', { phase: parseInt(phaseNum) });
        logPrereq('System', 'DEBUG', `Marker: PHASE:${phaseNum}:START`);
      } else {
        emitToWindow('prerequisites-phase-complete', { phase: parseInt(phaseNum) });
        logPrereq('System', 'DEBUG', `Marker: PHASE:${phaseNum}:COMPLETE`);
      }
      continue;
    }

    // Step markers
    const stepMatch = line.match(/\[PREREQ:STEP:([^:]+):(START|COMPLETE|SKIPPED|FAILED)\]/);
    if (stepMatch) {
      const [, stepName, status] = stepMatch;
      const normalizedStatus = status.toLowerCase();
      const phase = activePhase || null;
      if (normalizedStatus === 'start') {
        prerequisitesSession.activeStep = stepName;
      } else if (prerequisitesSession.activeStep === stepName) {
        prerequisitesSession.activeStep = null;
      }
      emitToWindow('prerequisites-step-update', { step: stepName, status: normalizedStatus, phase });
      if (normalizedStatus === 'failed' && phase) {
        phaseStepFailures[phase] = true;
      }
      // Log step updates
      if (prereqLogger) {
        prereqLogger.logStepUpdate(stepName, normalizedStatus);
      }
      continue;
    }

    // Warning markers
    const warningMatch = line.match(/\[PREREQ:WARNING:(.+)\]/);
    if (warningMatch) {
      const message = warningMatch[1];
      emitToWindow('prerequisites-warning', { message });
      logPrereq('System', 'WARN', `Shell warning marker: ${message}`);
      continue;
    }

    const codeMatch = line.match(/\[PREREQ:CODE:([^\]]+)\]/);
    if (codeMatch) {
      const code = codeMatch[1].trim();
      if (code) {
        prerequisitesSession.lastFailureCode = code;
        prerequisitesSession.lastFailureDetails = [];
        prerequisitesSession.skipHomebrewAuthOnRetry = isHomebrewAuthFailureCode(code);
        logPrereq('System', 'WARN', `Shell failure code: ${code}`);
      }
      continue;
    }

    const detailMatch = line.match(/\[PREREQ:DETAIL:(.+)\]/);
    if (detailMatch) {
      const detail = detailMatch[1].trim();
      if (detail) {
        prerequisitesSession.lastFailureDetails = prerequisitesSession.lastFailureDetails || [];
        prerequisitesSession.lastFailureDetails.push(detail);
        prerequisitesSession.lastFailureDetails = prerequisitesSession.lastFailureDetails.slice(-10);
        logPrereq('System', 'INFO', `Shell failure detail: ${detail}`);
      }
      continue;
    }

    // Error markers
    const errorMatch = line.match(/\[PREREQ:ERROR:(.+)\]/);
    if (errorMatch) {
      emitToWindow('prerequisites-error', {
        error: errorMatch[1],
        code: prerequisitesSession.lastFailureCode,
        details: [...(prerequisitesSession.lastFailureDetails || [])],
        recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
      });
      logPrereq('System', 'ERROR', `Shell error marker: ${errorMatch[1]}`);
      continue;
    }

    // Progress markers
    const progressMatch = line.match(/\[PREREQ:PROGRESS:([^:]+):([^\]]+)\]/);
    if (progressMatch) {
      const [, metric, value] = progressMatch;
      updatePhase1ProgressFromMarker(metric, value);
      if (typeof options.onProgressMarker === 'function') {
        options.onProgressMarker(metric, value);
      }
      emitToWindow('prerequisites-progress', { metric, value });
      logPrereq('System', 'DEBUG', `Progress: ${metric}=${value}`);
      continue;
    }

    // Host mode result
    const hostModeMatch = line.match(/\[PREREQ:HOST_MODE:(TRUE|FALSE)\]/);
    if (hostModeMatch) {
      emitToWindow('prerequisites-host-mode', { enabled: hostModeMatch[1] === 'TRUE' });
      logPrereq('HostMode', 'INFO', `Host mode: ${hostModeMatch[1]}`);
    }
  }
}

/**
 * Flush any remaining buffered content
 */
function flushLineBuffer(emitToWindow, options = {}) {
  if (lineBuffer.trim()) {
    parseAndEmitMarkers(lineBuffer + '\n', emitToWindow, options);
  }
  lineBuffer = '';
}

// ============================================================================
// PROCESS MANAGEMENT
// ============================================================================

/**
 * Kill a process and its entire process group
 */
function killProcessGroup(child) {
  if (!child || !child.pid) return;

  console.log(`[Prerequisites] Killing process group for PID ${child.pid}`);

  try {
    // Kill the entire process group (negative PID)
    process.kill(-child.pid, 'SIGTERM');

    // Give it a moment, then force kill if needed
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (e) {
        // Process already dead, ignore
      }
    }, 3000);
  } catch (e) {
    // Process group may not exist or already dead
    console.log('[Prerequisites] Process group kill failed, trying direct kill');
    try {
      child.kill('SIGKILL');
    } catch (e2) {
      // Ignore
    }
  }
}

/**
 * Run a prerequisite phase script with streaming output
 * Uses process groups for proper cancellation of child processes
 */
function runPhaseScript(phaseNum, args = [], targetWindow = null, envOverrides = {}) {
  return new Promise((resolve) => {
    if (cancelled) {
      return resolve({ success: false, error: 'Prerequisites cancelled', retryable: false });
    }

    const phase = PHASES[phaseNum];
    const scriptPath = resolvePrereqScriptPath(phase.script);
    const timeout = PHASE_TIMEOUTS[phaseNum];
    const phaseStartedAt = new Date();
    const projectRoot = getSafeProjectRoot();
    const buildNumberArgIndex = args.indexOf('--build-number');
    const targetBuild = buildNumberArgIndex >= 0
      ? args[buildNumberArgIndex + 1]
      : null;
    const installedBuildAtStart = phaseNum === 1
      ? resolveBuildIdentity(readInstalledBuildInfo(projectRoot).data || {}).buildNumber
      : null;

    // Verify script exists
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      const displayPath = scriptPath || phase.script;
      console.error(`[Prerequisites] Script not found: ${displayPath}`);
      return resolve({ success: false, error: `Script not found: ${displayPath}`, retryable: false });
    }

    console.log(`[Prerequisites] Running phase ${phaseNum}: ${scriptPath} ${args.join(' ')}`);
    phaseStepFailures[phaseNum] = false;
    prerequisitesSession.activeStep = null;
    clearFailureMetadata();

    // Enhanced PATH for Homebrew, Docker, etc.
    let enhancedEnv;
    try {
      enhancedEnv = createRuntimeShellEnv({
        baseEnv: process.env,
        overrides: {
          PATH: buildEnhancedPath(process.env.PATH || ''),
          NODE_VERSION_REQUIRED,
          ...envOverrides
        },
        isPackagedApp: app.isPackaged === true,
        resourcesPath: process.resourcesPath
      });
    } catch (error) {
      const message = error?.message || 'Failed to resolve secure runtime credentials.';
      addLogLine(message, 'error', createEmitter(targetWindow));
      return resolve({ success: false, error: message, retryable: false });
    }
    delete enhancedEnv.CI;

    // Spawn with detached: true to create process group for clean cancellation
    const child = spawn('bash', [scriptPath, ...args], {
      cwd: getSafeProjectRoot(),
      env: enhancedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],  // Close stdin so nothing blocks waiting for input
      detached: true  // Create new process group
    });

    activeProcess = child;
    activePhase = phaseNum;

    let output = '';
    let errorOutput = '';
    let combinedOutput = '';
    let timeoutId = null;
    let phase1DownloadStallTimeoutId = null;
    let phase1DownloadMonitoring = false;
    let phase1LastDownloadedBytes = null;
    let resolved = false;

    function clearPhase1DownloadStallTimer() {
      if (phase1DownloadStallTimeoutId) {
        clearTimeout(phase1DownloadStallTimeoutId);
        phase1DownloadStallTimeoutId = null;
      }
    }

    function buildPhase1DownloadStallDetails() {
      const progress = prerequisitesSession.phase1Progress || {};
      const bytesDownloaded = Math.max(
        0,
        Number.isFinite(Number(progress.bytesDownloaded))
          ? Number(progress.bytesDownloaded)
          : Number(phase1LastDownloadedBytes) || 0
      );
      const details = [
        `No new bytes were downloaded for ${PHASE1_DOWNLOAD_STALL_TIMEOUT_MS / 60000} minutes.`,
        `Last downloaded bytes: ${bytesDownloaded}`,
      ];
      if (Number(progress.totalBytes) > 0) {
        details.push(`Total bytes: ${Number(progress.totalBytes)}`);
      }
      return details;
    }

    function failPhase1DownloadStall() {
      if (resolved || cancelled) return;
      const details = buildPhase1DownloadStallDetails();
      setFailureMetadata({
        code: PHASE1_DOWNLOAD_STALLED_CODE,
        details,
      });
      logPrereq('Download', 'ERROR', PHASE1_DOWNLOAD_STALLED_MESSAGE);
      killProcessGroup(child);
      doResolve({
        success: false,
        error: PHASE1_DOWNLOAD_STALLED_MESSAGE,
        retryable: false,
        code: PHASE1_DOWNLOAD_STALLED_CODE,
        details,
      });
    }

    function resetPhase1DownloadStallTimer() {
      if (phaseNum !== 1 || !phase1DownloadMonitoring || resolved) return;
      clearPhase1DownloadStallTimer();
      phase1DownloadStallTimeoutId = setTimeout(
        failPhase1DownloadStall,
        PHASE1_DOWNLOAD_STALL_TIMEOUT_MS
      );
    }

    function startPhase1DownloadStallMonitoring() {
      if (phaseNum !== 1 || phase1DownloadMonitoring || resolved) return;
      phase1DownloadMonitoring = true;
      resetPhase1DownloadStallTimer();
    }

    function handlePhase1ProgressMarker(metric, rawValue) {
      if (phaseNum !== 1 || resolved) return;

      if (metric === 'phase1_step') {
        if (String(rawValue).trim() === 'download') {
          startPhase1DownloadStallMonitoring();
        } else if (phase1DownloadMonitoring) {
          clearPhase1DownloadStallTimer();
          phase1DownloadMonitoring = false;
        }
        return;
      }

      if (
        metric === 'download_complete' &&
        (String(rawValue).trim() === 'true' || String(rawValue).trim() === '1')
      ) {
        clearPhase1DownloadStallTimer();
        phase1DownloadMonitoring = false;
        return;
      }

      if (metric !== 'download_bytes' || !phase1DownloadMonitoring) {
        return;
      }

      const nextBytes = Math.max(0, Number(rawValue) || 0);
      const priorBytes = phase1LastDownloadedBytes;
      phase1LastDownloadedBytes = nextBytes;
      if ((priorBytes === null && nextBytes > 0) || (priorBytes !== null && nextBytes > priorBytes)) {
        resetPhase1DownloadStallTimer();
      }
    }

    const doResolve = (result) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      clearPhase1DownloadStallTimer();
      activeProcess = null;
      activePhase = null;
      if (phaseNum !== 1) {
        resolve(result);
        return;
      }

      const updateKey = targetBuild || 'phase1-runtime-update';
      const auditResult = persistApplyAudit({
        projectRoot,
        updateKey,
        startedAt: phaseStartedAt,
        finishedAt: new Date(),
        command: ['bash', scriptPath, ...args],
        combinedOutput,
        result,
      });
      if (!auditResult.success) {
        console.warn(
          `[Prerequisites] Could not persist Phase 1 apply audit: ${auditResult.error}`,
        );
      }
      const historyResult = appendUpdateHistory({
        projectRoot,
        from: installedBuildAtStart || 'unknown',
        to: targetBuild || 'unknown',
        step: prerequisitesSession.phase1Progress?.step || 'phase1',
        result,
      });
      if (!historyResult.success) {
        console.warn(
          `[Prerequisites] Could not append Phase 1 update history: ${historyResult.error}`,
        );
      }
      resolve({
        ...result,
        auditLogFile: auditResult.success ? auditResult.path : null,
        updateHistoryFile: historyResult.success ? historyResult.path : null,
        updateTransition: {
          from: installedBuildAtStart || 'unknown',
          to: targetBuild || 'unknown',
          transitionId: `runtime-reconcile:${phaseStartedAt.toISOString()}:${targetBuild || 'unknown'}`,
        },
      });
    };

    // Set timeout
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        console.warn(`[Prerequisites] Phase ${phaseNum} timed out after ${timeout}ms`);
        killProcessGroup(child);
        doResolve({ success: false, error: `Timeout after ${timeout / 1000}s`, retryable: true });
      }, timeout);
    }

    // Emit helper for window safety
    const emitToWindow = createEmitter(targetWindow);

    // Parse stdout for markers and stream logs
    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      combinedOutput += text;
      addLogLine(text, 'info', emitToWindow);
      parseAndEmitMarkers(text, emitToWindow, { onProgressMarker: handlePhase1ProgressMarker });
    });

    // Parse stderr too (some markers may appear there)
    child.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      combinedOutput += `[stderr] ${text}`;
      addLogLine(text, 'error', emitToWindow);
      parseAndEmitMarkers(text, emitToWindow, { onProgressMarker: handlePhase1ProgressMarker });  // Also parse stderr for markers
    });

    // Handle completion
    child.on('close', (code) => {
      flushLineBuffer(emitToWindow, { onProgressMarker: handlePhase1ProgressMarker });
      const stepFailed = phaseStepFailures[phaseNum] === true;
      const success = code === 0 && !stepFailed;
      const errorMessage = success
        ? undefined
        : errorOutput || (stepFailed ? 'One or more prerequisite steps failed' : `Exit code ${code}`);
      console.log(`[Prerequisites] Phase ${phaseNum} completed with code ${code}`);

      doResolve({
        success,
        output,
        error: errorMessage,
        code,
        retryable: !success && !stepFailed  // Auto-retry only for non-step failures
      });
    });

    // Handle spawn error
    child.on('error', (err) => {
      console.error(`[Prerequisites] Phase ${phaseNum} spawn error:`, err.message);
      emitToWindow('prerequisites-error', {
        phase: phaseNum,
        error: err.message,
        code: prerequisitesSession.lastFailureCode,
        details: [...(prerequisitesSession.lastFailureDetails || [])],
        recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
      });
      doResolve({ success: false, error: err.message, retryable: true });
    });
  });
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Run a phase with retry logic and exponential backoff
 */
async function runWithRetry(phaseNum, args, targetWindow, emitToWindow, envOverrides = {}) {
  const phase = PHASES[phaseNum];
  const maxRetries = phase.retries || 0;
  let attempt = 0;
  let lastResult = null;

  while (attempt <= maxRetries) {
    if (cancelled) {
      return { success: false, error: 'Cancelled', retryable: false };
    }

    if (attempt > 0) {
      // Calculate backoff delay
      const delay = Math.min(RETRY_BASE_DELAY * Math.pow(2, attempt - 1), RETRY_MAX_DELAY);
      console.log(`[Prerequisites] Retrying phase ${phaseNum} in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);

      // Log retry to prereq logger
      const prereqLogger = getPrereqLogger();
      if (prereqLogger) {
        prereqLogger.logRetry(phaseNum, attempt + 1, maxRetries + 1, delay);
      }

      emitToWindow('prerequisites-retry', {
        phase: phaseNum,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        delayMs: delay
      });

      await new Promise(resolve => setTimeout(resolve, delay));

      if (cancelled) {
        return { success: false, error: 'Cancelled during retry wait', retryable: false };
      }
    }

    lastResult = await runPhaseScript(phaseNum, args, targetWindow, envOverrides);

    if (lastResult.success || !lastResult.retryable) {
      return lastResult;
    }

    attempt++;
  }

  // All retries exhausted
  lastError = lastResult.error;
  return lastResult;
}

// ============================================================================
// PHASE RUNNERS
// ============================================================================

/**
 * Phase 1: Download from Cloudsmith
 * Uses packaged build origin when available; local dev builds skip Cloudsmith payload download.
 */
// PORTICO-342: keep the machine awake for the duration of the Phase 1 payload download.
//
// The reported install took 11 hours of wall clock and downloaded 2,294 MB for a
// 777 MB payload. Reconstructing every attempt from the per-second progress lines
// showed why: 60.9 of the ~65 minutes of dead time was the machine ASLEEP mid
// transfer. macOS suspends the process, the socket dies, and because the payload
// went to a disposable temp file the next attempt restarted from byte zero. Four of
// the five failed attempts contained a suspension.
//
// `prevent-app-suspension` keeps the system awake but deliberately lets the DISPLAY
// sleep -- the user asked for an install, not for their screen to stay lit all night.
//
// Failing to acquire the assertion is logged and ignored: a download that might be
// interrupted is strictly better than no download at all.
function startPhase1PowerAssertion(blockerRef = powerSaveBlocker) {
  try {
    const id = blockerRef.start('prevent-app-suspension');
    console.log(`[Prerequisites] Holding power assertion ${id} for the Phase 1 payload download`);
    return {
      release() {
        try {
          if (blockerRef.isStarted(id)) {
            blockerRef.stop(id);
            console.log(`[Prerequisites] Released power assertion ${id}`);
          }
        } catch (error) {
          console.warn(`[Prerequisites] Could not release power assertion: ${error.message}`);
        }
      },
    };
  } catch (error) {
    console.warn(`[Prerequisites] Could not hold a power assertion for Phase 1: ${error.message}`);
    return { release() {} };
  }
}

async function runPhase1Download(buildNumber, targetWindow = null, options = {}) {
  const emitToWindow = createEmitter(targetWindow);
  const buildInfoResult = readBundledBuildInfo();
  const resolvedTarget = resolvePrerequisitesDownloadTarget({
    buildNumber,
    buildInfo: buildInfoResult.success ? buildInfoResult.data : null,
  });

  if (!resolvedTarget.success) {
    return { success: false, error: resolvedTarget.error };
  }

  let resolvedBuildNumber = resolvedTarget.buildNumber;
  let channel = resolvedTarget.channel;

  if (resolvedTarget.localOnly) {
    const message = 'Local dev build detected; skipping Cloudsmith payload download.';
    console.log(`[Prerequisites] ${message}`);
    emitToWindow('prerequisites-log', {
      text: message,
      type: 'info',
    });
    return {
      success: true,
      skipped: true,
      localOnly: true,
      message,
    };
  }

  if (resolvedTarget.floatingLatest) {
    console.log(
      `[Prerequisites] Local dev build detected, fetching latest ${channel} build from Cloudsmith...`,
    );
    emitToWindow('prerequisites-log', {
      text: `Local dev build: fetching latest ${channel} build...`,
      type: 'info',
    });

    const latestBuildResult = await fetchLatestBuildFromCloudsmith(channel);
    if (!latestBuildResult.success) {
      console.error('[Prerequisites] Failed to fetch latest build:', latestBuildResult.error);
      return { success: false, error: `Local dev build: ${latestBuildResult.error}` };
    }

    resolvedBuildNumber = latestBuildResult.buildNumber;
    channel = latestBuildResult.channel;
    console.log(`[Prerequisites] Using latest ${channel} build: ${resolvedBuildNumber}`);
    emitToWindow('prerequisites-log', {
      text: `Using ${channel} build: ${resolvedBuildNumber}`,
      type: 'info',
    });
  }

  console.log(
    `[Prerequisites] Phase 1 using build number: ${resolvedBuildNumber} (channel: ${channel})`,
  );
  const args = ['--build-number', resolvedBuildNumber, '--channel', channel];
  // PORTICO-342: the assertion spans the whole retry envelope, not one attempt, so a
  // sleep between attempts cannot interrupt the sequence either.
  const phase1PowerAssertion = startPhase1PowerAssertion();
  let result;
  try {
    result = await runWithRetry(1, args, targetWindow, emitToWindow);
  } finally {
    phase1PowerAssertion.release();
  }
  if (!result.success) {
    return result;
  }

  const installedBuildNumber = resolveBuildIdentity(
    readInstalledBuildInfo(getSafeProjectRoot()).data || {},
  ).buildNumber;
  if (installedBuildNumber !== resolvedBuildNumber) {
    return {
      ...result,
      success: false,
      retryable: true,
      error:
        `Phase 1 completed, but the managed build identity is ${installedBuildNumber || 'unknown'} instead of ${resolvedBuildNumber}`,
    };
  }

  try {
    secureCloudsmithBootstrapAfterManagedRuntimeUpdate(
      options.cloudsmithBootstrap || {},
    );
  } catch (error) {
    console.error(
      '[Prerequisites] Failed to secure the managed Cloudsmith bootstrap after Phase 1:',
      error.message,
    );
    return {
      ...result,
      success: false,
      retryable: true,
      error:
        `Phase 1 downloaded successfully, but managed Cloudsmith bootstrap hardening failed: ${error.message}`,
    };
  }

  const transition = result.updateTransition || {};
  const historyResult = appendUpdateHistory({
    projectRoot: getSafeProjectRoot(),
    from: transition.from || 'unknown',
    to: transition.to || resolvedBuildNumber,
    step: 'complete',
    result: 'ok',
    source: 'runtime-reconcile',
    transitionId:
      transition.transitionId ||
      `runtime-reconcile:${new Date().toISOString()}:${resolvedBuildNumber}`,
  });
  if (!historyResult.success) {
    console.warn(
      `[Prerequisites] Could not append authoritative Phase 1 update history: ${historyResult.error}`,
    );
  }

  return {
    ...result,
    updateHistoryFile: historyResult.success
      ? historyResult.path
      : result.updateHistoryFile,
  };
}

/**
 * Phase 2: Install dependencies (Homebrew, jq, Node.js)
 */
async function runPhase2Dependencies(targetWindow = null, onboardingMode = 'power', phaseOptions = {}) {
  const emitToWindow = createEmitter(targetWindow);
  const resolvedMode = normalizeOnboardingMode(onboardingMode) || 'power';
  return runWithRetry(2, [], targetWindow, emitToWindow, {
    GUIDED_SETUP_ONBOARDING_MODE: resolvedMode,
    GUIDED_SETUP_SKIP_HOST_DEPS: resolvedMode === 'basic' ? 'true' : 'false',
    GUIDED_SETUP_SKIP_HOMEBREW_AUTH: phaseOptions.skipHomebrewAuthOnRetry === true ? 'true' : 'false',
    GUIDED_SETUP_HOMEBREW_FAILURE_CODE:
      typeof phaseOptions.previousFailureCode === 'string' ? phaseOptions.previousFailureCode : '',
  });
}

/**
 * Phase 3: Docker/OrbStack setup
 */
async function runPhase3DockerSetup(targetWindow = null) {
  const emitToWindow = createEmitter(targetWindow);
  return runWithRetry(3, [], targetWindow, emitToWindow);
}

/**
 * Phase 4: Host mode check
 */
async function runPhase4HostMode(targetWindow = null, onboardingMode = 'power') {
  const emitToWindow = createEmitter(targetWindow);
  const resolvedMode = normalizeOnboardingMode(onboardingMode) || 'power';
  return runWithRetry(4, [getSafeProjectRoot()], targetWindow, emitToWindow, {
    GUIDED_SETUP_ONBOARDING_MODE: resolvedMode,
    GUIDED_SETUP_SKIP_HOST_MODE_CHECK: resolvedMode === 'basic' ? 'true' : 'false'
  });
}

// ============================================================================
// DOCKER IMAGE PULLING (JavaScript for GUI progress)
// ============================================================================

function getHarborImageTag() {
  const buildInfo = readBundledBuildInfo();
  const data = (buildInfo.success && buildInfo.data) || null;
  // PORTICO-371: MR/broker builds tag runtime images mr-<iid>-<sha> and record it
  // as dockerImageTag; prefer it so the pull plan / preflight match what was
  // pushed. Beta builds omit it or set it to the build number (same value).
  const imageTag = data && data.dockerImageTag;
  if (imageTag && imageTag !== 'dev-build') {
    return imageTag;
  }
  const buildNumber = data && data.buildNumber;
  if (buildNumber && buildNumber !== 'dev-build') {
    return buildNumber;
  }
  return 'latest';
}

function getBaseDockerImagesToPull(options = {}) {
  const projectRoot = bootstrap.PROJECT_ROOT || getSafeProjectRoot();
  return buildDockerImagesToPull({
    projectRoot,
    tag: options.tag || getHarborImageTag(),
    env: buildRuntimePlanningEnv(options.env || process.env, projectRoot),
    composeFilePaths: options.composeFilePaths || null
  });
}

function getDockerImagesToPull(options = {}) {
  return getBaseDockerImagesToPull(options);
}

function shellEscapeDoubleQuoted(value) {
  return String(value || '').replace(/(["\\$`])/g, '\\$1');
}

function buildDockerPullRecoveryCommand(imageSpecs = prioritizeDockerImagesForPull(getDockerImagesToPull())) {
  const refs = imageSpecs
    .map((imageSpec) => {
      if (!imageSpec?.name || !imageSpec?.tag) return '';
      return `${imageSpec.name}:${imageSpec.tag}`;
    })
    .filter(Boolean);

  if (refs.length === 0) {
    return 'echo "No Docker images were queued for recovery. Click Retry in Portico."';
  }

  const commandLines = refs.map((ref, index) => {
    const suffix = index === refs.length - 1 ? ' && \\' : ' && \\';
    return `docker pull "${shellEscapeDoubleQuoted(ref)}"${suffix}`;
  });
  commandLines.push('echo "Done - click Retry in Portico"');
  return commandLines.join('\n');
}

function buildDockerPullRecoveryPayload(imageSpecs = prioritizeDockerImagesForPull(getDockerImagesToPull())) {
  return {
    title: 'Run This In Terminal',
    diagnosis: 'Docker image downloads stalled in the app. Pull the required images in Terminal, then return here and click Retry.',
    command: buildDockerPullRecoveryCommand(imageSpecs),
    restartOnRetry: true,
  };
}

function getFinalizeRequiredImageSpecs(options = {}) {
  return mergeImageSpecs(
    getBaseDockerImagesToPull(options),
    getOptionalServerImageSpecs(options.selectedServerIds)
  );
}

// Docker readiness: wait for the daemon to be responsive before starting pulls.
// After OrbStack restarts or a full cleanup, the daemon may take 10–30 seconds
// to become reachable; pulling before that yields immediate exit-code-1 failures.
const DOCKER_READY_POLL_INTERVAL_MS = 3000;
const DOCKER_READY_MAX_WAIT_MS = 90000;

async function waitForDockerReadiness(options = {}) {
  const enhancedPath = buildEnhancedPath(process.env.PATH || '');
  const env = { ...process.env, PATH: enhancedPath };
  const remainingBudgetMs = getRemainingDockerPullBudgetMs(options.deadlineAt);
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? Math.max(0, options.maxWaitMs)
    : DOCKER_READY_MAX_WAIT_MS;
  const effectiveMaxWaitMs = remainingBudgetMs === null
    ? maxWaitMs
    : Math.min(maxWaitMs, remainingBudgetMs);
  if (effectiveMaxWaitMs <= 0) {
    return false;
  }

  const deadline = Date.now() + effectiveMaxWaitMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    try {
      execSync('docker info', { stdio: 'pipe', env, timeout: 10000 });
      if (attempts > 0) {
        console.log(`[Prerequisites] Docker daemon ready after ${attempts} poll(s)`);
        logPrereq('Docker', 'INFO', `Docker daemon ready after ${attempts} poll(s)`);
      }
      return true;
    } catch {
      attempts++;
      if (Date.now() + DOCKER_READY_POLL_INTERVAL_MS >= deadline) break;
      await new Promise(r => setTimeout(r, DOCKER_READY_POLL_INTERVAL_MS));
    }
  }
  console.warn(`[Prerequisites] Docker daemon not responsive after ${Math.round(effectiveMaxWaitMs / 1000)}s`);
  logPrereq('Docker', 'WARN', `Docker daemon not responsive after ${Math.round(effectiveMaxWaitMs / 1000)}s — proceeding anyway`);
  return false;
}

function isCommunityImage(imageSpec) {
  if (!imageSpec?.name) return false;
  return !imageSpec.name.includes('/');
}

// Docker pull inactivity timeout (reset on any output)
const DOCKER_PULL_INACTIVITY_TIMEOUT = 480000; // 8 minutes no activity while downloading
const DOCKER_PULL_EXTRACTION_INACTIVITY_TIMEOUT = 900000; // 15 minutes no activity while extracting
const DOCKER_PULL_TOTAL_TIMEOUT = 1200000; // 20 minutes total per image (hard safety net)
const DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS = 30 * 60 * 1000; // Floor for the full sequential recovery pass
const DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MAX_MS = 45 * 60 * 1000; // Cap for the full sequential recovery pass
const DOCKER_PULL_RECOVERY_TOTAL_BUDGET_PER_IMAGE_MS = 5 * 60 * 1000; // Scale-up amount per retryable image
const DOCKER_PULL_RECOVERY_REQUIRED_CODE = 'docker_pull_recovery_required';
const DOCKER_SNAPSHOT_STORE_REPAIR_REQUIRED_CODE = 'docker_snapshot_store_repair_required';
const MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND = 'overlayfs_snapshot_parent_missing';
const MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_SOURCE = 'failed to stat parent: stat \\/var\\/lib\\/docker\\/containerd\\/daemon\\/io\\.containerd\\.snapshotter\\.v1\\.overlayfs\\/snapshots\\/[0-9]+\\/fs: no such file or directory';
const MISSING_OVERLAYFS_SNAPSHOT_PARENT_PATTERN = new RegExp(`${MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_SOURCE}(?=\\r?\\n|$)`);
const MISSING_OVERLAYFS_SNAPSHOT_PARENT_PULL_LINE_PATTERN = new RegExp(`^(?:failed to prepare extraction snapshot "extract-[A-Za-z0-9_-]+ sha256:[0-9a-f]{64}": )?${MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_SOURCE}$`);
const DOCKER_PULL_BENIGN_PROGRESS_LINE_PATTERNS = [
  /^[A-Za-z0-9._/-]+: Pulling from [A-Za-z0-9._/-]+$/,
  /^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Already exists|Downloading(?: .*)?|Verifying Checksum|Download complete|Extracting(?: .*)?|Pull complete)$/,
  /^Digest: sha256:[0-9a-f]{64}$/,
  /^Status: (?:Downloaded newer image|Image is up to date) for .+$/,
];
const SNAPSHOT_STORE_REPAIR_SCRIPT = 'repair-missing-overlayfs-snapshot-images.sh';
const SNAPSHOT_STORE_REPAIR_FLAG = '--apply-missing-overlayfs-parent-repair';
const SNAPSHOT_STORE_REPAIR_TIMEOUT_MS = 5 * 60 * 1000;

// IPC throttle interval
const DOCKER_PULL_IPC_THROTTLE_MS = 200;
const DOCKER_PULL_RECOVERY_BACKOFF_MS = [5000, 15000, 30000];

function getDockerPullRecoveryBudgetMs(retryableFailureCount = 0) {
  const scaledBudgetMs = Math.max(0, Number(retryableFailureCount) || 0) * DOCKER_PULL_RECOVERY_TOTAL_BUDGET_PER_IMAGE_MS;
  return Math.min(
    DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MAX_MS,
    Math.max(DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS, scaledBudgetMs),
  );
}

function getRemainingDockerPullBudgetMs(deadlineAt, now = Date.now()) {
  if (!Number.isFinite(deadlineAt)) {
    return null;
  }

  return Math.max(0, deadlineAt - now);
}

function getDockerPullTimeoutCeilings(deadlineAt, now = Date.now()) {
  const remainingBudgetMs = getRemainingDockerPullBudgetMs(deadlineAt, now);
  if (remainingBudgetMs === null) {
    return {
      remainingBudgetMs,
      inactivityTimeoutMs: DOCKER_PULL_INACTIVITY_TIMEOUT,
      extractionInactivityTimeoutMs: DOCKER_PULL_EXTRACTION_INACTIVITY_TIMEOUT,
      totalTimeoutMs: DOCKER_PULL_TOTAL_TIMEOUT
    };
  }

  return {
    remainingBudgetMs,
    inactivityTimeoutMs: Math.min(DOCKER_PULL_INACTIVITY_TIMEOUT, remainingBudgetMs),
    extractionInactivityTimeoutMs: Math.min(DOCKER_PULL_EXTRACTION_INACTIVITY_TIMEOUT, remainingBudgetMs),
    totalTimeoutMs: Math.min(DOCKER_PULL_TOTAL_TIMEOUT, remainingBudgetMs)
  };
}

function buildRecoveryBudgetExhaustedMessage(recoveryBudgetMs = DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS) {
  return `Recovery exceeded the total ${Math.round(recoveryBudgetMs / 60000)} minute budget`;
}

function buildRecoveryBudgetExhaustedReason({
  recoveryStarted = false,
  recoveryAttempts = 0,
  recoveryExhaustedBeforeAttempt = false,
} = {}) {
  if (recoveryExhaustedBeforeAttempt || !recoveryStarted) {
    return 'Not attempted - recovery budget exhausted before reaching this image';
  }

  const attempts = Math.max(1, Number(recoveryAttempts) || 0);
  return `Timed out during recovery (${attempts} attempt(s))`;
}

function buildRecoveryBudgetExhaustedFailure(image, options = {}) {
  const {
    recoveryBudgetMs = DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS,
    recoveryAttempts = 0,
    recoveryStarted = false,
    recoveryExhaustedBeforeAttempt = false,
  } = options;
  return {
    success: false,
    image,
    retryable: false,
    error: buildRecoveryBudgetExhaustedReason({
      recoveryStarted,
      recoveryAttempts,
      recoveryExhaustedBeforeAttempt,
    }),
    failureKind: 'recovery_budget_exhausted',
    timeoutMs: recoveryBudgetMs,
    recoveryAttempts,
    recoveryStarted,
    recoveryExhaustedBeforeAttempt,
  };
}

/**
 * Parse byte value with unit to raw bytes
 * Handles: B, kB, KB, KiB, MB, MiB, GB, GiB, TB, TiB
 */
function parseByteValue(valueStr, unitStr) {
  const value = parseFloat(valueStr);
  if (isNaN(value)) return 0;

  const unit = (unitStr || '').toLowerCase();
  const multipliers = {
    'b': 1,
    'kb': 1000,
    'kib': 1024,
    'mb': 1000 * 1000,
    'mib': 1024 * 1024,
    'gb': 1000 * 1000 * 1000,
    'gib': 1024 * 1024 * 1024,
    'tb': 1000 * 1000 * 1000 * 1000,
    'tib': 1024 * 1024 * 1024 * 1024
  };

  return value * (multipliers[unit] || 1);
}

/**
 * Parse Docker pull output to extract layer progress
 * Supports both TTY (bracket) and plain formats:
 * - TTY: "abc123def: Downloading [====>    ] 45.2MB/100MB"
 * - Plain: "abc123def: Downloading  45.2MB/100MB"
 * - Also: "abc123def: Pull complete", "Already exists"
 */
function parseDockerPullProgress(line, imageProgress) {
  // Clean the line (remove \r and leading whitespace)
  const cleanLine = line.replace(/\r/g, '').trim();
  if (!cleanLine) return false;

  // Layer downloading (both TTY with brackets and plain formats)
  // TTY: "abc123def: Downloading [====>    ] 45.2MB/100MB"
  // Plain: "abc123def: Downloading  45.2MB/100MB"
  const downloadMatch = cleanLine.match(/^([a-f0-9]+):\s+Downloading\s+(?:\[.*\]\s+)?([\d.]+)\s*(\w+)\s*\/\s*([\d.]+)\s*(\w+)/i);
  if (downloadMatch) {
    const [, layerId, currentStr, currentUnit, totalStr, totalUnit] = downloadMatch;
    const currentBytes = parseByteValue(currentStr, currentUnit);
    const totalBytes = parseByteValue(totalStr, totalUnit);

    // Monotonic progress: never go backwards
    const existing = imageProgress.layers[layerId];
    const maxCurrent = existing ? Math.max(existing.currentBytes || 0, currentBytes) : currentBytes;

    imageProgress.layers[layerId] = {
      currentBytes: maxCurrent,
      totalBytes,
      status: 'downloading'
    };
    return true;
  }

  // Layer extracting (similar format handling)
  const extractMatch = cleanLine.match(/^([a-f0-9]+):\s+Extracting\s+(?:\[.*\]\s+)?([\d.]+)\s*(\w+)\s*\/\s*([\d.]+)\s*(\w+)/i);
  if (extractMatch) {
    const [, layerId, currentStr, currentUnit, totalStr, totalUnit] = extractMatch;
    const currentBytes = parseByteValue(currentStr, currentUnit);
    const totalBytes = parseByteValue(totalStr, totalUnit);
    imageProgress.extractionObserved = true;

    // For extraction, maintain download progress if higher
    const existing = imageProgress.layers[layerId];
    if (existing && existing.status === 'downloading') {
      // Keep download as complete, extracting is bonus progress
      imageProgress.layers[layerId].extracting = { currentBytes, totalBytes };
    } else {
      imageProgress.layers[layerId] = { currentBytes, totalBytes, status: 'extracting' };
    }
    return true;
  }

  // Layer complete: "abc123def: Pull complete" or "Already exists" or "Download complete"
  const completeMatch = cleanLine.match(/^([a-f0-9]+):\s+(Pull complete|Download complete|Already exists)/i);
  if (completeMatch) {
    const [, layerId] = completeMatch;
    const existing = imageProgress.layers[layerId];
    if (existing) {
      existing.status = 'complete';
      existing.currentBytes = existing.totalBytes || existing.currentBytes;
    } else {
      imageProgress.layers[layerId] = { currentBytes: 1, totalBytes: 1, status: 'complete' };
    }
    return true;
  }

  // Waiting: "abc123def: Waiting"
  const waitMatch = cleanLine.match(/^([a-f0-9]+):\s+Waiting/i);
  if (waitMatch) {
    const [, layerId] = waitMatch;
    if (!imageProgress.layers[layerId]) {
      imageProgress.layers[layerId] = { currentBytes: 0, totalBytes: 0, status: 'waiting' };
    }
    return true;
  }

  // Pulling fs layer: "abc123def: Pulling fs layer"
  const pullingMatch = cleanLine.match(/^([a-f0-9]+):\s+Pulling fs layer/i);
  if (pullingMatch) {
    const [, layerId] = pullingMatch;
    if (!imageProgress.layers[layerId]) {
      imageProgress.layers[layerId] = { currentBytes: 0, totalBytes: 0, status: 'pulling' };
    }
    return true;
  }

  // Verifying checksum: "abc123def: Verifying Checksum"
  const verifyMatch = cleanLine.match(/^([a-f0-9]+):\s+Verifying Checksum/i);
  if (verifyMatch) {
    const [, layerId] = verifyMatch;
    imageProgress.extractionObserved = true;
    const existing = imageProgress.layers[layerId];
    if (existing) {
      existing.status = 'verifying';
    } else {
      imageProgress.layers[layerId] = { currentBytes: 0, totalBytes: 0, status: 'verifying' };
    }
    return true;
  }

  // Download complete: "abc123def: Download complete" (without Pull complete yet)
  const downloadCompleteMatch = cleanLine.match(/^([a-f0-9]+):\s+Download complete/i);
  if (downloadCompleteMatch) {
    const [, layerId] = downloadCompleteMatch;
    const existing = imageProgress.layers[layerId];
    if (existing) {
      existing.status = 'downloaded';
    } else {
      imageProgress.layers[layerId] = { currentBytes: 1, totalBytes: 1, status: 'downloaded' };
    }
    return true;
  }

  // Image digest (near completion)
  if (cleanLine.startsWith('Digest:')) {
    imageProgress.digestReceived = true;
    return true;
  }

  // Final status
  if (cleanLine.startsWith('Status:')) {
    imageProgress.finalStatus = cleanLine.replace('Status:', '').trim();
    return true;
  }

  return false;
}

/**
 * Calculate overall progress percentage for an image.
 * Two-phase model: download (0-80%) + extraction (80-99%).
 * Returns 100 ONLY when the docker process exits successfully (status 'complete'
 * is set externally); this prevents the progress bar from hitting 100% while
 * extraction is still running.
 */
function calculateImageProgress(imageProgress) {
  const layers = Object.values(imageProgress.layers);
  if (layers.length === 0) return 0;

  const DOWNLOAD_WEIGHT = 0.8;
  const EXTRACT_WEIGHT = 0.2;

  const hasByteInfo = layers.some(l => l.totalBytes > 0);

  if (hasByteInfo) {
    let dlTotal = 0;
    let dlDone = 0;
    let exTotal = 0;
    let exDone = 0;
    let hasExtractInfo = false;

    for (const layer of layers) {
      if (layer.status === 'complete') {
        const bytes = layer.totalBytes || 1;
        dlTotal += bytes;
        dlDone += bytes;
        exTotal += bytes;
        exDone += bytes;
        continue;
      }

      if (layer.totalBytes > 0) {
        dlTotal += layer.totalBytes;
        dlDone += layer.currentBytes || 0;
      } else if (layer.status === 'downloaded') {
        dlTotal += 1;
        dlDone += 1;
      }

      if (layer.extracting && layer.extracting.totalBytes > 0) {
        hasExtractInfo = true;
        exTotal += layer.extracting.totalBytes;
        exDone += layer.extracting.currentBytes || 0;
      } else if (layer.status === 'extracting' && layer.totalBytes > 0) {
        hasExtractInfo = true;
        exTotal += layer.totalBytes;
        exDone += layer.currentBytes || 0;
      } else {
        const bytes = layer.totalBytes || 1;
        exTotal += bytes;
      }
    }

    const dlRatio = dlTotal > 0 ? dlDone / dlTotal : 0;

    let combined;
    if (hasExtractInfo) {
      const exRatio = exTotal > 0 ? exDone / exTotal : 0;
      combined = DOWNLOAD_WEIGHT * dlRatio + EXTRACT_WEIGHT * exRatio;
    } else {
      combined = DOWNLOAD_WEIGHT * dlRatio;
    }

    return Math.min(99, Math.round(combined * 100));
  }

  // Layer-count based fallback (no byte info available)
  const statusWeights = {
    'complete': 1.0,
    'downloaded': 0.75,
    'verifying': 0.7,
    'extracting': 0.6,
    'downloading': 0.4,
    'pulling': 0.1,
    'waiting': 0.05
  };

  let completedWeight = 0;
  for (const layer of layers) {
    completedWeight += statusWeights[layer.status] || 0;
  }

  const ratio = layers.length > 0 ? completedWeight / layers.length : 0;
  return Math.min(99, Math.round(ratio * 100));
}

/**
 * Calculate ETA based on download speed
 */
function calculateETA(imageProgress, startTime) {
  const elapsed = Date.now() - startTime;
  const percent = calculateImageProgress(imageProgress);

  if (percent <= 0 || percent >= 100 || elapsed < 1000) return null;

  const remaining = (elapsed / percent) * (100 - percent);
  const seconds = Math.round(remaining / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

function collectDockerPullOutputLine(stdout = "", stderr = "") {
  const candidates = `${stderr || ""}\n${stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred = candidates.find((line) =>
    /(error|denied|unauthorized|manifest|connect|timeout|refused|unknown)/i.test(line),
  );
  return preferred || candidates[0] || "";
}

function outputContainsOnlyMissingOverlayfsSnapshotParentFailure(stdout = "", stderr = "") {
  const lines = `${stderr || ""}\n${stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let exactSignatureCount = 0;

  for (const line of lines) {
    if (MISSING_OVERLAYFS_SNAPSHOT_PARENT_PULL_LINE_PATTERN.test(line)) {
      exactSignatureCount += 1;
      continue;
    }
    if (DOCKER_PULL_BENIGN_PROGRESS_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }
    return false;
  }

  return exactSignatureCount > 0;
}

function classifyDockerPullFailure({ stdout = "", stderr = "", exitCode = null, signal = null } = {}) {
  const combinedOutput = `${stderr || ""}\n${stdout || ""}`.trim();
  const normalizedOutput = combinedOutput.toLowerCase();
  const outputLine = collectDockerPullOutputLine(stdout, stderr);
  const defaultError = signal
    ? `Terminated by ${signal}`
    : outputLine || `Exit code ${exitCode}`;

  if (outputContainsOnlyMissingOverlayfsSnapshotParentFailure(stdout, stderr)) {
    return {
      failureKind: MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
      retryable: false,
      error: outputLine || "Docker overlayfs snapshot parent is missing",
    };
  }

  if (MISSING_OVERLAYFS_SNAPSHOT_PARENT_PATTERN.test(combinedOutput)) {
    return {
      failureKind: "docker_pull_failed",
      retryable: false,
      error: outputLine || "Docker pull output mixed a missing overlayfs snapshot parent with another failure",
    };
  }

  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|connect:\s+connection refused|docker daemon is not running/i.test(
      combinedOutput,
    )
  ) {
    return {
      failureKind: "daemon_unavailable",
      retryable: true,
      error: outputLine || "Cannot connect to the Docker daemon",
    };
  }

  if (
    /tls handshake timeout|i\/o timeout|connection reset by peer|temporary failure in name resolution|no such host|net\/http:\s+request canceled|context deadline exceeded/i.test(
      combinedOutput,
    )
  ) {
    return {
      failureKind: "network_error",
      retryable: true,
      error: outputLine || "Network error while pulling Docker image",
    };
  }

  if (
    /pull access denied|requested access to the resource is denied|unauthorized|authentication required|insufficient_scope|denied:/i.test(
      combinedOutput,
    )
  ) {
    return {
      failureKind: "registry_denied",
      retryable: false,
      error: outputLine || "Registry denied access to the Docker image",
    };
  }

  if (
    /manifest unknown|name unknown|repository does not exist|not found: manifest|failed to resolve reference/i.test(
      normalizedOutput,
    )
  ) {
    return {
      failureKind: "image_not_found",
      retryable: false,
      error: outputLine || "Docker image not found in the registry",
    };
  }

  return {
    failureKind: signal === "SIGTERM" ? "terminated" : "docker_pull_failed",
    retryable: signal !== "SIGTERM",
    error: defaultError,
  };
}

function isDockerRuntimeFailureKind(failureKind) {
  return [
    'daemon_unavailable',
    'process_error',
    'timeout_inactivity',
    'timeout_total',
    'terminated',
  ].includes(failureKind);
}

function isDockerRuntimeOnlyPullFailureResult(result = {}) {
  const failureDetails = Array.isArray(result.failureDetails)
    ? result.failureDetails.filter(Boolean)
    : [];
  return failureDetails.length > 0 && failureDetails.every((detail) => isDockerRuntimeFailureKind(detail.failureKind));
}

function shouldAttemptDockerWaveOrbStackRecovery({
  allowOrbStackRestartRecovery = false,
  pulled = [],
  failureDetails = [],
  waveState = null,
} = {}) {
  if (!allowOrbStackRestartRecovery || !waveState || waveState.autoRecoveryAttempted === true) {
    return false;
  }

  const normalizedFailures = Array.isArray(failureDetails) ? failureDetails.filter(Boolean) : [];
  if ((Array.isArray(pulled) ? pulled.length : 0) !== 0 || normalizedFailures.length === 0) {
    return false;
  }

  if (!normalizedFailures.every((detail) => isDockerRuntimeFailureKind(detail.failureKind))) {
    return false;
  }

  return waveState.sawSystemResume === true ||
    normalizedFailures.some((detail) => detail.failureKind === 'daemon_unavailable');
}

function hasMissingOverlayfsSnapshotParentFailure(failureDetails = []) {
  return Array.isArray(failureDetails) && failureDetails.some(
    (detail) => detail?.failureKind === MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
  );
}

function hasOnlyMissingOverlayfsSnapshotParentFailures(failureDetails = []) {
  const normalizedFailures = Array.isArray(failureDetails)
    ? failureDetails.filter(Boolean)
    : [];
  return normalizedFailures.length > 0 && normalizedFailures.every(
    (detail) => detail.failureKind === MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
  );
}

async function runMissingOverlayfsSnapshotParentRepair({
  targetWindow = null,
  runProcess = runManagedProcess,
  controller = new AbortController(),
} = {}) {
  const emitToWindow = createSessionEmitter(targetWindow);
  if (app.isPackaged !== true) {
    return {
      attempted: false,
      success: false,
      error: 'Automatic snapshot-store repair is limited to packaged builds.',
    };
  }

  const scriptPath = resolvePrereqScriptPath(SNAPSHOT_STORE_REPAIR_SCRIPT);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return {
      attempted: false,
      success: false,
      error: 'The bundled snapshot-store repair script is missing.',
    };
  }

  if (cancelled) {
    return {
      attempted: false,
      success: false,
      cancelled: true,
      error: 'Snapshot-store repair was cancelled before it started.',
    };
  }

  const startMessage = 'Docker image metadata references a missing overlayfs snapshot parent; starting scoped image-only repair.';
  addLogLine(startMessage, 'warning', emitToWindow);
  logPrereq('Docker', 'WARN', startMessage);

  return (async () => {
    let executionResult;
    try {
      const result = await runProcess('bash', [scriptPath, SNAPSHOT_STORE_REPAIR_FLAG], {
        cwd: getSafeProjectRoot(),
        env: createRuntimeShellEnv({
          baseEnv: process.env,
          overrides: {
            PATH: buildEnhancedPath(process.env.PATH || ''),
          },
          isPackagedApp: app.isPackaged === true,
          resourcesPath: process.resourcesPath,
        }),
        signal: controller.signal,
        timeoutMs: SNAPSHOT_STORE_REPAIR_TIMEOUT_MS,
      });
      executionResult = {
        success: true,
        output: `${result?.stdout || ''}${result?.stderr || ''}`,
        code: result?.code ?? 0,
      };
    } catch (error) {
      executionResult = {
        success: false,
        output: `${error?.stdout || ''}${error?.stderr || ''}`,
        error: error?.message || String(error),
        code: error?.code,
        aborted: error?.aborted === true || error?.name === 'AbortError',
      };
    }

    const output = `${executionResult?.error || ''}\n${executionResult?.output || ''}`
      .trim()
      .slice(-16000);
    if (executionResult?.success === true) {
      const successMessage = 'Scoped Docker image repair completed; replaying the full image plan once.';
      addLogLine(successMessage, 'success', emitToWindow);
      logPrereq('Docker', 'INFO', successMessage);
      return { attempted: true, success: true, output };
    }

    const error = output.split(/\r?\n/).filter(Boolean).at(-1)
      || `Scoped Docker image repair exited with code ${executionResult?.code ?? 'unknown'}`;
    const wasCancelled = executionResult?.aborted === true || cancelled;
    const failureMessage = wasCancelled
      ? 'Scoped Docker image repair was cancelled before completion.'
      : `Scoped Docker image repair could not complete safely: ${error}`;
    addLogLine(failureMessage, 'warning', emitToWindow);
    logPrereq('Docker', 'WARN', failureMessage);
    return { attempted: true, success: false, cancelled: wasCancelled, error, output };
  })();
}

async function runMissingOverlayfsSnapshotParentRecovery({
  targetWindow = null,
  runProcess = runManagedProcess,
  replay,
} = {}) {
  if (activeSnapshotStoreRecovery) {
    return {
      ...(await activeSnapshotStoreRecovery.promise),
      joined: true,
    };
  }

  const controller = new AbortController();
  const recoveryPromise = (async () => {
    const snapshotStoreRepair = await runMissingOverlayfsSnapshotParentRepair({
      targetWindow,
      runProcess,
      controller,
    });
    let replayResult = null;
    if (snapshotStoreRepair.success && !cancelled) {
      replayResult = await replay();
    }
    return { snapshotStoreRepair, replayResult };
  })();

  const ownedRecovery = { controller, promise: recoveryPromise };
  activeSnapshotStoreRecovery = ownedRecovery;
  try {
    return {
      ...(await recoveryPromise),
      joined: false,
    };
  } finally {
    if (activeSnapshotStoreRecovery === ownedRecovery) {
      activeSnapshotStoreRecovery = null;
    }
  }
}

/**
 * Pull a single Docker image with progress tracking
 * Uses --progress=plain for reliable non-TTY output
 */
function pullSingleImage(imageSpec, emitToWindow, checkCancelled, options = {}) {
  return new Promise((resolve) => {
    if (checkCancelled()) {
      return resolve({
        success: false,
        error: 'Cancelled',
        retryable: false,
        failureKind: 'cancelled'
      });
    }

    const { name, tag, label } = imageSpec;
    const imageFull = `${name}:${tag}`;
    const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : null;
    const recoveryBudgetMs = Number.isFinite(options.recoveryBudgetMs)
      ? options.recoveryBudgetMs
      : DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS;
    const imageProgress = {
      layers: {},
      digestReceived: false,
      finalStatus: null,
      extractionObserved: false
    };
    const startTime = Date.now();
    const dockerLineBuffers = { stdout: '', stderr: '' };
    const pullOutputEligibility = {
      exactSignatureCount: 0,
      unexpectedLine: false,
      exactSignatureLine: '',
    };
    let stdoutOutput = '';
    let stderrOutput = '';
    let lastEmitTime = 0;
    let totalTimeout = null;
    let inactivityTimeout = null;
    const prereqLogger = getPrereqLogger();
    let controller = null;

    const readyRef = resolveReadyImageForSpec(imageSpec);
    if (readyRef) {
      console.log(`[Prerequisites] Compatible local image already available, skipping pull: ${readyRef}`);
      if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'complete', 100, null);
      logPrereq('Docker', 'INFO', `Skipped pull (already local): ${readyRef}`);
      updateSessionDockerImage(imageFull, {
        label,
        status: 'complete',
        percent: 100,
        eta: null
      });
      emitToWindow('prerequisites-docker-pull', { image: imageFull, label, status: 'complete', percent: 100, eta: null });
      return resolve({ success: true, image: imageFull });
    }

    const incompatibleLocalImages = inspectRequiredImageSpec(imageSpec).wrongArchitectureImages;
    if (incompatibleLocalImages.length > 0) {
      const mismatchSummary = formatWrongArchitectureImageList(incompatibleLocalImages);
      console.warn(`[Prerequisites] Local image requires repull due to architecture mismatch: ${mismatchSummary}`);
      logPrereq('Docker', 'INFO', `Architecture mismatch detected; repulling ${imageFull}: ${mismatchSummary}`);
    }

    const initialTimeouts = getDockerPullTimeoutCeilings(deadlineAt);
    if (initialTimeouts.remainingBudgetMs !== null && initialTimeouts.remainingBudgetMs <= 0) {
      const exhaustedFailure = buildRecoveryBudgetExhaustedFailure(imageFull, {
        recoveryBudgetMs,
        recoveryExhaustedBeforeAttempt: true,
      });
      updateSessionDockerImage(imageFull, {
        label,
        status: 'failed',
        percent: 0,
        eta: null
      });
      emitToWindow('prerequisites-docker-pull', {
        image: imageFull,
        label,
        status: 'failed',
        percent: 0,
        eta: null,
        error: exhaustedFailure.error
      });
      console.warn(`[Prerequisites] Recovery budget exhausted for ${imageFull}: ${exhaustedFailure.error}`);
      logPrereq('Docker', 'WARN', `Recovery budget exhausted for ${imageFull}: ${exhaustedFailure.error}`);
      return resolve(exhaustedFailure);
    }

    console.log(`[Prerequisites] Pulling Docker image: ${imageFull}`);
    if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'starting', 0, null);
    updateSessionDockerImage(imageFull, {
      label,
      status: 'starting',
      percent: 0,
      eta: null
    });
    emitToWindow('prerequisites-docker-pull', {
      image: imageFull,
      label,
      status: 'starting',
      percent: 0,
      eta: null
    });

    // Spawn docker pull (output varies by Docker version/platform)
    const child = spawn('docker', ['pull', imageFull], {
      env: createRuntimeShellEnv({
        baseEnv: process.env,
        overrides: {
          PATH: buildEnhancedPath(process.env.PATH || '')
        },
        isPackagedApp: app.isPackaged === true,
        resourcesPath: process.resourcesPath
      })
    });

    let resolved = false;
    let inExtractionPhase = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(inactivityTimeout);
      clearTimeout(totalTimeout);
      unregisterActiveDockerPullController(imageFull, controller);
      resolve(result);
    };

    const emitFailure = ({
      error,
      retryable = true,
      failureKind = 'docker_pull_failed',
      signal = null,
      exitCode = null,
      timeoutMs = null
    }) => {
      const percent = calculateImageProgress(imageProgress);
      emitToWindow('prerequisites-docker-pull', {
        image: imageFull,
        label,
        status: 'failed',
        percent,
        eta: null,
        error: error || null
      });
      updateSessionDockerImage(imageFull, {
        label,
        status: 'failed',
        percent,
        eta: null
      });

      if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'failed', percent, null);

      if (failureKind === 'cancelled') {
        logPrereq('Docker', 'INFO', `Cancelled pull for ${imageFull}`);
      } else if (failureKind === 'recovery_budget_exhausted') {
        console.warn(`[Prerequisites] Recovery budget exhausted for ${imageFull}: ${error}`);
        logPrereq('Docker', 'WARN', `Recovery budget exhausted for ${imageFull}: ${error}`);
      } else if (failureKind === 'timeout_inactivity' || failureKind === 'timeout_total') {
        console.warn(`[Prerequisites] Timed out pulling ${imageFull}: ${error}`);
        logPrereq('Docker', 'WARN', `Timed out pulling ${imageFull}: ${error}`);
      } else {
        console.error(`[Prerequisites] Failed to pull: ${imageFull} (${error || 'unknown error'})`);
        logPrereq('Docker', 'ERROR', `Failed to pull ${imageFull}: ${error || 'unknown error'}`);
      }

      finish({
        success: false,
        image: imageFull,
        retryable,
        error: error || 'Docker pull failed',
        failureKind,
        signal,
        exitCode,
        timeoutMs
      });
    };

    const getTimeoutCeilings = () => getDockerPullTimeoutCeilings(deadlineAt);

    // Total per-image timeout (hard safety net)
    totalTimeout = setTimeout(() => {
      child.kill('SIGTERM');
      emitFailure({
        error: `Timed out after ${Math.round(initialTimeouts.totalTimeoutMs / 1000)}s total`,
        retryable: true,
        failureKind: 'timeout_total',
        signal: 'SIGTERM',
        timeoutMs: initialTimeouts.totalTimeoutMs
      });
    }, initialTimeouts.totalTimeoutMs);

    // Inactivity timeout (reset on any output, longer during extraction)
    const getInactivityMs = () => {
      const timeouts = getTimeoutCeilings();
      return inExtractionPhase
        ? timeouts.extractionInactivityTimeoutMs
        : timeouts.inactivityTimeoutMs;
    };

    const resetInactivityTimeout = (reason = 'output') => {
      if (resolved) {
        return;
      }

      clearTimeout(inactivityTimeout);
      const ms = getInactivityMs();
      if (ms <= 0) {
        child.kill('SIGTERM');
        emitFailure({
          error: buildRecoveryBudgetExhaustedMessage(recoveryBudgetMs),
          retryable: false,
          failureKind: 'recovery_budget_exhausted',
          signal: 'SIGTERM',
          timeoutMs: recoveryBudgetMs
        });
        return;
      }

      if (reason === 'resume') {
        logPrereq('Docker', 'INFO', `Reset inactivity timer for ${imageFull} after system resume (${Math.round(ms / 1000)}s window)`);
      }

      inactivityTimeout = setTimeout(() => {
        child.kill('SIGTERM');
        emitFailure({
          error: `No pull activity for ${ms / 1000}s`,
          retryable: true,
          failureKind: 'timeout_inactivity',
          signal: 'SIGTERM',
          timeoutMs: ms
        });
      }, ms);
    };
    controller = {
      image: imageFull,
      resetInactivityTimer: (reason = 'manual') => resetInactivityTimeout(reason),
    };
    registerActiveDockerPullController(imageFull, controller);
    resetInactivityTimeout();

    const observePullOutputLine = (rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) {
        return;
      }
      if (MISSING_OVERLAYFS_SNAPSHOT_PARENT_PULL_LINE_PATTERN.test(line)) {
        pullOutputEligibility.exactSignatureCount += 1;
        pullOutputEligibility.exactSignatureLine ||= line;
        return;
      }
      if (DOCKER_PULL_BENIGN_PROGRESS_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        return;
      }
      pullOutputEligibility.unexpectedLine = true;
    };

    const processOutput = (data, source = 'stdout') => {
      // Check for cancellation
      if (checkCancelled()) {
        child.kill('SIGTERM');
        emitFailure({
          error: 'Cancelled',
          retryable: false,
          failureKind: 'cancelled',
          signal: 'SIGTERM'
        });
        return;
      }

      resetInactivityTimeout();

      const chunk = data.toString();
      if (source === 'stderr') {
        stderrOutput = `${stderrOutput}${chunk}`.slice(-8000);
      } else {
        stdoutOutput = `${stdoutOutput}${chunk}`.slice(-8000);
      }

      dockerLineBuffers[source] += chunk;
      const lines = dockerLineBuffers[source].split('\n');
      dockerLineBuffers[source] = lines.pop() || '';

      let progressChanged = false;
      for (const line of lines) {
        observePullOutputLine(line);
        if (parseDockerPullProgress(line, imageProgress)) {
          progressChanged = true;
        }
      }

      // Throttled IPC emission
      const now = Date.now();
      if (progressChanged && now - lastEmitTime >= DOCKER_PULL_IPC_THROTTLE_MS) {
        lastEmitTime = now;
        const percent = calculateImageProgress(imageProgress);
        const eta = calculateETA(imageProgress, startTime);

        if (imageProgress.extractionObserved && !inExtractionPhase) {
          inExtractionPhase = true;
          console.log(`[Prerequisites] ${imageFull}: entering extraction phase (extended timeout)`);
          resetInactivityTimeout();
        }

        emitToWindow('prerequisites-docker-pull', {
          image: imageFull,
          label,
          status: inExtractionPhase ? 'extracting' : 'pulling',
          percent,
          eta,
          layerCount: Object.keys(imageProgress.layers).length
        });
        updateSessionDockerImage(imageFull, {
          label,
          status: inExtractionPhase ? 'extracting' : 'pulling',
          percent,
          eta
        });

        // Log Docker progress (also throttled internally)
        if (prereqLogger) prereqLogger.logDockerPull(imageFull, inExtractionPhase ? 'extracting' : 'pulling', percent, eta);
      }
    };

    child.stdout.on('data', (data) => processOutput(data, 'stdout'));
    child.stderr.on('data', (data) => processOutput(data, 'stderr'));

    child.on('close', (code, signal) => {
      if (resolved) {
        return;
      }

      const elapsed = Date.now() - startTime;
      if (code === 0) {
        emitToWindow('prerequisites-docker-pull', {
          image: imageFull,
          label,
          status: 'complete',
          percent: 100,
          eta: null
        });
        updateSessionDockerImage(imageFull, {
          label,
          status: 'complete',
          percent: 100,
          eta: null
        });
        console.log(`[Prerequisites] Successfully pulled: ${imageFull}`);
        if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'complete', 100, null);
        logPrereq('Docker', 'INFO', `Pulled ${imageFull} (${Math.round(elapsed / 1000)}s)`);
        finish({ success: true, image: imageFull });
      } else {
        for (const source of ['stdout', 'stderr']) {
          observePullOutputLine(dockerLineBuffers[source]);
          dockerLineBuffers[source] = '';
        }
        const classifiedFailure = pullOutputEligibility.exactSignatureCount > 0
          ? {
              failureKind: pullOutputEligibility.unexpectedLine
                ? 'docker_pull_failed'
                : MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
              retryable: false,
              error: pullOutputEligibility.exactSignatureLine || 'Docker overlayfs snapshot parent is missing',
            }
          : classifyDockerPullFailure({
              stdout: stdoutOutput,
              stderr: stderrOutput,
              exitCode: Number.isInteger(code) ? code : null,
              signal: signal || null,
            });
        emitFailure({
          error: classifiedFailure.error,
          retryable: classifiedFailure.retryable,
          failureKind: classifiedFailure.failureKind,
          signal: signal || null,
          exitCode: Number.isInteger(code) ? code : null
        });
      }
    });

    child.on('error', (err) => {
      if (resolved) {
        return;
      }

      emitFailure({
        error: err.message,
        retryable: true,
        failureKind: 'process_error'
      });
    });
  });
}

/**
 * Pull all Docker images with progress tracking
 * Called after Phase 3 (Docker setup) completes
 *
 * @param {Object} options
 * @param {BrowserWindow} options.targetWindow - Window to send events to
 * @param {Array} options.images - Optional override of images to pull
 * @param {number} options.maxRetries - Max retries per image during the initial concurrent wave (default: 0)
 * @returns {Promise<{success: boolean, pulled: string[], failed: string[]}>}
 */
async function pullDockerImagesWithProgress(options = {}) {
  const {
    targetWindow,
    images = getDockerImagesToPull(),
    maxRetries = 0,
    concurrency = 3,
    allowOrbStackRestartRecovery = false,
    runProcess = runManagedProcess,
  } = options;
  const emitToWindow = createEmitter(targetWindow);

  const checkCancelled = () => cancelled;

  let joinedSnapshotStoreRecovery = null;
  if (activeSnapshotStoreRecovery) {
    joinedSnapshotStoreRecovery = await runMissingOverlayfsSnapshotParentRecovery({
      targetWindow,
      runProcess,
      replay: async () => ({ success: false, cancelled: checkCancelled() }),
    });
  } else {
    // Wait for Docker daemon before starting pulls — critical after OrbStack restart.
    await waitForDockerReadiness();
  }
  if (checkCancelled() && !joinedSnapshotStoreRecovery) {
    return { success: false, pulled: [], failed: [], cancelled: true };
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, images.length || 1));
  const prioritizedImages = prioritizeDockerImagesForPull(images);
  console.log(`[Prerequisites] Starting Docker image pulls: ${prioritizedImages.length} images (concurrency=${workerCount})`);
  setSessionDockerPlan(prioritizedImages);
  currentDockerPullWave = {
    sawSystemResume: false,
    autoRecoveryAttempted: false,
  };

  try {
    emitToWindow('prerequisites-docker-pull-start', {
      totalImages: prioritizedImages.length,
      images: prioritizedImages.map(i => ({ name: i.name, tag: i.tag, label: i.label }))
    });

    const pulled = [];
    const failed = [];
    const failureDetailsByImage = new Map();
    const recoveryStateByImage = new Map();
    let snapshotStoreRepair = null;

    const removeRef = (refs, ref) => {
      let idx = refs.indexOf(ref);
      while (idx >= 0) {
        refs.splice(idx, 1);
        idx = refs.indexOf(ref);
      }
    };

    const findImageSpec = (imageRef) =>
      prioritizedImages.find((imageSpec) => `${imageSpec.name}:${imageSpec.tag}` === imageRef) || null;

    const getRecoveryState = (imageRef) => {
      if (!recoveryStateByImage.has(imageRef)) {
        recoveryStateByImage.set(imageRef, {
          recoveryAttempts: 0,
          recoveryStarted: false,
          recoveryExhaustedBeforeAttempt: false,
        });
      }
      return recoveryStateByImage.get(imageRef);
    };

    const setFailureDetail = (imageRef, detail = {}) => {
      const recoveryState = getRecoveryState(imageRef);
      failureDetailsByImage.set(imageRef, {
        ...detail,
        recoveryAttempts: recoveryState.recoveryAttempts,
        recoveryStarted: recoveryState.recoveryStarted,
        recoveryExhaustedBeforeAttempt: recoveryState.recoveryExhaustedBeforeAttempt,
      });
    };

    const buildFailureDetails = () =>
      failed.map((ref) => ({ image: ref, ...(failureDetailsByImage.get(ref) || {}) }));

    const emitProgress = () => {
      emitToWindow('prerequisites-docker-pull-progress', {
        completed: Math.min(prioritizedImages.length, pulled.length + failed.length),
        total: prioritizedImages.length,
        pulled: pulled.length,
        failed: failed.length
      });
    };

    const markRecoveryBudgetExhausted = (imageRefs = [], recoveryBudgetMs = DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS) => {
      const pendingRefs = imageRefs.filter((ref) => failed.includes(ref));
      if (pendingRefs.length === 0) {
        return;
      }

      const message = buildRecoveryBudgetExhaustedMessage(recoveryBudgetMs);
      console.warn(`[Prerequisites] ${message}: ${pendingRefs.join(', ')}`);
      logPrereq('Docker', 'WARN', `${message}: ${pendingRefs.join(', ')}`);

      for (const ref of pendingRefs) {
        const currentDetail = failureDetailsByImage.get(ref);
        if (currentDetail && currentDetail.retryable === false && currentDetail.failureKind !== 'recovery_budget_exhausted') {
          continue;
        }

        const recoveryState = getRecoveryState(ref);
        recoveryState.recoveryExhaustedBeforeAttempt = recoveryState.recoveryStarted !== true;
        const exhaustedFailure = buildRecoveryBudgetExhaustedFailure(ref, {
          recoveryBudgetMs,
          recoveryAttempts: recoveryState.recoveryAttempts,
          recoveryStarted: recoveryState.recoveryStarted,
          recoveryExhaustedBeforeAttempt: recoveryState.recoveryExhaustedBeforeAttempt,
        });
        failureDetailsByImage.set(ref, exhaustedFailure);

        const spec = findImageSpec(ref);
        if (!spec) {
          continue;
        }

        updateSessionDockerImage(ref, {
          label: spec.label,
          status: 'failed',
          percent: 0,
          eta: null
        });
        emitToWindow('prerequisites-docker-pull', {
          image: ref,
          label: spec.label,
          status: 'failed',
          percent: 0,
          eta: null,
          error: exhaustedFailure.error
        });
      }
    };

    const pullWithRetry = async (imageSpec, maxRetriesForPull = maxRetries) => {
      const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
      const effectiveMaxRetries = Math.max(0, Number(maxRetriesForPull) || 0);
      let success = false;
      let attempt = 0;
      let lastResult = null;

      while (attempt <= effectiveMaxRetries && !success && !checkCancelled()) {
        if (attempt > 0) {
          const backoffMs = DOCKER_PULL_RECOVERY_BACKOFF_MS[Math.min(attempt - 1, DOCKER_PULL_RECOVERY_BACKOFF_MS.length - 1)];
          console.log(`[Prerequisites] Retrying ${imageFull} (attempt ${attempt + 1}/${effectiveMaxRetries + 1}, backoff ${backoffMs}ms)`);
          emitToWindow('prerequisites-docker-pull', {
            image: imageFull,
            label: imageSpec.label,
            status: 'retrying',
            attempt: attempt + 1,
            maxAttempts: effectiveMaxRetries + 1
          });
          updateSessionDockerImage(imageFull, {
            label: imageSpec.label,
            status: 'retrying'
          });
          await new Promise(r => setTimeout(r, backoffMs));
        }

        lastResult = await pullSingleImage(imageSpec, emitToWindow, checkCancelled);
        success = lastResult.success;

        if (!success && !lastResult.retryable) {
          break;
        }

        attempt++;
      }

      return lastResult || { success: false, image: imageFull, retryable: false };
    };

    const runPullQueue = async (imageSpecs, queueOptions = {}) => {
      const queue = imageSpecs.slice();
      const queueMaxRetries = queueOptions.maxRetries ?? maxRetries;

      const runWorker = async () => {
        while (queue.length > 0 && !checkCancelled()) {
          const imageSpec = queue.shift();
          if (!imageSpec) break;

          const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
          removeRef(failed, imageFull);
          failureDetailsByImage.delete(imageFull);

          const result = await pullWithRetry(imageSpec, queueMaxRetries);

          if (result.success) {
            if (!pulled.includes(imageFull)) {
              pulled.push(imageFull);
            }
            failureDetailsByImage.delete(imageFull);
          } else {
            if (!failed.includes(imageFull)) {
              failed.push(imageFull);
            }
            setFailureDetail(imageFull, result);
            emitToWindow('prerequisites-docker-pull', {
              image: imageFull,
              label: imageSpec.label,
              status: 'deferred',
              percent: 100,
              eta: null
            });
            updateSessionDockerImage(imageFull, {
              label: imageSpec.label,
              status: 'deferred',
              percent: 100,
              eta: null
            });
          }

          emitProgress();
        }
      };

      const workers = Array.from({ length: workerCount }, () => runWorker());
      await Promise.all(workers);
    };

    const applyJoinedSnapshotStoreRecovery = (snapshotStoreRecovery) => {
      snapshotStoreRepair = snapshotStoreRecovery.snapshotStoreRepair;
      if (checkCancelled()) {
        return;
      }

      if (!snapshotStoreRepair.success) {
        if (failed.length === 0) {
          for (const imageSpec of prioritizedImages) {
            const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
            failed.push(imageFull);
            setFailureDetail(imageFull, {
              success: false,
              image: imageFull,
              retryable: false,
              failureKind: MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
              error: snapshotStoreRepair.error || 'The shared snapshot-store recovery failed.',
            });
          }
        }
        return;
      }

      pulled.splice(0, pulled.length);
      failed.splice(0, failed.length);
      failureDetailsByImage.clear();
      recoveryStateByImage.clear();

      for (const imageSpec of prioritizedImages) {
        const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
        const readyRef = resolveReadyImageForSpec(imageSpec);
        if (readyRef) {
          pulled.push(imageFull);
          updateSessionDockerImage(imageFull, {
            label: imageSpec.label,
            status: 'complete',
            percent: 100,
            eta: null,
          });
          continue;
        }

        failed.push(imageFull);
        setFailureDetail(imageFull, {
          success: false,
          image: imageFull,
          retryable: false,
          failureKind: MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND,
          error: `Required image ${imageFull} was not available after the shared snapshot-store recovery.`,
        });
        updateSessionDockerImage(imageFull, {
          label: imageSpec.label,
          status: 'failed',
          percent: 0,
          eta: null,
        });
      }
      emitProgress();
    };

    if (joinedSnapshotStoreRecovery) {
      applyJoinedSnapshotStoreRecovery(joinedSnapshotStoreRecovery);
    } else if (activeSnapshotStoreRecovery) {
      const snapshotStoreRecovery = await runMissingOverlayfsSnapshotParentRecovery({
        targetWindow,
        runProcess,
        replay: async () => ({ success: false, cancelled: checkCancelled() }),
      });
      applyJoinedSnapshotStoreRecovery(snapshotStoreRecovery);
    } else {
      await runPullQueue(prioritizedImages);
    }

    if (
      !checkCancelled() &&
      snapshotStoreRepair === null &&
      hasOnlyMissingOverlayfsSnapshotParentFailures(buildFailureDetails())
    ) {
      const snapshotStoreRecovery = await runMissingOverlayfsSnapshotParentRecovery({
        targetWindow,
        runProcess,
        replay: async () => {
          pulled.splice(0, pulled.length);
          failed.splice(0, failed.length);
          failureDetailsByImage.clear();
          recoveryStateByImage.clear();
          await runPullQueue(prioritizedImages, { maxRetries: 0 });
          return {
            success: failed.length === 0 && !checkCancelled(),
            cancelled: checkCancelled(),
          };
        },
      });
      snapshotStoreRepair = snapshotStoreRecovery.snapshotStoreRepair;

      if (snapshotStoreRecovery.joined) {
        applyJoinedSnapshotStoreRecovery(snapshotStoreRecovery);
      }
    }

    if (
      !checkCancelled() &&
      snapshotStoreRepair === null &&
      !hasMissingOverlayfsSnapshotParentFailure(buildFailureDetails()) &&
      shouldAttemptDockerWaveOrbStackRecovery({
        allowOrbStackRestartRecovery,
        pulled,
        failureDetails: buildFailureDetails(),
        waveState: currentDockerPullWave,
      })
    ) {
      currentDockerPullWave.autoRecoveryAttempted = true;
      const recovered = await restartOrbStackForDockerRecovery({
        targetWindow,
        reason: 'wave-recovery',
      });
      if (recovered) {
        await waitForDockerReadiness();
        await runPullQueue(
          prioritizedImages.filter((imageSpec) => failed.includes(`${imageSpec.name}:${imageSpec.tag}`))
        );
      }
    }

    if (
      !checkCancelled() &&
      snapshotStoreRepair === null &&
      failed.length > 0 &&
      !hasMissingOverlayfsSnapshotParentFailure(buildFailureDetails())
    ) {
      const retryableFailures = failed.filter((ref) => {
        const detail = failureDetailsByImage.get(ref);
        return detail && detail.retryable !== false && detail.failureKind !== 'cancelled';
      });

      if (retryableFailures.length > 0) {
        const recoveryBudgetMs = getDockerPullRecoveryBudgetMs(retryableFailures.length);
        const recoveryDeadlineAt = Date.now() + recoveryBudgetMs;
        let recoveryBudgetExhausted = false;
        console.log(`[Prerequisites] Final sequential recovery pass for ${retryableFailures.length} image(s): ${retryableFailures.join(', ')}`);
        logPrereq('Docker', 'INFO', `Final sequential recovery pass: ${retryableFailures.join(', ')}`);

        for (let refIndex = 0; refIndex < retryableFailures.length; refIndex++) {
          const ref = retryableFailures[refIndex];
          if (checkCancelled() || recoveryBudgetExhausted) break;
          const spec = findImageSpec(ref);
          if (!spec) continue;

          for (let recoveryAttempt = 0; recoveryAttempt < DOCKER_PULL_RECOVERY_BACKOFF_MS.length; recoveryAttempt++) {
            if (checkCancelled() || recoveryBudgetExhausted || !failed.includes(ref)) break;

            const remainingBudgetMs = getRemainingDockerPullBudgetMs(recoveryDeadlineAt);
            if (remainingBudgetMs !== null && remainingBudgetMs <= 0) {
              recoveryBudgetExhausted = true;
              markRecoveryBudgetExhausted(
                retryableFailures
                  .slice(refIndex)
                  .filter((candidateRef) => failed.includes(candidateRef)),
                recoveryBudgetMs,
              );
              break;
            }

            const backoffMs = DOCKER_PULL_RECOVERY_BACKOFF_MS[recoveryAttempt];
            emitToWindow('prerequisites-docker-pull', {
              image: ref,
              label: spec.label,
              status: 'retrying',
              attempt: recoveryAttempt + 2,
              maxAttempts: DOCKER_PULL_RECOVERY_BACKOFF_MS.length + 1
            });
            updateSessionDockerImage(ref, {
              label: spec.label,
              status: 'retrying'
            });

            await new Promise(r => setTimeout(r, Math.min(backoffMs, remainingBudgetMs)));
            if ((getRemainingDockerPullBudgetMs(recoveryDeadlineAt) || 0) <= 0) {
              recoveryBudgetExhausted = true;
              markRecoveryBudgetExhausted(
                retryableFailures
                  .slice(refIndex)
                  .filter((candidateRef) => failed.includes(candidateRef)),
                recoveryBudgetMs,
              );
              break;
            }

            await waitForDockerReadiness({ deadlineAt: recoveryDeadlineAt });
            if ((getRemainingDockerPullBudgetMs(recoveryDeadlineAt) || 0) <= 0) {
              recoveryBudgetExhausted = true;
              markRecoveryBudgetExhausted(
                retryableFailures
                  .slice(refIndex)
                  .filter((candidateRef) => failed.includes(candidateRef)),
                recoveryBudgetMs,
              );
              break;
            }

            const recoveryState = getRecoveryState(ref);
            recoveryState.recoveryStarted = true;
            recoveryState.recoveryAttempts += 1;
            recoveryState.recoveryExhaustedBeforeAttempt = false;
            const result = await pullSingleImage(spec, emitToWindow, checkCancelled, {
              deadlineAt: recoveryDeadlineAt,
              recoveryBudgetMs,
            });
            if (result.success) {
              removeRef(failed, ref);
              if (!pulled.includes(ref)) {
                pulled.push(ref);
              }
              failureDetailsByImage.delete(ref);
              console.log(`[Prerequisites] Recovery pull succeeded: ${ref}`);
              logPrereq('Docker', 'INFO', `Recovery pull succeeded: ${ref}`);
              break;
            }

            setFailureDetail(ref, result);
            console.warn(`[Prerequisites] Recovery pull failed for ${ref}: ${result.error}`);
            logPrereq('Docker', 'WARN', `Recovery pull failed for ${ref}: ${result.error}`);
            if (result.failureKind === 'recovery_budget_exhausted') {
              recoveryBudgetExhausted = true;
              markRecoveryBudgetExhausted(
                retryableFailures
                  .slice(refIndex)
                  .filter((candidateRef) => failed.includes(candidateRef)),
                recoveryBudgetMs,
              );
              break;
            }
          }
        }
      }
    }

    if (checkCancelled()) {
      console.log('[Prerequisites] Docker pulls cancelled');
    }

    const overallSuccess = failed.length === 0 && !checkCancelled();
    const failureDetails = buildFailureDetails();

    emitToWindow('prerequisites-docker-pull-complete', {
      success: overallSuccess,
      pulled,
      failed,
      failureDetails,
      cancelled: checkCancelled()
    });
    finalizeSessionDockerPlan({ success: overallSuccess });

    console.log(`[Prerequisites] Docker pulls complete. Pulled: ${pulled.length}, Failed: ${failed.length}`);

    return {
      success: overallSuccess,
      pulled,
      failed,
      failureDetails,
      snapshotStoreRepair,
      snapshotStoreRepairError: snapshotStoreRepair && !overallSuccess
        ? buildRequiredDockerPullFailureError({
            failed,
            failureDetails,
            snapshotStoreRepair,
          })
        : null,
      cancelled: checkCancelled()
    };
  } finally {
    currentDockerPullWave = null;
  }
}

function formatDockerPullFailureReason(detail = {}) {
  switch (detail.failureKind) {
    case 'daemon_unavailable':
      return detail.error || 'Docker daemon unavailable';
    case 'network_error':
      return detail.error || 'network error while pulling image';
    case 'registry_denied':
      return detail.error || 'registry denied access';
    case 'image_not_found':
      return detail.error || 'image not found in registry';
    case 'timeout_inactivity':
      return detail.error || 'no pull activity before timeout';
    case 'timeout_total':
      return detail.error || 'total pull timeout exceeded';
    case 'recovery_budget_exhausted':
      return detail.error || 'recovery budget exhausted';
    case 'cancelled':
      return 'cancelled';
    case 'process_error':
      return detail.error || 'docker pull process error';
    case 'terminated':
      return detail.signal ? `terminated by ${detail.signal}` : 'terminated';
    case MISSING_OVERLAYFS_SNAPSHOT_PARENT_FAILURE_KIND:
      return detail.error || 'Docker overlayfs snapshot parent is missing';
    default:
      return detail.error || 'docker pull failed';
  }
}

function buildRequiredDockerPullFailureError(dockerPullResult = {}) {
  const failureDetails = Array.isArray(dockerPullResult.failureDetails)
    ? dockerPullResult.failureDetails
    : [];
  const failures = failureDetails.length > 0
    ? failureDetails
    : (Array.isArray(dockerPullResult.failed) ? dockerPullResult.failed.map((image) => ({ image })) : []);
  if (dockerPullResult.snapshotStoreRepair) {
    const repairError = dockerPullResult.snapshotStoreRepair?.error;
    if (repairError) {
      return `Docker's local image cache is damaged, and automatic image-only repair could not complete safely (${repairError}). Quit Portico, reopen it, and retry once; if the error continues, collect debug logs and contact support.`;
    }
    if (hasMissingOverlayfsSnapshotParentFailure(failures)) {
      return "Docker's local image cache is damaged, and the condition remained after one automatic image-only repair. Collect debug logs and contact support.";
    }
    return "Docker's local image cache was repaired, but the full image replay still failed. Collect debug logs and contact support.";
  }
  if (hasMissingOverlayfsSnapshotParentFailure(failures)) {
    return "Docker's local image cache is damaged, but automatic image-only repair was unavailable. Collect debug logs and contact support.";
  }
  const exceededRecoveryBudget = failures.some((detail) => detail.failureKind === 'recovery_budget_exhausted');
  const recoveryBudgetMs = failures.reduce((maxBudget, detail) => {
    const timeoutMs = Number(detail?.timeoutMs) || 0;
    return timeoutMs > maxBudget ? timeoutMs : maxBudget;
  }, 0);
  const prefix = exceededRecoveryBudget
    ? `Required Docker images could not be downloaded from Harbor within the ${Math.round((recoveryBudgetMs || DOCKER_PULL_RECOVERY_TOTAL_BUDGET_MIN_MS) / 60000)} minute recovery budget`
    : 'Required Docker images could not be downloaded from Harbor after retries';
  if (failures.length === 0) {
    return `${prefix}. Please return to prerequisites and try again.`;
  }

  const details = failures
    .slice(0, 3)
    .map((detail) => `${detail.image} (${formatDockerPullFailureReason(detail)})`)
    .join(', ');
  const remaining = failures.length - 3;
  const suffix = remaining > 0 ? `, plus ${remaining} more` : '';

  return `${prefix}: ${details}${suffix}. Please return to prerequisites and try again.`;
}

function buildDockerPullFailureDetails(dockerPullResult = {}) {
  const failureDetails = Array.isArray(dockerPullResult.failureDetails)
    ? dockerPullResult.failureDetails
    : [];
  return failureDetails.map((detail) => `${detail.image}: ${formatDockerPullFailureReason(detail)}`);
}

function buildPackagedDockerRecoveryFailure(dockerPullResult = {}, options = {}) {
  const imageSpecs = Array.isArray(options.imageSpecs) && options.imageSpecs.length > 0
    ? options.imageSpecs
    : prioritizeDockerImagesForPull(getDockerImagesToPull());
  const snapshotStoreFailure = Boolean(dockerPullResult.snapshotStoreRepair) ||
    hasMissingOverlayfsSnapshotParentFailure(dockerPullResult.failureDetails);
  return {
    code: snapshotStoreFailure
      ? DOCKER_SNAPSHOT_STORE_REPAIR_REQUIRED_CODE
      : DOCKER_PULL_RECOVERY_REQUIRED_CODE,
    error: buildRequiredDockerPullFailureError(dockerPullResult),
    details: buildDockerPullFailureDetails(dockerPullResult),
    recovery: snapshotStoreFailure ? null : buildDockerPullRecoveryPayload(imageSpecs),
  };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

function buildCurrentResultsSnapshot() {
  return { ...prerequisitesSession.phaseResults };
}

async function runPhase1ForSession(targetWindow = null) {
  const emitToWindow = createSessionEmitter(targetWindow);
  emitPrerequisitesStartIfNeeded(targetWindow);

  if (prerequisitesSession.phaseResults.phase1?.success) {
    setPhase1Progress({
      step: 'complete',
      activity: 'Download complete.',
      percent: 100,
      downloadComplete: true
    });
    return prerequisitesSession.phaseResults.phase1;
  }

  prerequisitesSession.currentSequence = 'prefetch';
  prerequisitesSession.lastError = null;
  prerequisitesSession.failedPhase = null;
  isRunning = true;
  resetPhase1Progress();
  setPhase1Progress({
    step: 'cloudsmith-lookup',
    activity: 'Locating the requested payload...'
  });

  const prereqLogger = getPrereqLogger();
  if (prereqLogger) prereqLogger.logPhaseStart(1, PHASES[1].label);
  const phase1Start = Date.now();
  const result = await runPhase1Download(prerequisitesSession.buildNumber, targetWindow || prerequisitesSession.targetWindow);
  prerequisitesSession.phaseResults.phase1 = result;
  if (prereqLogger) prereqLogger.logPhaseComplete(1, result.success, Date.now() - phase1Start);

  if (!result.success) {
    markSessionFailure(result.error, 1);
    logPrereq('Download', 'ERROR', `Phase 1 failed: ${result.error}`);
    emitToWindow('prerequisites-complete', {
      success: false,
      failedPhase: 1,
      error: result.error,
      recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
      results: buildCurrentResultsSnapshot()
    });
    return result;
  }

  setPhase1Progress({
    step: 'complete',
    activity: 'Download complete.',
    percent: 100,
    downloadComplete: true
  });

  try {
    ensureManagedRuntimeDefaults(targetWindow || prerequisitesSession.targetWindow);
  } catch (error) {
    console.error('[Prerequisites] Failed to seed managed runtime defaults:', error.message);
    emitToWindow('prerequisites-warning', {
      message: `Unable to seed default runtime mode: ${error.message}`
    });
  }

  updateDerivedSessionState();
  return result;
}

async function runPhase2ForSession(targetWindow = null) {
  const emitToWindow = createSessionEmitter(targetWindow);
  if (prerequisitesSession.phaseResults.phase2?.success) {
    updateDerivedSessionState();
    emitToWindow('prerequisites-blocking-ready', {
      success: true,
      onboardingMode: prerequisitesSession.mode,
      results: buildCurrentResultsSnapshot()
    });
    return prerequisitesSession.phaseResults.phase2;
  }

  const phase1Result = prerequisitesSession.phaseResults.phase1?.success
    ? prerequisitesSession.phaseResults.phase1
    : await runPhase1ForSession(targetWindow);
  if (!phase1Result.success) {
    return phase1Result;
  }

  prerequisitesSession.currentSequence = 'interactive';
  prerequisitesSession.lastError = null;
  prerequisitesSession.failedPhase = null;
  isRunning = true;

  const previousFailureCode = isHomebrewAuthFailureCode(prerequisitesSession.lastFailureCode)
    ? prerequisitesSession.lastFailureCode
    : null;
  const skipHomebrewAuthOnRetry =
    prerequisitesSession.skipHomebrewAuthOnRetry === true && Boolean(previousFailureCode);
  const prereqLogger = getPrereqLogger();
  if (prereqLogger) prereqLogger.logPhaseStart(2, PHASES[2].label);
  const phase2Start = Date.now();
  const result = await runPhase2Dependencies(
    targetWindow || prerequisitesSession.targetWindow,
    getEffectiveSessionMode(),
    {
      skipHomebrewAuthOnRetry,
      previousFailureCode,
    },
  );
  prerequisitesSession.phaseResults.phase2 = result;
  prerequisitesSession.skipHomebrewAuthOnRetry = !result.success && isHomebrewAuthFailureCode(prerequisitesSession.lastFailureCode);
  if (prereqLogger) prereqLogger.logPhaseComplete(2, result.success, Date.now() - phase2Start);

  if (!result.success) {
    markSessionFailure(result.error, 2);
    logPrereq('Dependencies', 'ERROR', `Phase 2 failed: ${result.error}`);
    emitToWindow('prerequisites-complete', {
      success: false,
      failedPhase: 2,
      error: result.error,
      code: prerequisitesSession.lastFailureCode,
      details: [...(prerequisitesSession.lastFailureDetails || [])],
      recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
      results: buildCurrentResultsSnapshot()
    });
    return result;
  }

  prerequisitesSession.skipHomebrewAuthOnRetry = false;
  updateDerivedSessionState();
  emitToWindow('prerequisites-blocking-ready', {
    success: true,
    onboardingMode: prerequisitesSession.mode,
    results: buildCurrentResultsSnapshot()
  });
  return result;
}

async function runBackgroundContinuation(options = {}) {
  const {
    targetWindow = null,
    forceDockerPull = false,
    dockerImages: dockerImageOverride = null,
  } = options;
  const emitToWindow = createSessionEmitter(targetWindow);

  if (backgroundContinuationPromise) {
    return backgroundContinuationPromise;
  }

  backgroundContinuationPromise = (async () => {
    prerequisitesSession.currentSequence = 'background';
    prerequisitesSession.lastError = null;
    prerequisitesSession.failedPhase = null;
    prerequisitesSession.activeStep = null;
    isRunning = true;

    const results = prerequisitesSession.phaseResults;
    const prereqLogger = getPrereqLogger();

    if (!results.phase3?.success) {
      if (prereqLogger) prereqLogger.logPhaseStart(3, PHASES[3].label);
      const phase3Start = Date.now();
      results.phase3 = await runPhase3DockerSetup(targetWindow || prerequisitesSession.targetWindow);
      if (prereqLogger) prereqLogger.logPhaseComplete(3, results.phase3.success, Date.now() - phase3Start);
      if (!results.phase3.success) {
        markSessionFailure(results.phase3.error, 3);
        logPrereq('Docker', 'ERROR', `Phase 3 failed: ${results.phase3.error}`);
        emitToWindow('prerequisites-complete', {
          success: false,
          failedPhase: 3,
          error: results.phase3.error,
          code: prerequisitesSession.lastFailureCode,
          details: [...(prerequisitesSession.lastFailureDetails || [])],
          recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
          results: buildCurrentResultsSnapshot()
        });
        return {
          success: false,
          failedPhase: 3,
          error: results.phase3.error,
          code: prerequisitesSession.lastFailureCode,
          details: [...(prerequisitesSession.lastFailureDetails || [])],
          results: buildCurrentResultsSnapshot(),
        };
      }
    }

    if (cancelled) {
      markSessionCancelled();
      return { success: false, error: 'Cancelled', results: buildCurrentResultsSnapshot() };
    }

    if (forceDockerPull || !results.dockerPull?.success) {
      const dockerImages = Array.isArray(dockerImageOverride) && dockerImageOverride.length > 0
        ? dockerImageOverride
        : getDockerImagesToPull();
      console.log('[Prerequisites] Pulling Docker images with progress');
      logPrereq('Docker', 'INFO', `Starting Docker image pulls (${dockerImages.length} images)`);
      emitToWindow('prerequisites-phase-start', { phase: 3, label: 'Pulling Docker images...' });
      results.dockerPull = await pullDockerImagesWithProgress({
        targetWindow: targetWindow || prerequisitesSession.targetWindow,
        images: dockerImages,
        allowOrbStackRestartRecovery: true,
      });
      if (!results.dockerPull.success) {
        if (results.dockerPull.cancelled || cancelled) {
          markSessionCancelled();
          return { success: false, error: 'Cancelled', results: buildCurrentResultsSnapshot() };
        }

        if (isPackagedManagedBuild()) {
          const dockerPullFailure = buildPackagedDockerRecoveryFailure(results.dockerPull, {
            imageSpecs: prioritizeDockerImagesForPull(dockerImages),
          });
          setFailureMetadata({
            code: dockerPullFailure.code,
            details: dockerPullFailure.details,
            recovery: dockerPullFailure.recovery,
          });
          markSessionFailure(dockerPullFailure.error, 3);
          logPrereq('Docker', 'ERROR', dockerPullFailure.error);
          emitToWindow('prerequisites-complete', {
            success: false,
            failedPhase: 3,
            error: dockerPullFailure.error,
            code: dockerPullFailure.code,
            details: dockerPullFailure.details,
            recovery: cloneFailureRecovery(dockerPullFailure.recovery),
            results: buildCurrentResultsSnapshot()
          });
          return {
            success: false,
            failedPhase: 3,
            error: dockerPullFailure.error,
            code: dockerPullFailure.code,
            details: dockerPullFailure.details,
            recovery: cloneFailureRecovery(dockerPullFailure.recovery),
            results: buildCurrentResultsSnapshot()
          };
        }

        const failed = results.dockerPull.failed || [];
        const withLocal = [];
        const incompatibleLocal = [];
        const withoutLocal = [];
        for (const failedRef of failed) {
          const localRef = harborToLocalImageRef(failedRef);
          if (localRef && isDockerImageReady(localRef)) {
            withLocal.push(`${failedRef} → local ${localRef}`);
          } else if (localRef && checkLocalDockerImageExists(localRef)) {
            const localArch = inspectDockerImageArchitecture(localRef) || 'unknown';
            incompatibleLocal.push(`${failedRef} → local ${localRef} (${localArch} on ${getHostDockerArchitecture()})`);
          } else {
            withoutLocal.push(failedRef);
          }
        }
        if (withLocal.length > 0) {
          console.log('[Prerequisites] Harbor pull failed but local images available:', withLocal);
          logPrereq('Docker', 'INFO', `Local image fallbacks: ${withLocal.join(', ')}`);
        }
        if (incompatibleLocal.length > 0) {
          console.warn('[Prerequisites] Harbor pull failed and local images have the wrong architecture:', incompatibleLocal);
          logPrereq('Docker', 'WARN', `Local image fallbacks rejected due to architecture mismatch: ${incompatibleLocal.join(', ')}`);
        }
        if (withoutLocal.length > 0) {
          console.warn('[Prerequisites] Harbor pull failed, no local image yet (install will build):', withoutLocal);
          logPrereq('Docker', 'WARN', `Harbor images unavailable, will be built during install: ${withoutLocal.join(', ')}`);
        }
        results.dockerPull.success = true;
        results.dockerPull.localFallbacks = withLocal;
        results.dockerPull.incompatibleLocalFallbacks = incompatibleLocal;
        results.dockerPull.deferredBuilds = withoutLocal;
        emitToWindow('prerequisites-docker-pull-deferred', {
          deferredImages: failed,
          message: 'Will be built locally during installation'
        });
      }
      logPrereq('Docker', 'INFO', `Docker image pull phase complete: ${results.dockerPull.pulled.length} pulled, ${(results.dockerPull.deferredBuilds || []).length} deferred to install`);
      emitToWindow('prerequisites-phase-complete', { phase: 3 });
    }

    if (cancelled) {
      markSessionCancelled();
      return { success: false, error: 'Cancelled', results: buildCurrentResultsSnapshot() };
    }

    if (getEffectiveSessionMode() === 'power') {
      if (!results.phase4?.success || results.phase4?.skipped === true) {
        console.log('[Prerequisites] Starting Phase 4: Host Mode Check');
        if (prereqLogger) prereqLogger.logPhaseStart(4, PHASES[4].label);
        const phase4Start = Date.now();
        results.phase4 = await runPhase4HostMode(targetWindow || prerequisitesSession.targetWindow, getEffectiveSessionMode());
        if (prereqLogger) prereqLogger.logPhaseComplete(4, results.phase4.success, Date.now() - phase4Start);
      }
    } else if (!results.phase4) {
      emitToWindow('prerequisites-phase-start', { phase: 4, label: 'Downloading Docker images...' });
      emitToWindow('prerequisites-host-mode', { enabled: false });
      emitToWindow('prerequisites-phase-complete', { phase: 4 });
      results.phase4 = { success: true, skipped: true };
    }

    const overallSuccess = Boolean(
      results.phase1?.success &&
      results.phase2?.success &&
      results.phase3?.success &&
      (!results.dockerPull || results.dockerPull.success)
    );

    prerequisitesSession.currentSequence = overallSuccess ? 'complete' : 'failed';
    prerequisitesSession.activeStep = null;
    updateDerivedSessionState();
    emitToWindow('prerequisites-complete', {
      success: overallSuccess,
      recovery: cloneFailureRecovery(prerequisitesSession.lastFailureRecovery),
      results: buildCurrentResultsSnapshot()
    });
    if (prereqLogger) prereqLogger.logIpcEvent('prerequisites-complete', { success: overallSuccess });
    if (prereqLogger && prerequisitesSession.startedAt) {
      prereqLogger.logSessionEnd(overallSuccess, Date.now() - prerequisitesSession.startedAt);
    }

    return { success: overallSuccess, results: buildCurrentResultsSnapshot() };
  })();

  try {
    return await backgroundContinuationPromise;
  } finally {
    backgroundContinuationPromise = null;
    isRunning = Boolean(prefetchPromise || interactiveContinuationPromise);
    if (!isRunning) {
      activeProcess = null;
      activePhase = null;
    }
  }
}

async function prerequisitesStartBackgroundPrefetch(options = {}) {
  const { buildNumber, targetWindow } = options;
  const onboardingMode = normalizeOnboardingMode(options.onboardingMode);
  ensurePrerequisitesSession({ buildNumber, targetWindow, onboardingMode, preserveLogs: false });
  emitPrerequisitesStartIfNeeded(targetWindow);

  if (prerequisitesSession.phaseResults.phase1?.success) {
    return { success: true, started: false, status: buildDetailedStatus() };
  }

  if (prefetchPromise) {
    return { success: true, started: false, status: buildDetailedStatus() };
  }

  prefetchPromise = (async () => {
    try {
      return await runPhase1ForSession(targetWindow);
    } finally {
      prefetchPromise = null;
      isRunning = Boolean(interactiveContinuationPromise || backgroundContinuationPromise);
      if (!isRunning) {
        activeProcess = null;
        activePhase = null;
      }
    }
  })();

  return { success: true, started: true, status: buildDetailedStatus() };
}

async function prerequisitesResumeInteractive(options = {}) {
  const { buildNumber, targetWindow } = options;
  const onboardingMode = normalizeOnboardingMode(options.onboardingMode) || 'power';
  const purpose = typeof options.purpose === 'string' ? options.purpose.trim() : '';
  const hasHostSelections = options.hasHostSelections === true;
  const previousFailureCode =
    typeof options.previousFailureCode === 'string' ? options.previousFailureCode.trim() : '';
  const skipHomebrewAuthOnRetry =
    options.skipHomebrewAuthOnRetry === true && isHomebrewAuthFailureCode(previousFailureCode);
  const requiresHost = onboardingMode === 'power' && hasHostSelections;
  ensurePrerequisitesSession({
    buildNumber,
    targetWindow,
    onboardingMode,
    preserveLogs: true,
    previousFailureCode,
    skipHomebrewAuthOnRetry,
  });
  emitPrerequisitesStartIfNeeded(targetWindow);
  const shouldRestartDockerOnRetry = previousFailureCode === DOCKER_PULL_RECOVERY_REQUIRED_CODE;

  if (purpose === 'guided-setup-finalize') {
    const runtimeReadiness = getRuntimeFinalizeReadiness({
      mode: onboardingMode,
      hasHostSelections,
      selectedServerIds: options.selectedServerIds
    });

    if (runtimeReadiness.ready) {
      console.log('[Prerequisites] Guided-setup finalize recovery reused runtime-ready assets');
      markSessionReadyFromExistingRuntime({
        onboardingMode,
        hostModeEnabled: runtimeReadiness.hostModeEnabled,
        requiresHost,
        source: 'runtime'
      });
      return {
        success: true,
        started: false,
        blockingReady: prerequisitesSession.blockingReady,
        status: buildDetailedStatus()
      };
    }

    if (prerequisitesSession.phaseResults.phase1?.success && prerequisitesSession.phaseResults.phase2?.success) {
      updateDerivedSessionState();
      const missingImages = Array.isArray(runtimeReadiness.missingImages) ? runtimeReadiness.missingImages : [];
      const wrongArchitectureImages = Array.isArray(runtimeReadiness.wrongArchitectureImages)
        ? runtimeReadiness.wrongArchitectureImages
        : [];
      const shouldRepullImages = missingImages.length > 0 || wrongArchitectureImages.length > 0;
      const alreadyRunning = Boolean(backgroundContinuationPromise);

      if (!alreadyRunning) {
        if (shouldRestartDockerOnRetry) {
          await restartOrbStackForDockerRecovery({
            targetWindow,
            reason: 'retry',
          });
        }
        void runBackgroundContinuation({
          targetWindow,
          forceDockerPull: shouldRepullImages,
          dockerImages: shouldRepullImages
            ? getFinalizeRequiredImageSpecs({ selectedServerIds: options.selectedServerIds })
            : null,
        });
      }

      return {
        success: true,
        started: !alreadyRunning,
        blockingReady: prerequisitesSession.blockingReady,
        status: buildDetailedStatus()
      };
    }
  }

  if (prerequisitesSession.phaseResults.phase1?.success && prerequisitesSession.phaseResults.phase2?.success) {
    updateDerivedSessionState();
    if (prerequisitesSession.currentSequence !== 'complete') {
      if (shouldRestartDockerOnRetry) {
        await restartOrbStackForDockerRecovery({
          targetWindow,
          reason: 'retry',
        });
      }
      void runBackgroundContinuation({ targetWindow });
    }
    return { success: true, started: false, blockingReady: true, status: buildDetailedStatus() };
  }

  const installedReadiness = await getInstalledPrereqReadiness({
    scope: 'finalize',
    includeFinalizeGenerator: true
  });
  if (canUseInstalledPrereqFastPath({ onboardingMode, installedReadiness })) {
    markSessionReadyFromExistingRuntime({
      onboardingMode,
      hostModeEnabled: installedReadiness.hostModeEnabled,
      requiresHost: onboardingMode !== 'basic',
      source: 'installed'
    });
    return { success: true, started: false, blockingReady: prerequisitesSession.blockingReady, status: buildDetailedStatus() };
  }

  if (interactiveContinuationPromise) {
    return { success: true, started: false, blockingReady: prerequisitesSession.blockingReady, status: buildDetailedStatus() };
  }

  interactiveContinuationPromise = (async () => {
    try {
      const phase1Result = prerequisitesSession.phaseResults.phase1?.success
        ? prerequisitesSession.phaseResults.phase1
        : await (prefetchPromise || runPhase1ForSession(targetWindow));
      if (!phase1Result.success) {
        return { success: false, blockingReady: false, status: buildDetailedStatus() };
      }

      const phase2Result = await runPhase2ForSession(targetWindow);
      if (!phase2Result.success) {
        return { success: false, blockingReady: false, status: buildDetailedStatus() };
      }

      if (shouldRestartDockerOnRetry) {
        await restartOrbStackForDockerRecovery({
          targetWindow,
          reason: 'retry',
        });
      }
      void runBackgroundContinuation({ targetWindow });
      return { success: true, blockingReady: true, status: buildDetailedStatus() };
    } finally {
      interactiveContinuationPromise = null;
      isRunning = Boolean(prefetchPromise || backgroundContinuationPromise);
      if (!isRunning) {
        activeProcess = null;
        activePhase = null;
      }
    }
  })();

  return { success: true, started: true, blockingReady: prerequisitesSession.blockingReady, status: buildDetailedStatus() };
}

async function runAllPrerequisites(options = {}) {
  const { buildNumber, targetWindow } = options;
  const onboardingMode = normalizeOnboardingMode(options.onboardingMode) || 'power';
  resetPrerequisitesSession({ buildNumber, targetWindow, onboardingMode, preserveLogs: false });
  emitPrerequisitesStartIfNeeded(targetWindow);
  logPrereq('System', 'INFO', `Starting prerequisites - staged session (buildNumber: ${buildNumber || 'auto'}, mode: ${onboardingMode})`);

  const phase1Result = await runPhase1ForSession(targetWindow);
  if (!phase1Result.success) {
    return { success: false, failedPhase: 1, error: phase1Result.error, results: buildCurrentResultsSnapshot() };
  }

  const phase2Result = await runPhase2ForSession(targetWindow);
  if (!phase2Result.success) {
    return { success: false, failedPhase: 2, error: phase2Result.error, results: buildCurrentResultsSnapshot() };
  }

  return runBackgroundContinuation({ targetWindow });
}

// ============================================================================
// CONTROL FUNCTIONS
// ============================================================================

/**
 * Cancel running prerequisites
 */
function cancelPrerequisites() {
  console.log('[Prerequisites] Cancel requested');
  cancelled = true;
  const snapshotStoreRecoveryDrain = activeSnapshotStoreRecovery?.promise || null;
  if (prefetchPromise || interactiveContinuationPromise || backgroundContinuationPromise) {
    markSessionCancelled();
  }

  if (activeProcess) {
    console.log('[Prerequisites] Killing active process group');
    killProcessGroup(activeProcess);
    activeProcess = null;
  }
  if (activeSnapshotStoreRecovery) {
    console.log('[Prerequisites] Aborting active snapshot-store recovery');
    activeSnapshotStoreRecovery.controller.abort();
  }
  return snapshotStoreRecoveryDrain;
}

/**
 * Reset cancellation flag for callers that reuse individual helpers directly.
 */
function resetPrerequisitesCancellation() {
  cancelled = false;
}

/**
 * Get current prerequisites status with detailed info
 */
function getPrerequisitesStatus() {
  return buildDetailedStatus();
}

function getPrerequisitesDetailedStatus() {
  return buildDetailedStatus();
}

async function checkAuthorizeReadiness() {
  const requiredSpecs = buildAuthorizeRequiredImageSpecs();
  const waiting = Boolean(backgroundContinuationPromise || isRunning);
  if (!prerequisitesSession.blockingReady && !waiting) {
    const installedReadiness = await getInstalledPrereqReadiness({ scope: 'authorize' });
    if (installedReadiness.skip) {
      return buildReadinessPayload({
        requiredSpecs,
        blockingInstallStillRunning: false,
        errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
      });
    }
    return buildBlockedReadiness(requiredSpecs, GENERIC_GUIDED_SETUP_PREREQ_ERROR);
  }
  return buildReadinessPayload({
    requiredSpecs,
    blockingInstallStillRunning: waiting,
    errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
  });
}

async function checkFinalizeReadiness(options = {}) {
  const requiredSpecs = getFinalizeRequiredImageSpecs(options);
  const waiting = Boolean(backgroundContinuationPromise || isRunning);
  const requiresHost = options.mode === 'power' && options.hasHostSelections === true;
  const projectRoot = getSafeProjectRoot();

  if (shouldUseSessionFinalizeReadiness(waiting)) {
    const payload = applyFinalizeOptionalImagePlatformWarnings(
      buildReadinessPayload({
        requiredSpecs,
        blockingInstallStillRunning: waiting,
        errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
      }),
      {
        projectRoot,
        selectedServerIds: options.selectedServerIds,
        errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
      }
    );
    const hostReady =
      !requiresHost ||
      isHostModeEnabled(projectRoot) ||
      (
        prerequisitesSession.phaseResults.phase4?.success === true &&
        prerequisitesSession.phaseResults.phase4?.skipped !== true
      );
    const readiness = applyRequiredHostPrerequisiteReadiness(
      applyFinalizeReadinessChecks(payload, {
        requiresHost,
        hostReady,
        waiting,
        errorMessage: GENERIC_GUIDED_SETUP_PREREQ_ERROR
      }),
      { ...options, waiting }
    );
    console.log('[Prerequisites] Finalize readiness from active session:', {
      currentSequence: prerequisitesSession.currentSequence,
      blockingReady: prerequisitesSession.blockingReady,
      backgroundReady: prerequisitesSession.backgroundReady,
      waiting,
      requiresHost,
      selectedServerIds: normalizeSelectedServerIds(options.selectedServerIds),
      ...summarizeReadinessForLog(readiness)
    });
    return readiness;
  }

  const runtimeReadiness = getRuntimeFinalizeReadiness({
    projectRoot,
    requiredSpecs,
    mode: options.mode,
    hasHostSelections: options.hasHostSelections,
    selectedServerIds: options.selectedServerIds,
    hostPrerequisites: options.hostPrerequisites
  });
  console.log('[Prerequisites] Finalize readiness from runtime fallback:', {
    currentSequence: prerequisitesSession.currentSequence,
    blockingReady: prerequisitesSession.blockingReady,
    backgroundReady: prerequisitesSession.backgroundReady,
    waiting,
    requiresHost,
    selectedServerIds: normalizeSelectedServerIds(options.selectedServerIds),
    ...summarizeReadinessForLog(runtimeReadiness)
  });
  return runtimeReadiness;
}

function getFinalizeGeneratorReadiness() {
  if (!app.isPackaged) {
    return { ready: true, error: null };
  }

  try {
    resolveMcpOrcBinary(getSafeProjectRoot(), {
      isPackagedApp: app.isPackaged,
      resourcesPath: process.resourcesPath,
      env: process.env,
      execPath: process.execPath,
      defaultApp: process.defaultApp,
      platform: process.platform,
      arch: process.arch,
    });
    return { ready: true, error: null };
  } catch (error) {
    return {
      ready: false,
      error: error?.message || 'This packaged build is missing its bundled MCP generator binary.',
    };
  }
}

async function shouldSkipPrerequisites(options = {}) {
  return getInstalledPrereqReadiness({
    ...options,
    scope: 'finalize',
    includeFinalizeGenerator: true
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  readBundledBuildInfo,
  readInstalledBuildInfo,
  doesInstalledBuildMatchBundledBuild,
  updateInstalledRuntimeToBundledBuild,
  runPhase1Download,
  runPhase2Dependencies,
  runPhase3DockerSetup,
  runPhase4HostMode,
  getDockerImagesToPull,
  pullDockerImagesWithProgress,
  buildPackagedDockerRecoveryFailure,
  prerequisitesStartBackgroundPrefetch,
  prerequisitesResumeInteractive,
  runAllPrerequisites,
  cancelPrerequisites,
  resetPrerequisitesCancellation,
  handleSystemResume,
  getPrerequisitesStatus,
  getPrerequisitesDetailedStatus,
  checkAuthorizeReadiness,
  checkFinalizeReadiness,
  shouldSkipPrerequisites,
  _test: {
    // PORTICO-342: exposed so the power-assertion policy can be driven with a fake
    // blocker; acquiring a real one needs a live Electron app.
    startPhase1PowerAssertion,
    evaluateInstalledPrereqReadiness,
    getInstalledPrereqReadiness,
    getRuntimeFinalizeReadiness,
    applyRequiredHostPrerequisiteReadiness,
    getFinalizeRequiredImageSpecs,
    getOptionalServerImageSpecs,
    canUseInstalledPrereqFastPath,
    markSessionReadyFromExistingRuntime,
    resetPrerequisitesSession,
    buildRequiredDockerPullFailureError,
    buildPackagedDockerRecoveryFailure,
    buildDockerPullRecoveryCommand,
    buildDockerPullRecoveryPayload,
    buildRecoveryBudgetExhaustedFailure,
    buildRecoveryBudgetExhaustedReason,
    classifyDockerPullFailure,
    getDockerPullRecoveryBudgetMs,
    getDockerPullTimeoutCeilings,
    isDockerRuntimeFailureKind,
    isDockerRuntimeOnlyPullFailureResult,
    shouldAttemptDockerWaveOrbStackRecovery,
    getCandidateImageRefsForSpec,
    isPackagedManagedBuild,
    prioritizeDockerImagesForPull,
    parseAndEmitMarkers,
    runPhaseScript,
    stopManagedRuntimeForUpdate,
    ensurePrerequisitesSession,
    buildDetailedStatus,
    PHASE1_DOWNLOAD_STALL_TIMEOUT_MS,
    PHASE1_DOWNLOAD_STALLED_CODE,
    registerActiveDockerPullController,
    unregisterActiveDockerPullController,
    handleSystemResume,
    resetBundledBuildInfoCache() {
      bundledBuildInfoCache = null;
    },
    fetchLatestBuildFromCloudsmith,
    getSessionState() {
      return prerequisitesSession;
    }
  }
};
