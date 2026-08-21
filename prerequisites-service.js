// prerequisites-service.js - Electron main process orchestrator for prerequisite shell scripts
// Orchestrates 4 phases: Download, Dependencies, Docker Setup, Host Mode Check
// Streams stdout/stderr to renderer, parses progress markers, handles retries

const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

const state = require('./shared-state');
const bootstrap = require('./bootstrap');
const { getPrereqLogger, logPrereq } = require('./prereq-logger');
const cloudsmithConfig = require('../config/cloudsmith-config');
const { buildDockerImagesToPull, harborToLocalImageRef, HARBOR_IMAGE_BASE } = require('./docker-image-plan');
const { resolveMcpOrcBinary } = require('./mcp-orc-cli');
const { resolvePrerequisitesDownloadTarget } = require('./prerequisites-download-target');
const { resolveBuildChannel } = require('../utils/build-info');
const { evaluateSetupRequirementStatus } = require('./setup-completion');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_MANAGED_ROOT = path.join(os.homedir(), 'portico', 'portico-managed');
const NODE_VERSION_REQUIRED = process.env.NODE_VERSION_REQUIRED || '20.19.0';
const ORBSTACK_XBIN = '/Applications/OrbStack.app/Contents/MacOS/xbin';
const ORBSTACK_BIN  = '/Applications/OrbStack.app/Contents/MacOS/bin';
const ORBSTACK_USER_XBIN = path.join(os.homedir(), 'Applications', 'OrbStack.app', 'Contents', 'MacOS', 'xbin');
const ORBSTACK_USER_BIN = path.join(os.homedir(), 'Applications', 'OrbStack.app', 'Contents', 'MacOS', 'bin');
const SYSTEM_PATH_FALLBACK = [
  ORBSTACK_XBIN,
  ORBSTACK_BIN,
  ORBSTACK_USER_XBIN,
  ORBSTACK_USER_BIN,
  `${os.homedir()}/.orbstack/bin`,
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(':');
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

function buildEnhancedPath(basePath = process.env.PATH || '') {
  return basePath ? `${basePath}:${SYSTEM_PATH_FALLBACK}` : SYSTEM_PATH_FALLBACK;
}

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
  1: 600000,  // 10 min for download
  2: 2400000,  // 40 min for dependencies (CLT install can be slow)
  3: 600000,  // 10 min for docker setup
  4: 60000    // 1 min for host mode check
};

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
  const { onboardingMode, buildNumber, targetWindow, preserveLogs = true } = options;
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
  prerequisitesSession.currentSequence = 'failed';
  lastError = prerequisitesSession.lastError;
  isRunning = false;
  updateDerivedSessionState();
}

function markSessionCancelled() {
  prerequisitesSession.currentSequence = 'cancelled';
  prerequisitesSession.lastError = 'Cancelled';
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
    startedAt: prerequisitesSession.startedAt || startedAt,
    lastError: prerequisitesSession.lastError || lastError,
    elapsedMs: prerequisitesSession.startedAt ? Date.now() - prerequisitesSession.startedAt : null,
    dockerImages: getDockerImagePlanSummary(),
    recentLogs: logRingBuffer.slice(-50),
    currentSequence: prerequisitesSession.currentSequence,
    onboardingMode: prerequisitesSession.mode,
    blockingReady: prerequisitesSession.blockingReady,
    backgroundReady: prerequisitesSession.backgroundReady,
    failedPhase: prerequisitesSession.failedPhase,
    phaseResults: prerequisitesSession.phaseResults,
    phase1Progress: { ...prerequisitesSession.phase1Progress },
    dockerPull: {
      ...prerequisitesSession.dockerPull,
      images: Object.values(prerequisitesSession.dockerPull.images || {})
    }
  };
}

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

