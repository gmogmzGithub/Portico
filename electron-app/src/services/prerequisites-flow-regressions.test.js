const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function assertContainsInOrder(source, snippets) {
  let cursor = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor);
    assert.notEqual(index, -1, `expected to find snippet: ${snippet}`);
    cursor = index + snippet.length;
  }
}

test("guided setup starts background prereq prefetch without forcing an onboarding mode", () => {
  const source = readRepoFile("electron-app/src/renderer/views/guided-setup.js");

  assert.match(source, /window\.electronAPI\.prerequisitesStartBackgroundPrefetch\(\)/);
  assert.doesNotMatch(source, /prerequisitesStartBackgroundPrefetch\(\{\s*onboardingMode:/);
});

test("prereqs screen auto-advances only after authorize readiness is satisfied", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );

  assert.match(source, /window\.electronAPI\?\.prerequisitesCheckAuthorizeReadiness/);
  assert.match(source, /state\.authorizeReadiness\.ready/);
  assert.match(source, /_callbacks\?\.advanceAfterPrerequisites/);
});

test("prereqs screen treats completed installs as authorize-ready and advances immediately", () => {
  const source = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );

  assert.match(
    source,
    /state\.backgroundReady \|\| state\.fullInstallComplete \|\| state\.isComplete \|\| status\.currentSequence === 'complete'/,
  );
  assert.match(source, /markAuthorizeReady\(\{\s*progressPercent:\s*100\s*\}\)/);
  assert.match(source, /maybeAutoAdvanceAfterAuthorizeReady\(\)/);
});

test("prereqs spotlight uses artwork and helper copy instead of noisy technical text", () => {
  const html = readRepoFile("electron-app/src/renderer/views/guided-setup.html");
  const renderer = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );

  assert.match(html, /id="prerequisites-spotlight-visual"/);
  assert.match(html, /id="prerequisites-spotlight-helper"/);
  assert.doesNotMatch(html, /id="prerequisites-spotlight-title"/);
  assert.match(renderer, /renderDownloadArt\(\)/);
  assert.match(renderer, /renderPasswordArt\(\)/);
  assert.match(renderer, /renderDockerArt\(\)/);
  assert.match(renderer, /state\.currentPhase === 2 && state\.activeStep === 'command_line_tools'/);
  assert.match(renderer, /Approve the Apple Command Line Developer Tools \/ Software Update window\./);
  assert.match(renderer, /We're downloading all necessary software\./);
});

test("prereqs subtitle keeps progress percentages out of the descriptive status line", () => {
  const renderer = readRepoFile(
    "electron-app/src/renderer/screens/guided-setup/screen-prerequisites.js",
  );

  assert.doesNotMatch(
    renderer,
    /Downloading update payload\.\.\.'\}\s*\$\{phase1Percent\}/,
  );
  assert.doesNotMatch(
    renderer,
    /Downloading core runtime containers\.\.\.\s*\$\{dockerPercent\}/,
  );
  assert.match(renderer, /return state\.phase1Progress\.activity \|\| 'Downloading update payload\.\.\.';/);
  assert.match(renderer, /return 'Downloading core runtime containers\.\.\.';/);
});

test("phase 1 prerequisite download emits structured progress markers", () => {
  const shellSource = readRepoFile("src/scripts/prereq-download.sh");

  assert.match(shellSource, /emit_progress "phase1_step" "download"/);
  assert.match(shellSource, /emit_progress "download_total_bytes" "\$TOTAL_BYTES"/);
  assert.match(shellSource, /emit_progress "download_bytes" "\$current_bytes"/);
  assert.match(shellSource, /emit_progress "download_percent" "\$current_percent"/);
  assert.match(shellSource, /payload_cache_emit_complete_progress "\$payload_file" "\$total_bytes"/);
});