function resolveReadyImageForSpec(imageSpec) {
  if (!imageSpec?.name || !imageSpec?.tag) return null;
  const exactRef = `${imageSpec.name}:${imageSpec.tag}`;
  if (isDockerImageReady(exactRef)) {
    return exactRef;
  }
  const fallbackRef = harborToLocalImageRef(exactRef);
  if (fallbackRef && isDockerImageReady(fallbackRef)) {
    return fallbackRef;
  }
  return null;
}

function buildAuthorizeRequiredImageSpecs() {
  const tag = getHarborImageTag();
  return [
    { name: 'nginx', tag: 'alpine', label: 'Nginx' },
    { name: `${HARBOR_IMAGE_BASE}/mcp-orc-rust`, tag, label: 'MCP Runtime' }
  ];
}

function calculateRequiredImageProgress(requiredSpecs = []) {
  if (!Array.isArray(requiredSpecs) || requiredSpecs.length === 0) {
    return { readyCount: 0, total: 0, percent: 100, missing: [], readyImages: [] };
  }

  const readyImages = [];
  const missing = [];
  let totalPercent = 0;

  requiredSpecs.forEach((spec) => {
    const exactRef = `${spec.name}:${spec.tag}`;
    const readyRef = resolveReadyImageForSpec(spec);
    if (readyRef) {
      readyImages.push(readyRef);
      totalPercent += 100;
      return;
    }

    const dockerEntry = prerequisitesSession.dockerPull.images[exactRef];
    totalPercent += Math.max(0, Math.min(100, Number(dockerEntry?.percent) || 0));
    missing.push(exactRef);
  });

  return {
    readyCount: readyImages.length,
    total: requiredSpecs.length,
    percent: Math.round(totalPercent / requiredSpecs.length),
    missing,
    readyImages
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
    error: !ready && !blockingInstallStillRunning ? (errorMessage || 'Oops, something went wrong. Please navigate to the prereqs step.') : null
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
    error: errorMessage || 'Oops, something went wrong. Please navigate to the prereqs step.'
  };
}

function isHostModeEnabled(projectRoot = getSafeProjectRoot()) {
  try {
    const hostModePath = path.join(projectRoot, 'HOST_MODE');
    return fs.readFileSync(hostModePath, 'utf8').trim().toLowerCase() === 'true';
  } catch (_error) {
    return false;
  }
}

async function getInstalledPrereqReadiness(options = {}) {
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const userDataPath = options.userDataPath ||
    (app && typeof app.getPath === 'function' ? app.getPath('userData') : undefined);
  const readiness = await shouldSkipPrerequisites({
    projectRoot,
    userDataPath,
    resourcesPath: options.resourcesPath || process.resourcesPath,
    appRoot: options.appRoot || path.join(projectRoot, 'electron-app')
  });

  return {
    ...readiness,
    hostModeEnabled: isHostModeEnabled(projectRoot)
  };
}