test("phase 1 prerequisite payload cache is outside managed runtime and hides raw URLs", () => {
  const shellSource = readRepoFile("src/scripts/prereq-download.sh");

  assert.match(
    shellSource,
    /PREREQ_PAYLOAD_CACHE_DIR="\$\{PREREQ_PAYLOAD_CACHE_DIR:-\$HOME\/Library\/Caches\/portico\/prereq-payloads\}"/,
  );
  assert.doesNotMatch(shellSource, /PREREQ_PAYLOAD_CACHE_DIR=.*MANAGED_DIR/);
  assert.match(shellSource, /payload_cache_try_reuse "\$\{TOTAL_BYTES:-0\}"/);
  assert.match(shellSource, /payload_cache_promote_download "\$DOWNLOAD_FILE" "\$\{TOTAL_BYTES:-0\}"/);
  assert.match(shellSource, /printf 'url_hash\\t%s\\n' "\$url_hash"/);
  assert.doesNotMatch(shellSource, /printf 'download_url\\t/);
});

test("local dev builds skip Cloudsmith prerequisite payload downloads", () => {
  const source = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(source, /resolvedTarget\.localOnly/);
  assert.match(source, /Local dev build detected; skipping Cloudsmith payload download\./);
  assert.match(source, /success:\s*true,\s*[\s\S]*skipped:\s*true,\s*[\s\S]*localOnly:\s*true/s);
});

test("docker prereqs only reuse architecture-compatible images and surface wrong-arch fallbacks", () => {
  const source = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(source, /const readyRef = resolveReadyImageForSpec\(imageSpec\);/);
  assert.match(source, /const incompatibleLocalImages = inspectRequiredImageSpec\(imageSpec\)\.wrongArchitectureImages;/);
  assert.match(source, /Architecture mismatch detected; repulling \$\{imageFull\}: \$\{mismatchSummary\}/);
  assert.match(source, /if \(localRef && isDockerImageReady\(localRef\)\)/);
});

test("finalize readiness uses the selected-server image plan instead of the full prereq list", () => {
  const source = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(source, /function getFinalizeRequiredImageSpecs\(options = \{\}\)/);
  assert.match(source, /getOptionalServerImageSpecs\(options\.selectedServerIds\)/);
  assert.match(source, /const requiredSpecs = getFinalizeRequiredImageSpecs\(options\);/);
  assert.doesNotMatch(source, /const requiredSpecs = getDockerImagesToPull\(\);/);
});

test("guided setup removes Rust from prerequisite installation entirely", () => {
  const serviceSource = readRepoFile("electron-app/src/services/prerequisites-service.js");
  const shellSource = readRepoFile("src/scripts/prereq-dependencies.sh");

  assert.doesNotMatch(serviceSource, /GUIDED_SETUP_SKIP_RUST_INSTALL/);
  assert.doesNotMatch(shellSource, /install_rust\(/);
  assert.doesNotMatch(shellSource, /emit_step_start "rust"/);
  assert.doesNotMatch(shellSource, /Skipping Rust installation/);
});

test("guided setup status exposes the active dependency step to the renderer", () => {
  const serviceSource = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(serviceSource, /activeStep:\s*null,/);
  assert.match(serviceSource, /activeStep:\s*prerequisitesSession\.activeStep,/);
  assert.match(serviceSource, /prerequisitesSession\.activeStep = stepName;/);
});

test("guided setup uv install checks ~/.local/bin first and uses unmanaged installer mode", () => {
  const shellSource = readRepoFile("src/scripts/prereq-dependencies.sh");

  assertContainsInOrder(shellSource, [
    'export PATH="$HOME/.local/bin:${PATH:-}"',
    "if command_exists uvx; then",
  ]);
  assert.match(
    shellSource,
    /curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| env UV_UNMANAGED_INSTALL="\$HOME\/\.local\/bin" sh/,
  );
});

test("guided setup and loading shimmers use smooth alternate motion instead of reset sweeps", () => {
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.html");
  const guidedSetupCss = readRepoFile("electron-app/src/renderer/views/guided-setup.css");

  assert.match(loadingSource, /animation:\s*status-shimmer\s+4s\s+ease-in-out\s+infinite\s+alternate/);
  assert.match(loadingSource, /@keyframes status-shimmer\s*\{\s*from\s*\{\s*background-position:\s*0%\s*50%;\s*\}\s*to\s*\{\s*background-position:\s*100%\s*50%;\s*\}\s*\}/s);
  assert.match(guidedSetupCss, /animation:\s*prereq-status-shimmer\s+4s\s+ease-in-out\s+infinite\s+alternate/);
  assert.match(guidedSetupCss, /animation:\s*prereq-progress-shimmer\s+1\.8s\s+ease-in-out\s+infinite\s+alternate/);
  assert.match(guidedSetupCss, /@keyframes prereq-progress-shimmer\s*\{\s*from\s*\{\s*background-position:\s*0%\s*50%;\s*\}\s*to\s*\{\s*background-position:\s*100%\s*50%;\s*\}\s*\}/s);
});

test("loading screen matches guided setup chrome and drawer header copy", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(
    loadingHtml,
    /<div class="titlebar-actions">\s*<button class="theme-toggle" id="theme-toggle"[\s\S]*?<button[\s\S]*?id="toggle-logs-btn"/,
  );
  assert.match(loadingHtml, /<span class="log-title">Init Logs<\/span>/);
  assert.match(loadingHtml, />\s*Copy Logs\s*<\/button>/);
  assert.doesNotMatch(loadingHtml, /Initialization Logs/);
  assert.doesNotMatch(loadingJs, /logTitle\.textContent = 'Update Logs';/);
});

test("loading screen shows the login task before startup verification tasks", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");

  const authTaskIndex = loadingHtml.indexOf('id="task-auth"');
  const verifyTaskIndex = loadingHtml.indexOf('id="task-verify"');

  assert.notEqual(authTaskIndex, -1);
  assert.notEqual(verifyTaskIndex, -1);
  assert.ok(authTaskIndex < verifyTaskIndex);
  assert.match(loadingHtml, />\s*Signing into Portico\s*</);
});