function markSessionReadyFromInstalledState({ onboardingMode, hostModeEnabled }) {
  prerequisitesSession.currentSequence = 'complete';
  prerequisitesSession.lastError = null;
  prerequisitesSession.failedPhase = null;
  prerequisitesSession.phaseResults.phase1 = {
    success: true,
    skipped: true,
    message: 'Using existing installed build'
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
function readBundledBuildInfo() {
  try {
    // In packaged app: Contents/Resources/build-info.json
    const bundledPath = path.join(process.resourcesPath, 'build-info.json');

    if (fs.existsSync(bundledPath)) {
      const content = fs.readFileSync(bundledPath, 'utf8');
      console.log('[Prerequisites] Read build-info.json from bundled resources');
      return { success: true, data: JSON.parse(content) };
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
  try {
    const buildInfoPath = path.join(projectRoot, 'electron-app', 'build-info.json');
    if (!fs.existsSync(buildInfoPath)) {
      return { success: false, path: buildInfoPath, error: 'installed build-info.json not found' };
    }

    return {
      success: true,
      path: buildInfoPath,
      data: JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
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

/**
 * Fetch latest build number from Cloudsmith for a specific package channel
 * @returns {Promise<{success: boolean, buildNumber?: string, channel?: string, error?: string}>}
 */
async function fetchLatestBuildFromCloudsmith(channelKeyword) {
  const { CLOUDSMITH_OWNER, CLOUDSMITH_REPO, CLOUDSMITH_API_BASE, CLOUDSMITH_API_KEY, CLOUDSMITH_ENTITLEMENT_TOKEN } = cloudsmithConfig;
  const CS_TOKEN = CLOUDSMITH_API_KEY || CLOUDSMITH_ENTITLEMENT_TOKEN;
  const normalizedChannelKeyword =
    typeof channelKeyword === 'string' && channelKeyword.trim()
      ? channelKeyword.trim()
      : 'portico';
  const escapedChannelKeyword = normalizedChannelKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try {
    console.log(
      `[Prerequisites] Fetching latest build from Cloudsmith channel: ${normalizedChannelKeyword}`,
    );

    const apiUrl = `${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/` +
      `?query=name:${encodeURIComponent(normalizedChannelKeyword)} format:raw&page_size=10&sort=-date`;
    const headers = { 'Accept': 'application/json' };
    if (CS_TOKEN) headers['X-Api-Key'] = CS_TOKEN;

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

    // Filter for zip packages
    const zipPackages = packages.filter(pkg =>
      pkg.filename && pkg.filename.endsWith('.zip')
    );

    if (zipPackages.length === 0) {
      return {
        success: false,
        error: `No binaries found for channel ${normalizedChannelKeyword} in Cloudsmith`,
      };
    }

    // Already sorted by -date from API, but be explicit
    const latest = zipPackages.sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    )[0];

    console.log('[Prerequisites] Latest binary:', latest.filename);

    // Parse build number from filename
    // Format: <channel>-MMDDYYYY-SHA.zip
    const filename = latest.filename;
    const pattern = new RegExp(`${escapedChannelKeyword}-(\\d{8})-([a-f0-9]{8,40})\\.zip$`);
    const match = filename.match(pattern);

    if (!match) {
      return { success: false, error: `Could not parse build number from: ${filename}` };
    }

    const buildNumber = `${match[1]}-${match[2]}`; // MMDDYYYY-SHA
    console.log(`[Prerequisites] Extracted build number: ${buildNumber}`);

    return { success: true, buildNumber, channel: normalizedChannelKeyword };
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
function parseAndEmitMarkers(text, emitToWindow) {
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

    // Error markers
    const errorMatch = line.match(/\[PREREQ:ERROR:(.+)\]/);
    if (errorMatch) {
      emitToWindow('prerequisites-error', { error: errorMatch[1] });
      logPrereq('System', 'ERROR', `Shell error marker: ${errorMatch[1]}`);
      continue;
    }

    // Progress markers
    const progressMatch = line.match(/\[PREREQ:PROGRESS:([^:]+):([^\]]+)\]/);
    if (progressMatch) {
      const [, metric, value] = progressMatch;
      updatePhase1ProgressFromMarker(metric, value);
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
function flushLineBuffer(emitToWindow) {
  if (lineBuffer.trim()) {
    parseAndEmitMarkers(lineBuffer + '\n', emitToWindow);
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

    // Verify script exists
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      const displayPath = scriptPath || phase.script;
      console.error(`[Prerequisites] Script not found: ${displayPath}`);
      return resolve({ success: false, error: `Script not found: ${displayPath}`, retryable: false });
    }

    console.log(`[Prerequisites] Running phase ${phaseNum}: ${scriptPath} ${args.join(' ')}`);
    phaseStepFailures[phaseNum] = false;

    // Enhanced PATH for Homebrew, Docker, etc.
    const enhancedEnv = {
      ...process.env,
      PATH: buildEnhancedPath(process.env.PATH || ''),
      NODE_VERSION_REQUIRED,
      TERM: 'xterm-256color',
      ...envOverrides
    };
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
    let timeoutId = null;
    let resolved = false;

    const doResolve = (result) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      activeProcess = null;
      activePhase = null;
      resolve(result);
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
      addLogLine(text, 'info', emitToWindow);
      parseAndEmitMarkers(text, emitToWindow);
    });

    // Parse stderr too (some markers may appear there)
    child.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      addLogLine(text, 'error', emitToWindow);
      parseAndEmitMarkers(text, emitToWindow);  // Also parse stderr for markers
    });

    // Handle completion
    child.on('close', (code) => {
      flushLineBuffer(emitToWindow);
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
        retryable: !success && !stepFailed  // Auto-retry only for non-step failures
      });
    });

    // Handle spawn error
    child.on('error', (err) => {
      console.error(`[Prerequisites] Phase ${phaseNum} spawn error:`, err.message);
      emitToWindow('prerequisites-error', { phase: phaseNum, error: err.message });
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
async function runPhase1Download(buildNumber, targetWindow = null) {
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
  return runWithRetry(1, args, targetWindow, emitToWindow);
}

/**
 * Phase 2: Install dependencies (Homebrew, jq, Node.js)
 */
async function runPhase2Dependencies(targetWindow = null, onboardingMode = 'power') {
  const emitToWindow = createEmitter(targetWindow);
  const resolvedMode = normalizeOnboardingMode(onboardingMode) || 'power';
  return runWithRetry(2, [], targetWindow, emitToWindow, {
    GUIDED_SETUP_ONBOARDING_MODE: resolvedMode,
    GUIDED_SETUP_SKIP_HOST_DEPS: resolvedMode === 'basic' ? 'true' : 'false'
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
  const buildNumber = buildInfo.success && buildInfo.data && buildInfo.data.buildNumber;
  if (buildNumber && buildNumber !== 'dev-build') {
    return buildNumber;
  }
  return 'latest';
}

function getDockerImagesToPull(options = {}) {
  const projectRoot = bootstrap.PROJECT_ROOT || getSafeProjectRoot();
  return buildDockerImagesToPull({
    projectRoot,
    tag: options.tag || getHarborImageTag(),
    env: buildRuntimePlanningEnv(options.env || process.env, projectRoot),
    composeFilePaths: options.composeFilePaths || null
  });
}

// Docker pull inactivity timeout (reset on any output)
const DOCKER_PULL_INACTIVITY_TIMEOUT = 300000; // 5 minutes no activity (download phase — Harbor/Cloudsmith can be slow to start streaming)
const DOCKER_PULL_EXTRACTION_INACTIVITY_TIMEOUT = 600000; // 10 minutes no activity (extraction phase — large images)
const DOCKER_PULL_TOTAL_TIMEOUT = 900000; // 15 minutes total per image (hard safety net)

// IPC throttle interval
const DOCKER_PULL_IPC_THROTTLE_MS = 200;

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

/**
 * Pull a single Docker image with progress tracking
 * Uses --progress=plain for reliable non-TTY output
 */
function pullSingleImage(imageSpec, emitToWindow, checkCancelled) {
  return new Promise((resolve) => {
    if (checkCancelled()) {
      return resolve({ success: false, error: 'Cancelled', retryable: false });
    }

    const { name, tag, label } = imageSpec;
    const imageFull = `${name}:${tag}`;
    const imageProgress = { layers: {}, digestReceived: false, finalStatus: null };
    const startTime = Date.now();
    let dockerLineBuffer = '';
    let lastEmitTime = 0;
    const prereqLogger = getPrereqLogger();

    // Skip pull if the image already exists locally
    try {
      const inspectResult = require('child_process').spawnSync('docker', ['image', 'inspect', imageFull], { timeout: 10000 });
      if (inspectResult.status === 0) {
        console.log(`[Prerequisites] Image already exists locally, skipping pull: ${imageFull}`);
        if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'complete', 100, null);
        logPrereq('Docker', 'INFO', `Skipped pull (already local): ${imageFull}`);
        emitToWindow('prerequisites-docker-pull', { image: imageFull, label, status: 'complete', percent: 100, eta: null });
        return resolve({ success: true, image: imageFull });
      }
    } catch (_) { /* proceed with pull */ }

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
      env: {
        ...process.env,
        PATH: buildEnhancedPath(process.env.PATH || '')
      }
    });

    let resolved = false;
    let inExtractionPhase = false;
    const doResolve = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(inactivityTimeout);
      clearTimeout(totalTimeout);
      resolve(result);
    };

    // Total per-image timeout (hard safety net)
    const totalTimeout = setTimeout(() => {
      console.warn(`[Prerequisites] Docker pull total timeout for ${imageFull} (${DOCKER_PULL_TOTAL_TIMEOUT / 1000}s)`);
      child.kill('SIGTERM');
      doResolve({ success: false, error: `Total timeout after ${DOCKER_PULL_TOTAL_TIMEOUT / 1000}s`, retryable: true });
    }, DOCKER_PULL_TOTAL_TIMEOUT);

    // Inactivity timeout (reset on any output, longer during extraction)
    const getInactivityMs = () => inExtractionPhase
      ? DOCKER_PULL_EXTRACTION_INACTIVITY_TIMEOUT
      : DOCKER_PULL_INACTIVITY_TIMEOUT;

    let inactivityTimeout = setTimeout(() => {
      console.warn(`[Prerequisites] Docker pull inactivity timeout for ${imageFull}`);
      child.kill('SIGTERM');
      doResolve({ success: false, error: `No activity for ${getInactivityMs() / 1000}s`, retryable: true });
    }, getInactivityMs());

    const resetInactivityTimeout = () => {
      clearTimeout(inactivityTimeout);
      const ms = getInactivityMs();
      inactivityTimeout = setTimeout(() => {
        child.kill('SIGTERM');
        doResolve({ success: false, error: `No activity for ${ms / 1000}s`, retryable: true });
      }, ms);
    };

    const processOutput = (data) => {
      // Check for cancellation
      if (checkCancelled()) {
        child.kill('SIGTERM');
        doResolve({ success: false, error: 'Cancelled', retryable: false });
        return;
      }

      resetInactivityTimeout();

      dockerLineBuffer += data.toString();
      const lines = dockerLineBuffer.split('\n');
      dockerLineBuffer = lines.pop() || '';

      let progressChanged = false;
      for (const line of lines) {
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

        // Detect extraction phase: all layers downloaded (100%) but image not yet complete
        if (percent >= 100 && !inExtractionPhase && !imageProgress.digestReceived) {
          inExtractionPhase = true;
          console.log(`[Prerequisites] ${imageFull}: download complete, entering extraction phase (extended timeout)`);
          resetInactivityTimeout(); // Switch to longer timeout
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

    child.stdout.on('data', processOutput);
    child.stderr.on('data', processOutput);

    child.on('close', (code) => {
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
        doResolve({ success: true, image: imageFull });
      } else {
        emitToWindow('prerequisites-docker-pull', {
          image: imageFull,
          label,
          status: 'failed',
          percent: calculateImageProgress(imageProgress),
          eta: null
        });
        updateSessionDockerImage(imageFull, {
          label,
          status: 'failed',
          percent: calculateImageProgress(imageProgress),
          eta: null
        });
        console.error(`[Prerequisites] Failed to pull: ${imageFull} (exit code ${code})`);
        if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'failed', calculateImageProgress(imageProgress), null);
        logPrereq('Docker', 'ERROR', `Failed to pull ${imageFull}: exit code ${code}`);
        doResolve({ success: false, error: `Exit code ${code}`, image: imageFull, retryable: true });
      }
    });

    child.on('error', (err) => {
      emitToWindow('prerequisites-docker-pull', {
        image: imageFull,
        label,
        status: 'failed',
        percent: 0,
        error: err.message
      });
      updateSessionDockerImage(imageFull, {
        label,
        status: 'failed',
        percent: 0,
        eta: null
      });
      if (prereqLogger) prereqLogger.logDockerPull(imageFull, 'failed', 0, null);
      logPrereq('Docker', 'ERROR', `Docker pull error for ${imageFull}: ${err.message}`);
      doResolve({ success: false, error: err.message, image: imageFull, retryable: true });
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
 * @param {number} options.maxRetries - Max retries per image (default: 2)
 * @returns {Promise<{success: boolean, pulled: string[], failed: string[]}>}
 */
async function pullDockerImagesWithProgress(options = {}) {
  const {
    targetWindow,
    images = getDockerImagesToPull(),
    maxRetries = 2,
    concurrency = 3
  } = options;
  const emitToWindow = createEmitter(targetWindow);

  // Cancellation check using module-level cancelled flag
  const checkCancelled = () => cancelled;

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, images.length || 1));
  console.log(`[Prerequisites] Starting Docker image pulls: ${images.length} images (concurrency=${workerCount})`);
  setSessionDockerPlan(images);

  emitToWindow('prerequisites-docker-pull-start', {
    totalImages: images.length,
    images: images.map(i => ({ name: i.name, tag: i.tag, label: i.label }))
  });

  const pulled = [];
  const failed = [];
  const queue = images.slice();
  let completed = 0;

  const pullWithRetry = async (imageSpec) => {
    const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
    let success = false;
    let attempt = 0;
    let lastResult = null;

    while (attempt <= maxRetries && !success && !checkCancelled()) {
      if (attempt > 0) {
        console.log(`[Prerequisites] Retrying ${imageFull} (attempt ${attempt + 1}/${maxRetries + 1})`);
        emitToWindow('prerequisites-docker-pull', {
          image: imageFull,
          label: imageSpec.label,
          status: 'retrying',
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1
        });
        updateSessionDockerImage(imageFull, {
          label: imageSpec.label,
          status: 'retrying'
        });
        await new Promise(r => setTimeout(r, 2000 * attempt));
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

  const runWorker = async () => {
    while (queue.length > 0 && !checkCancelled()) {
      const imageSpec = queue.shift();
      if (!imageSpec) break;

      const imageFull = `${imageSpec.name}:${imageSpec.tag}`;
      const result = await pullWithRetry(imageSpec);

      if (result.success) {
        pulled.push(imageFull);
      } else {
        failed.push(imageFull);
        // Immediately flip to deferred so UI shows amber "will build locally"
        // instead of staying red/0% until the entire batch completes.
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

      completed += 1;
      emitToWindow('prerequisites-docker-pull-progress', {
        completed,
        total: images.length,
        pulled: pulled.length,
        failed: failed.length
      });
    }
  };

  const workers = Array.from({ length: workerCount }, () => runWorker());

  await Promise.all(workers);

  if (checkCancelled()) {
    console.log('[Prerequisites] Docker pulls cancelled');
  }

  const overallSuccess = failed.length === 0 && !checkCancelled();

  emitToWindow('prerequisites-docker-pull-complete', {
    success: overallSuccess,
    pulled,
    failed,
    cancelled: checkCancelled()
  });
  finalizeSessionDockerPlan({ success: overallSuccess });

  console.log(`[Prerequisites] Docker pulls complete. Pulled: ${pulled.length}, Failed: ${failed.length}`);

  return { success: overallSuccess, pulled, failed };
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

  const prereqLogger = getPrereqLogger();
  if (prereqLogger) prereqLogger.logPhaseStart(2, PHASES[2].label);
  const phase2Start = Date.now();
  const result = await runPhase2Dependencies(targetWindow || prerequisitesSession.targetWindow, getEffectiveSessionMode());
  prerequisitesSession.phaseResults.phase2 = result;
  if (prereqLogger) prereqLogger.logPhaseComplete(2, result.success, Date.now() - phase2Start);

  if (!result.success) {
    markSessionFailure(result.error, 2);
    logPrereq('Dependencies', 'ERROR', `Phase 2 failed: ${result.error}`);
    emitToWindow('prerequisites-complete', {
      success: false,
      failedPhase: 2,
      error: result.error,
      results: buildCurrentResultsSnapshot()
    });
    return result;
  }

  updateDerivedSessionState();
  emitToWindow('prerequisites-blocking-ready', {
    success: true,
    onboardingMode: prerequisitesSession.mode,
    results: buildCurrentResultsSnapshot()
  });
  return result;
}

async function runBackgroundContinuation(options = {}) {
  const { targetWindow = null } = options;
  const emitToWindow = createSessionEmitter(targetWindow);

  if (backgroundContinuationPromise) {
    return backgroundContinuationPromise;
  }

  backgroundContinuationPromise = (async () => {
    prerequisitesSession.currentSequence = 'background';
    prerequisitesSession.lastError = null;
    prerequisitesSession.failedPhase = null;
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
          results: buildCurrentResultsSnapshot()
        });
        return { success: false, failedPhase: 3, error: results.phase3.error, results: buildCurrentResultsSnapshot() };
      }
    }

    if (cancelled) {
      markSessionCancelled();
      return { success: false, error: 'Cancelled', results: buildCurrentResultsSnapshot() };
    }

    if (!results.dockerPull?.success) {
      const dockerImages = getDockerImagesToPull();
      console.log('[Prerequisites] Pulling Docker images with progress');
      logPrereq('Docker', 'INFO', `Starting Docker image pulls (${dockerImages.length} images)`);
      emitToWindow('prerequisites-phase-start', { phase: 3, label: 'Pulling Docker images...' });
      results.dockerPull = await pullDockerImagesWithProgress({
        targetWindow: targetWindow || prerequisitesSession.targetWindow,
        images: dockerImages
      });
      if (!results.dockerPull.success) {
        const failed = results.dockerPull.failed || [];
        const withLocal = [];
        const withoutLocal = [];
        for (const failedRef of failed) {
          const localRef = harborToLocalImageRef(failedRef);
          if (localRef && checkLocalDockerImageExists(localRef)) {
            withLocal.push(`${failedRef} → local ${localRef}`);
          } else {
            withoutLocal.push(failedRef);
          }
        }
        if (withLocal.length > 0) {
          console.log('[Prerequisites] Harbor pull failed but local images available:', withLocal);
          logPrereq('Docker', 'INFO', `Local image fallbacks: ${withLocal.join(', ')}`);
        }
        if (withoutLocal.length > 0) {
          console.warn('[Prerequisites] Harbor pull failed, no local image yet (install will build):', withoutLocal);
          logPrereq('Docker', 'WARN', `Harbor images unavailable, will be built during install: ${withoutLocal.join(', ')}`);
        }
        results.dockerPull.success = true;
        results.dockerPull.localFallbacks = withLocal;
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
    updateDerivedSessionState();
    emitToWindow('prerequisites-complete', {
      success: overallSuccess,
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
  ensurePrerequisitesSession({ buildNumber, targetWindow, onboardingMode, preserveLogs: true });
  emitPrerequisitesStartIfNeeded(targetWindow);

  if (prerequisitesSession.phaseResults.phase1?.success && prerequisitesSession.phaseResults.phase2?.success) {
    updateDerivedSessionState();
    if (prerequisitesSession.currentSequence !== 'complete') {
      void runBackgroundContinuation({ targetWindow });
    }
    return { success: true, started: false, blockingReady: true, status: buildDetailedStatus() };
  }

  const installedReadiness = await getInstalledPrereqReadiness();
  if (installedReadiness.skip && (onboardingMode === 'basic' || installedReadiness.hostModeEnabled)) {
    markSessionReadyFromInstalledState({
      onboardingMode,
      hostModeEnabled: installedReadiness.hostModeEnabled
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
  if (prefetchPromise || interactiveContinuationPromise || backgroundContinuationPromise) {
    markSessionCancelled();
  }

  if (activeProcess) {
    console.log('[Prerequisites] Killing active process group');
    killProcessGroup(activeProcess);
    activeProcess = null;
  }
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
    const installedReadiness = await getInstalledPrereqReadiness();
    if (installedReadiness.skip) {
      return buildReadinessPayload({
        requiredSpecs,
        blockingInstallStillRunning: false,
        errorMessage: 'Oops, something went wrong. Please navigate to the prereqs step.'
      });
    }
    return buildBlockedReadiness(requiredSpecs, 'Oops, something went wrong. Please navigate to the prereqs step.');
  }
  return buildReadinessPayload({
    requiredSpecs,
    blockingInstallStillRunning: waiting,
    errorMessage: 'Oops, something went wrong. Please navigate to the prereqs step.'
  });
}

async function checkFinalizeReadiness(options = {}) {
  const requiredSpecs = getDockerImagesToPull();
  const waiting = Boolean(backgroundContinuationPromise || isRunning);
  if (!prerequisitesSession.blockingReady && !waiting) {
    const installedReadiness = await getInstalledPrereqReadiness();
    if (!installedReadiness.skip) {
      return buildBlockedReadiness(requiredSpecs, 'Oops, something went wrong. Please navigate to the prereqs step.');
    }

    const installedPayload = buildReadinessPayload({
      requiredSpecs,
      blockingInstallStillRunning: false,
      errorMessage: 'Oops, something went wrong. Please navigate to the prereqs step.'
    });

    if (installedPayload.ready) {
      const generatorReadiness = getFinalizeGeneratorReadiness();
      if (!generatorReadiness.ready) {
        return {
          ...installedPayload,
          ready: false,
          waiting: false,
          error: generatorReadiness.error
        };
      }
    }

    const requiresHost = options.mode === 'power' && options.hasHostSelections === true;
    if (installedPayload.ready && requiresHost && !installedReadiness.hostModeEnabled) {
      return {
        ...installedPayload,
        ready: false,
        waiting: false,
        error: 'Oops, something went wrong. Please navigate to the prereqs step.'
      };
    }

    return installedPayload;
  }
  const payload = buildReadinessPayload({
    requiredSpecs,
    blockingInstallStillRunning: waiting,
    errorMessage: 'Oops, something went wrong. Please navigate to the prereqs step.'
  });

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

  const requiresHost = options.mode === 'power' && options.hasHostSelections === true;
  if (payload.ready && requiresHost) {
    const hostReady =
      prerequisitesSession.phaseResults.phase4?.success === true &&
      prerequisitesSession.phaseResults.phase4?.skipped !== true;
    if (!hostReady) {
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
        error: 'Oops, something went wrong. Please navigate to the prereqs step.'
      };
    }
  }

  return payload;
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
  const projectRoot = options.projectRoot || getSafeProjectRoot();
  const setupStatus = evaluateSetupRequirementStatus({
    projectRoot,
    userDataPath: options.userDataPath,
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

  const requiredSpecs = buildAuthorizeRequiredImageSpecs();
  const imageState = calculateRequiredImageProgress(requiredSpecs);
  if (imageState.readyCount !== imageState.total) {
    return {
      skip: false,
      reason: 'authorize-images-missing',
      setupStatus,
      buildMatch,
      missingImages: imageState.missing
    };
  }

  return {
    skip: true,
    reason: 'installed-build-ready',
    setupStatus,
    buildMatch,
    readyImages: imageState.readyImages
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  readBundledBuildInfo,
  runPhase1Download,
  runPhase2Dependencies,
  runPhase3DockerSetup,
  runPhase4HostMode,
  getDockerImagesToPull,
  pullDockerImagesWithProgress,
  prerequisitesStartBackgroundPrefetch,
  prerequisitesResumeInteractive,
  runAllPrerequisites,
  cancelPrerequisites,
  resetPrerequisitesCancellation,
  getPrerequisitesStatus,
  getPrerequisitesDetailedStatus,
  checkAuthorizeReadiness,
  checkFinalizeReadiness,
  shouldSkipPrerequisites
};