test("loading window keeps the update check ahead of the login gate on relaunch", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");

  assert.match(
    windowsSource,
    /const updateInfo = await deps\.checkForUpdates\(\);[\s\S]*safeWebContentsSend\(state\.windows\.loading, 'proceed-with-initialization'/,
  );
  assert.doesNotMatch(
    windowsSource,
    /current-user|ensureAuthenticated|setup-auth-start|setupAuth/i,
  );
});

test("loading startup waits for auth after the update path resolves and stops services on auth failure", () => {
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(
    loadingJs,
    /window\.electronAPI\.onProceedWithInitialization\(async \(\) => \{[\s\S]*const authenticated = await runCurrentUserAuthGate\(\{ source: 'post-update-check' }\);[\s\S]*await continueAfterAuthentication\(\);/s,
  );
  assert.match(loadingJs, /run: \(\) => window\.electronAPI\?\.stopHostMcpo\?\.\(\),/);
  assert.match(loadingJs, /run: \(\) => window\.electronAPI\?\.dockerStop\?\.\(\),/);
  assert.match(
    loadingJs,
    /document\.getElementById\('control-plane-btn'\)\.addEventListener\('click', \(\) => \{[\s\S]*if \(authFailureActive\) \{[\s\S]*Startup is blocked until login succeeds\./s,
  );
  assert.match(
    loadingJs,
    /document\.getElementById\('retry-btn'\)\.addEventListener\('click', \(\) => \{[\s\S]*if \(authFailureActive\) \{[\s\S]*const authenticated = await runCurrentUserAuthGate\(\{ source: 'retry' }\);/s,
  );
});

test("identity repair uses cached identity first and opens login-only guided setup when needed", () => {
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");
  const guidedSetupJs = readRepoFile("electron-app/src/renderer/views/guided-setup.js");

  assert.match(loadingJs, /let result = typeof authApi\.get === 'function'[\s\S]*await authApi\.get\(\)/);
  assert.match(loadingJs, /setupDecision\?\.action === 'identity_login'/);
  assert.match(loadingJs, /setupMode: 'identity_repair'/);
  assert.match(guidedSetupJs, /setupState\.launchContext\?\.setupMode === 'identity_repair'[\s\S]*await showStage\('welcome'\);[\s\S]*return;/);
  assert.match(guidedSetupJs, /decision\.action === 'reconcile_identity' \|\| decision\.action === 'identity_login'/);
  assert.match(guidedSetupJs, /window\.electronAPI\.electronAppComplete\(\);/);
  assert.doesNotMatch(loadingJs, /Signed in as|preferredUsername|sessionSummary\)\}\n/);
  assert.match(loadingJs, /addLogWithPersist\('✅ Signed in\\n', 'success'\)/);
});

test("loading window can execute menu-triggered reinstall auto-installs when no control plane window exists", () => {
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(loadingJs, /window\.electronAPI\.onMenuUpdateRequested\(async \(payload\) => \{/);
  assert.match(loadingJs, /payload\?\.postPreparationAction !== 'auto-install'/);
  assert.match(loadingJs, /launchUpdateGate\.active = true;/);
  assert.match(loadingJs, /Preparing requested install from the app menu/);
  assert.match(loadingJs, /await startLaunchUpdatePreparation\(updateInfo\);/);
});

test("loading logs auto-scroll until the user manually scrolls away", () => {
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(loadingJs, /let logAutoscrollEnabled = true;/);
  assert.match(loadingJs, /if \(logsDrawerOpen && logAutoscrollEnabled\)\s*\{\s*scrollLogContentToBottom\(\);/);
  assert.match(loadingJs, /if \(logAutoscrollEnabled\)\s*\{\s*scrollLogContentToBottom\(\);/);
  assert.match(loadingJs, /logContent\.addEventListener\('scroll', \(\) => \{/);
  assert.match(loadingJs, /logAutoscrollEnabled = isLogContentScrolledToBottom\(logContent\);/);
});

test("loading recovery debug action collects a local bundle without the report modal", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

	assert.match(loadingHtml, />\s*Collect Debug Info\s*</);
	assert.doesNotMatch(loadingHtml, /id="bug-report-modal-overlay"/);
	assert.doesNotMatch(loadingHtml, />\s*Send Report\s*</);
  assert.match(loadingJs, /document\.getElementById\('debug-btn'\)\.addEventListener\('click', async \(\) => \{/);
  assert.match(loadingJs, /window\.electronAPI\.saveInitLogs\(initLogs\)/);
  assert.match(loadingJs, /window\.electronAPI\.collectDebugInfo\(\)/);
  assert.doesNotMatch(loadingJs, /showBugReportModal/);
  assert.doesNotMatch(loadingJs, /window\.electronAPI\.uploadDebugLogs\(/);
});

test("loading startup name conflicts show copyable stale-container recovery", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  // PORTICO-236: the startup failure classifier (and its recovery commands) moved
  // to a dedicated unit-testable module that main.js consumes.
  const classifierSource = readRepoFile(
    "electron-app/src/services/startup-failure-classifier.js",
  );
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(mainSource, /require\("\.\/startup-failure-classifier"\)/);
  assert.match(classifierSource, /STARTUP_STALE_CONTAINER_RECOVERY_COMMAND/);
  assert.match(classifierSource, /container name/);
  assert.match(classifierSource, /already in use/);
  assert.match(classifierSource, /type: "docker-start-failure"/);
  assert.match(mainSource, /buildLoadingErrorPayload\(startupFailure\.uiMessage, startupFailure\.recovery\)/);
  assert.match(classifierSource, /docker rm -f mcpo-sourcegraph nifty_brown/);
  assert.match(classifierSource, /label=com\.docker\.compose\.project=portico/);

  assert.match(loadingHtml, /id="manual-recovery-panel"/);
  assert.match(loadingHtml, /id="manual-recovery-command"/);
  assert.match(loadingHtml, /id="copy-recovery-command-btn"/);

  assert.match(loadingJs, /function normalizeLoadingErrorPayload\(payload\)/);
  assert.match(loadingJs, /const \{ message, recovery \} = normalizeLoadingErrorPayload\(payload\);/);
  assert.match(loadingJs, /showManualRecovery\(recovery\)/);
  assert.match(loadingJs, /window\.electronAPI\.copyToClipboard\(currentRecoveryCommand\)/);
  assert.match(loadingJs, /clearManualRecovery\(\);[\s\S]*recoveryButtons\.classList\.remove\('visible'\);/);
});

test("required update captions stay on the shimmering loading caption path", () => {
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");
  const loadingJs = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.doesNotMatch(
    loadingHtml,
    /body\.update-mode\s+\.current-step-caption\s*\{\s*display:\s*none;/,
  );
  assert.doesNotMatch(
    loadingHtml,
    /body\.update-mode\s+\.task-list\s*\{\s*display:\s*block;/,
  );
  assert.match(loadingJs, /updateCurrentStepCaption\(null, message \|\| 'Preparing startup\.\.\.'\);/);
});

test("skip-prerequisites IPC delegates to the install-state readiness helper", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  assert.match(ipcSource, /prerequisitesService\.shouldSkipPrerequisites\(/);
  assert.doesNotMatch(ipcSource, /normalizedManagedRoot/);
  assert.doesNotMatch(ipcSource, /startsWith\(normalizedManagedRoot\)/);
});

test("guided setup bootstrap IPC exposes launch context, prereq readiness, and saved onboarding mode", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const preloadSource = readRepoFile("electron-app/src/services/preload.js");

  assert.match(ipcSource, /ipcMain\.handle\("get-guided-setup-bootstrap-state"/);
  assert.match(ipcSource, /state\.guidedSetupLaunchContext\.source/);
  assert.match(ipcSource, /prereqReadiness:\s*\{\s*readyForAuth:/s);
  assert.match(ipcSource, /savedOnboardingMode:\s*preferencesResult\.data\.onboardingMode/);
  assert.match(ipcSource, /ipcMain\.handle\("save-guided-setup-mode-preference"/);
  assert.match(preloadSource, /getGuidedSetupBootstrapState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-guided-setup-bootstrap-state'\)/);
  assert.match(preloadSource, /saveGuidedSetupModePreference:\s*\(mode\)\s*=>\s*ipcRenderer\.invoke\('save-guided-setup-mode-preference',\s*mode\)/);
});

test("guided setup launches are tagged with explicit manual and required contexts", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(ipcSource, /source:\s*"manual",\s*trigger:\s*"control-plane"/s);
  assert.match(ipcSource, /source:\s*"required",\s*trigger:\s*"init-failure"/s);
  assert.doesNotMatch(windowsSource, /trigger:\s*'startup'/);
  assert.match(loadingSource, /onSetupWizardNeeded\(async \(\) => \{[\s\S]*runCurrentUserAuthGate[\s\S]*continueAfterAuthentication/s);
  assert.match(loadingSource, /launchGuidedSetupFromInit\(\{[\s\S]*setupMode: setupDecision\.setupMode/);
});

test("startup updates bundled runtime mismatches before Docker initialization and hard-blocks on failure", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(
    mainSource,
    /prerequisitesService\.doesInstalledBuildMatchBundledBuild\(\s*PROJECT_ROOT,/s,
  );
  assert.match(mainSource, /bundled-build-mismatch detected/);
  assert.match(mainSource, /updateInstalledRuntimeToBundledBuild\(\{/);
  // PORTICO-323: the mismatch-failure banner still carries the generic fallback,
  // but now routes through the OrbStack-missing classifier so an absent Docker
  // runtime gets an actionable "install OrbStack" message instead.
  assert.match(
    mainSource,
    /"Portico could not update the managed runtime to match this app build\./,
  );
  assertContainsInOrder(mainSource, [
    'loading-error",',
    "orbstackAvailability.actionableUpdateFailureMessage(",
    "Portico could not update the managed runtime to match this app build.",
  ]);
  assertContainsInOrder(mainSource, [
    "Checking installed runtime build...",
    "updateInstalledRuntimeToBundledBuild({",
    "const dockerReady = await ensureDockerRunning();",
  ]);
});

test("runtime update prefers prepared artifacts before falling back to an exact-build phase 1 download", () => {
  const serviceSource = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(serviceSource, /getPreparedRuntimeRepairCandidate\(/);
  assert.match(serviceSource, /Applying prepared runtime artifacts/);
  assert.match(serviceSource, /Prepared runtime update did not complete successfully; falling back to exact-build download/);
  assert.match(serviceSource, /await runPhase1Download\(bundledIdentity\.buildNumber,\s*targetWindow\)/);
  assert.match(
    serviceSource,
    /preparedResult\.success && preparedMatch\.matches[\s\S]*secureCloudsmithBootstrapAfterManagedRuntimeUpdate\(\{[\s\S]*managedRoot: projectRoot/,
  );
  assertContainsInOrder(serviceSource, [
    "const result = await runWithRetry(1, args, targetWindow, emitToWindow);",
    "secureCloudsmithBootstrapAfterManagedRuntimeUpdate(",
    "return result;",
  ]);
});

test("normal managed runtime updates never use repair wording in user-visible messages", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const integritySource = readRepoFile("src/scripts/managed-runtime-integrity.sh");
  const start = mainSource.indexOf("// Ensure the mutable managed runtime tree matches");
  const end = mainSource.indexOf("// Complete the one-way legacy OAuth upgrade", start);
  const updateBlock = mainSource.slice(start, end);
  const imagePullStart = integritySource.indexOf("managed_runtime_pull_missing_harbor_images()");
  const imagePullEnd = integritySource.indexOf("managed_runtime_self_heal_packaged_runtime()", imagePullStart);
  const imagePullBlock = integritySource.slice(imagePullStart, imagePullEnd);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.notEqual(imagePullStart, -1);
  assert.notEqual(imagePullEnd, -1);
  assert.match(updateBlock, /Updating the managed runtime to match this app build/);
  assert.match(updateBlock, /Managed runtime updated using/);
  assert.match(imagePullBlock, /missing Harbor image\(s\) for packaged runtime update/);
  assert.doesNotMatch(updateBlock, /["'`]([^"'`]|\\.)*repair/i);
  assert.doesNotMatch(imagePullBlock, /["'`]([^"'`]|\\.)*repair/i);
});

test("exact managed runtime downloads bypass the package discovery API", () => {
  const source = readRepoFile("src/scripts/prereq-download.sh");
  const start = source.indexOf('emit_step_start "cloudsmith-lookup"');
  const end = source.indexOf('emit_step_start "prepare-directory"', start);
  const exactBuildBlock = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(
    exactBuildBlock,
    /build_cloudsmith_download_url "\$KEYWORD" "\$BUILD_NUMBER" "\$EXPECTED_FILENAME" ""/,
  );
  assert.doesNotMatch(exactBuildBlock, /Cloudsmith API lookup|API_URL|find_cloudsmith_package_metadata/);
});

test("local dev builds skip the managed runtime update gate instead of hard-blocking startup", () => {
  const serviceSource = readRepoFile("electron-app/src/services/prerequisites-service.js");
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(serviceSource, /resolvePrerequisitesDownloadTarget\(\{\s*buildNumber:\s*bundledIdentity\.buildNumber,/s);
  assert.match(serviceSource, /resolvedUpdateTarget\.success && resolvedUpdateTarget\.localOnly/);
  assert.match(serviceSource, /source:\s*'local-dev-build'/);

  assert.match(mainSource, /const isLocalDevBuild = buildInfo\.buildNumber === "dev-build";/);
  assert.match(mainSource, /if \(app\.isPackaged && !isLocalDevBuild && !runtimeBuildMatch\.matches\)/);
  assert.match(mainSource, /Managed runtime update is not required for packaged local dev-build startup/);
  assert.match(mainSource, /Managed runtime update is not required for unpackaged development startup/);
});
