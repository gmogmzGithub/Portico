const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("exact-build runtime reconciliation never fabricates app install state", () => {
  const shellSource = readRepoFile("src/scripts/prereq-download.sh");
  const lookupStart = shellSource.indexOf('emit_step_start "cloudsmith-lookup"');
  const lookupEnd = shellSource.indexOf(
    'emit_step_start "prepare-directory"',
    lookupStart,
  );
  const exactBuildLookup = shellSource.slice(lookupStart, lookupEnd);

  assert.match(shellSource, /BUILD_LAST_MODIFIED=""/);
  assert.doesNotMatch(exactBuildLookup, /BUILD_LAST_MODIFIED=/);
  assert.match(shellSource, /if \[ -n "\$BUILD_LAST_MODIFIED" \]; then/);
  assert.match(
    shellSource,
    /LAST_INSTALLED_BUILD_FILE="\$HOME\/Library\/Application Support\/portico\/LAST_INSTALLED_BUILD"/,
  );
  assert.match(shellSource, /"schemaVersion": 1/);
  assert.match(shellSource, /"buildNumber": "%s"/);
  assert.match(shellSource, /"timestamp": "%s"/);
  assert.match(shellSource, /"\$BUILD_NUMBER" "\$BUILD_LAST_MODIFIED"/);
  assert.match(shellSource, /mv -f "\$LAST_INSTALLED_BUILD_TEMP" "\$LAST_INSTALLED_BUILD_FILE"/);
});

test("update install state is never persisted before installation succeeds", () => {
  const updatesSource = readRepoFile("electron-app/src/services/updates.js");
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const applySource = readRepoFile("electron-app/src/scripts/apply-prepared-update.sh");
  const appInstallerSource = readRepoFile("electron-app/src/scripts/install-staged-app.sh");
  const bootstrapSource = readRepoFile("bootstrap.sh");

  assert.doesNotMatch(
    updatesSource,
    /Saved timestamp on update confirmation|saveLastInstalledTimestamp\(updateInfo\.lastModified\)/,
  );
  assert.doesNotMatch(
    mainSource,
    /Saved timestamp on update confirmation|Saved timestamp on direct main-window update start/,
  );
  assert.match(
    mainSource,
    /forceLegacyUpdate &&[\s\S]*code === 0 &&[\s\S]*saveLastInstalledBuildState\(/,
  );
  assert.doesNotMatch(applySource, /LAST_INSTALLED_BUILD/);
  assert.match(appInstallerSource, /persist_installed_build_state\(\)/);
  assert.match(appInstallerSource, /derive_installed_build_metadata\(\)/);
  assert.match(appInstallerSource, /find_stage_manifest\(\)/);
  assert.match(appInstallerSource, /read_json_field "\$stage_manifest" "lastModified"/);
  assert.match(appInstallerSource, /read_json_field "\$build_info_path" "buildNumber"/);
  assert.match(
    appInstallerSource,
    /mv "\$TMP_APP_BUNDLE" "\$TARGET_APP_BUNDLE"[\s\S]*persist_installed_build_state/,
  );
  assert.doesNotMatch(appInstallerSource, /printf "%s" "\$INSTALLED_BUILD_TIMESTAMP"/);
  assert.match(
    bootstrapSource,
    /if bash install_v2\.sh "\$\{INSTALL_ARGS\[@\]\}"; then[\s\S]*"\$BUILD_NUMBER" "\$BUILD_LAST_MODIFIED"[\s\S]*LAST_INSTALLED_BUILD/,
  );
});

test("staged app installer serializes promotion and force-exits stuck parents", () => {
  const appInstallerSource = readRepoFile("electron-app/src/scripts/install-staged-app.sh");

  assert.match(appInstallerSource, /LOCK_DIR="\$HOME\/Library\/Application Support\/portico\/update-app-install\.lock"/);
  assert.match(appInstallerSource, /acquire_install_lock\(\)/);
  assert.match(appInstallerSource, /Another staged app install is already active/);
  assert.match(appInstallerSource, /trap 'release_install_lock' EXIT/);
  assert.match(appInstallerSource, /ensure_parent_exited\(\)/);
  assert.match(appInstallerSource, /sending TERM/);
  assert.match(appInstallerSource, /kill -TERM "\$PARENT_PID"/);
  assert.match(appInstallerSource, /sending KILL/);
  assert.match(appInstallerSource, /kill -KILL "\$PARENT_PID"/);
  assert.doesNotMatch(appInstallerSource, /seq 1 120/);
  assert.doesNotMatch(appInstallerSource, /Timed out waiting for parent process/);
});

test("prereq download keeps canonical URL helpers but bypasses discovery for exact builds", () => {
  const shellSource = readRepoFile("src/scripts/prereq-download.sh");
  const lookupStart = shellSource.indexOf('emit_step_start "cloudsmith-lookup"');
  const lookupEnd = shellSource.indexOf(
    'emit_step_start "prepare-directory"',
    lookupStart,
  );
  const exactBuildLookup = shellSource.slice(lookupStart, lookupEnd);

  assert.match(shellSource, /find_cloudsmith_package_metadata\(\)/);
  assert.match(shellSource, /managed_runtime_resolve_python3/);
  assert.match(shellSource, /"\$python3_bin" -c/);
  assert.match(shellSource, /payload\.get\("data"\) or payload\.get\("results"\) or \[\]/);
  assert.match(
    exactBuildLookup,
    /build_cloudsmith_download_url "\$KEYWORD" "\$BUILD_NUMBER" "\$EXPECTED_FILENAME" ""/,
  );
  assert.doesNotMatch(
    exactBuildLookup,
    /Cloudsmith API lookup|find_cloudsmith_package_metadata|\$pkg_cdn_url/,
  );
  assert.match(shellSource, /is_cloudsmith_raw_download_url "\$normalized_cdn_url"/);
  assert.match(shellSource, /raw\/names\/%s\/versions\/%s\/%s/);
  // PORTICO-342: the two payload-download argv pins that used to sit here matched
  // prereq-download.sh's source text for a fixed `-sS -L -f -o` invocation. They
  // broke when resume (-C -/If-Range) and a stall guard were added -- the exact
  // change they should have tolerated -- and they could never have caught the
  // flags being dropped at RUNTIME, which is the failure that matters. The argv is
  // now asserted behaviourally against PREPARED_CURL_ARGV_LOG in
  // src/scripts/test-prereq-payload-cache.sh.
  assert.match(
    shellSource,
    /run_curl_checked --stderr-file "\$stderr_file" "Cloudsmith content-length probe" "\$DOWNLOAD_URL" -fsSIL/,
  );
  assert.match(shellSource, /managed_runtime_reconcile_payload "\$MANAGED_SOURCE_DIR" "\$MANAGED_DIR"/);
  assert.doesNotMatch(shellSource, /copy_tree "\$MANAGED_SOURCE_DIR" "\$MANAGED_DIR"/);
});

test("legacy updater scripts parse build identities from the active package name", () => {
  const detachedUpdater = readRepoFile("electron-app/src/scripts/update-cloudsmith.sh");
  const visibleUpdater = readRepoFile("electron-app/src/scripts/update-in-app-cloudsmith.sh");
  const prepareUpdater = readRepoFile("electron-app/src/scripts/prepare-update-cloudsmith.sh");

  for (const source of [detachedUpdater, visibleUpdater, prepareUpdater]) {
    assert.match(source, /resolve_update_channel_package_name/);
    assert.match(source, /BUILD_IDENTITY="\$\{FILENAME#\$\{(?:BUILD|UPDATE)_CHANNEL\}-\}"/);
    assert.doesNotMatch(source, /FILENAME" =~ portico-/);
  }
});

test("bootstrap preserves the bundled build timestamp used for update ordering", () => {
  const bootstrapSource = readRepoFile("electron-app/src/services/bootstrap.js");
  const sharedStateSource = readRepoFile("electron-app/src/services/shared-state.js");

  assert.match(bootstrapSource, /state\.buildInfo\.timestamp = info\.timestamp \|\| null/);
  assert.match(sharedStateSource, /timestamp: null/);
});

test("loading launch gate surfaces rejected update-preparation starts", () => {
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(loadingSource, /prepResult\?\.success === false/);
  assert.match(loadingSource, /updateStatus\('Required update preparation failed'\)/);
  assert.match(
    loadingSource,
    /Failed to start update preparation: \$\{prepResult\.error \|\| 'Unknown error'\}/,
  );
  assert.match(loadingSource, /recoveryButtons\.classList\.add\('visible'\)/);
});

test("loading launch gate refreshes update metadata before retry retries and falls back to cached metadata", () => {
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(loadingSource, /const LAUNCH_UPDATE_RETRY_REFRESH_TIMEOUT_MS = 10000;/);
  assert.match(
    loadingSource,
    /async function refreshLaunchRetryUpdateInfo\(timeoutMs = LAUNCH_UPDATE_RETRY_REFRESH_TIMEOUT_MS\)/,
  );
  assert.match(loadingSource, /window\.electronAPI\?\.checkForUpdates/);
  assert.match(loadingSource, /Promise\.race\(\[guardedUpdateCheck, timeoutResult\]\)/);
  assert.match(
    loadingSource,
    /if \(isRetry\) \{[\s\S]*refreshLaunchRetryUpdateInfo\(\);[\s\S]*if \(isUsableLaunchRetryUpdateInfo\(refreshedUpdate\?\.result\)\) \{[\s\S]*launchUpdateGate\.updateInfo = preparationUpdateInfo;[\s\S]*launchUpdateGate\.updateKey = buildUpdateKey\(preparationUpdateInfo\);[\s\S]*\} else \{[\s\S]*Continuing with cached update metadata\./s,
  );
  assert.match(loadingSource, /startUpdatePreparation\(preparationUpdateInfo\)/);
});

test("menu update checks surface Cloudsmith lookup errors instead of reporting latest", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");

  const errorBranchIndex = windowsSource.indexOf("if (updateInfo.error)");
  const availableBranchIndex = windowsSource.indexOf("} else if (updateInfo.updateAvailable)");
  const latestMessageIndex = windowsSource.indexOf("You are running the latest version");

  assert.notEqual(errorBranchIndex, -1);
  assert.notEqual(availableBranchIndex, -1);
  assert.ok(errorBranchIndex < availableBranchIndex);
  assert.ok(availableBranchIndex < latestMessageIndex);
  assert.match(windowsSource, /title: 'Update Check Failed'/);
  assert.match(windowsSource, /detail: updateInfo\.error/);
});

test("install-specific-build prompt is rendered by an app-owned window", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");

  assert.doesNotMatch(windowsSource, /require\('electron-prompt'\)/);
  assert.match(windowsSource, /function showBuildIdPrompt\(\{ channelLabel \}\)/);
  assert.match(windowsSource, /new BrowserWindow\(\{/);
  assert.match(windowsSource, /portico-prompt:\/\/submit\?value=/);
  assert.match(windowsSource, /promptWindow\.loadURL\(`data:text\/html;charset=utf-8,/);
  assert.match(windowsSource, /const buildId = await showBuildIdPrompt\(\{ channelLabel \}\);/);
});

test("Cloudsmith metadata lookups do not use entitlement tokens as API keys", () => {
  const updatesSource = readRepoFile("electron-app/src/services/updates.js");
  const prerequisitesSource = readRepoFile("electron-app/src/services/prerequisites-service.js");

  assert.match(updatesSource, /'X-Api-Key': CLOUDSMITH_READ_TOKEN/);
  assert.doesNotMatch(updatesSource, /CLOUDSMITH_READ_TOKEN \|\| CLOUDSMITH_ENTITLEMENT_TOKEN/);
  assert.match(
    prerequisitesSource,
    /const discoveryApiKey = CLOUDSMITH_READ_TOKEN \|\| CLOUDSMITH_API_KEY;/,
  );
  assert.match(prerequisitesSource, /headers\['X-Api-Key'\] = discoveryApiKey/);
  assert.doesNotMatch(prerequisitesSource, /CLOUDSMITH_READ_TOKEN \|\| CLOUDSMITH_ENTITLEMENT_TOKEN/);
});

test("main update UI records rejected update-preparation starts as failed prep state", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(updatesSource, /prepResult\?\.success === false/);
  assert.match(updatesSource, /state: "failed"/);
  assert.match(updatesSource, /const prepError = prepResult\.error \|\| "Unknown error"/);
  assert.match(updatesSource, /error: prepError/);
});

test("main update UI suppresses missing-checksum prep failures in the header", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(updatesSource, /function isMissingChecksumPrepFailure\(error\)/);
  assert.match(
    updatesSource,
    /error\.includes\("Update payload checksum metadata is missing"\)/,
  );
  assert.match(updatesSource, /function shouldSuppressPrepFailureInHeader\(prep\)/);
  assert.match(updatesSource, /console\.info\("\[Update\] Background preparation deferred:", prepError\)/);

  const suppressedBranchIndex = updatesSource.indexOf(
    "prepForThisUpdate && shouldSuppressPrepFailureInHeader(prep)",
  );
  const genericFailureBranchIndex = updatesSource.indexOf('prepForThisUpdate && prep.state === "failed"');
  assert.notEqual(suppressedBranchIndex, -1);
  assert.notEqual(genericFailureBranchIndex, -1);
  assert.ok(
    suppressedBranchIndex < genericFailureBranchIndex,
    "missing-checksum suppression must run before the generic failed-prep renderer",
  );

  const suppressedBranch = updatesSource.slice(suppressedBranchIndex, genericFailureBranchIndex);
  assert.match(suppressedBranch, /updateButton\.classList\.remove\("pulsing-glow", "preparing"\)/);
  assert.match(suppressedBranch, /spinnerEl\.classList\.add\("hidden"\)/);
  assert.match(suppressedBranch, /tooltipEl\.classList\.add\("hidden"\)/);
  assert.match(suppressedBranch, /hideUpdateButton\(\)/);
});

test("main update UI still surfaces generic prep failures", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(updatesSource, /prepForThisUpdate && prep\.state === "failed"/);
  assert.match(updatesSource, /updateButton\.classList\.add\("prep-status-failed"\)/);
  assert.match(updatesSource, /labelEl\.textContent = "Update preparation failed"/);
  assert.match(updatesSource, /console\.error\("\[Update\] Failed to start background preparation:", prepError\)/);
});

test("main process logs rejected update-preparation starts", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(mainSource, /\[Update Prep\] Start request rejected:/);
});

test("main process derives a concrete update failure message even when stderr is empty", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const helperSource = readRepoFile("electron-app/src/services/update-failure-message.js");

  assert.match(
    mainSource,
    /const \{ deriveUpdateFailureMessage \} = require\("\.\/update-failure-message"\);/,
  );
  assert.match(mainSource, /const failureMessage =\s*code === 0\s*\?\s*""\s*:\s*deriveUpdateFailureMessage\(/s);
  assert.match(helperSource, /function deriveUpdateFailureMessage\(\{/);
  assert.match(helperSource, /Update failed during \$\{stepLine\}/);
  assert.match(
    mainSource,
    /state\.windows\.loading\.webContents\.send\("update-complete",\s*\{[\s\S]*error:\s*code === 0 \? undefined : failureMessage,/s,
  );
  assert.match(
    mainSource,
    /finishExecution\(\{[\s\S]*error:\s*code === 0 \? errorOutput : failureMessage,[\s\S]*errorOutput,/s,
  );
});

test("live update paths do not reference legacy Nexus update checks", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const bootstrapSource = readRepoFile("bootstrap.sh");

  assert.doesNotMatch(mainSource, /checkNexusUpdates/);
  assert.doesNotMatch(mainSource, /Nexus timestamp/);
  assert.doesNotMatch(bootstrapSource, /Nexus lastModified/);
  assert.match(mainSource, /const latestUpdateInfo = await checkForUpdates\(\);/);
  assert.match(bootstrapSource, /Cloudsmith uploaded_at/);
});

test("manual update checks surface discovery failures instead of reporting latest", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");

  const resultIndex = windowsSource.indexOf(
    "const updateInfo = await deps.checkForUpdates();",
  );
  const errorIndex = windowsSource.indexOf(
    "if (!updateInfo || updateInfo.error)",
    resultIndex,
  );
  const latestIndex = windowsSource.indexOf(
    "message: 'You are running the latest version'",
    resultIndex,
  );

  assert.notEqual(resultIndex, -1);
  assert.notEqual(errorIndex, -1);
  assert.notEqual(latestIndex, -1);
  assert.ok(errorIndex < latestIndex, "update errors must be handled before the latest-version dialog");
  assert.match(ipcSource, /if \(updateInfo\?\.error\) \{[\s\S]*success: false,[\s\S]*updateSource: "cloudsmith"/);
});

test("prepared update restart uses the newly synced staged-app installer", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const applyPreparedUpdateSource = readRepoFile(
    "electron-app/src/scripts/apply-prepared-update.sh",
  );
  const installerSource = readRepoFile("electron-app/src/scripts/install-staged-app.sh");

  assert.match(
    mainSource,
    /const helperScript = path\.join\(\s*PROJECT_ROOT,\s*"electron-app",\s*"src",\s*"scripts",\s*"install-staged-app\.sh",\s*\);/s,
  );
  assert.match(mainSource, /spawn\(\s*"bash",\s*\[\s*helperScript,/s);

  const reconcileIndex = applyPreparedUpdateSource.indexOf(
    'managed_runtime_reconcile_payload "$PREPARED_MANAGED_ROOT_DIR" "$MANAGED_DIR"',
  );
  const restartSignalIndex = applyPreparedUpdateSource.indexOf('echo "READY_FOR_RESTART"');
  assert.notEqual(reconcileIndex, -1);
  assert.notEqual(restartSignalIndex, -1);
  assert.ok(
    reconcileIndex < restartSignalIndex,
    "prepared source must be synced into the managed runtime before restart",
  );

  assert.match(installerSource, /open -n "\$TARGET_APP_BUNDLE"/);
  assert.doesNotMatch(installerSource, /open -a "\$TARGET_APP_BUNDLE"/);
});

test("install and update lifecycles automate conservative Docker storage maintenance", () => {
  const installSource = readRepoFile("install_v2.sh");
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const applySource = readRepoFile(
    "electron-app/src/scripts/apply-prepared-update.sh",
  );

  assert.match(installSource, /run_buildkit_policy_migration\n/);
  assert.doesNotMatch(installSource, /run_harbor_image_cleanup|portico-docker-cleanup/);

  const startupGate = mainSource.indexOf("await runStartupCoreHealthGate({");
  const postHealthCleanup = mainSource.indexOf(
    "await runPostReleaseDockerStorageCleanup(",
    startupGate,
  );
  assert.notEqual(startupGate, -1);
  assert.ok(postHealthCleanup > startupGate);
  assert.match(mainSource, /requireFreshResult: pendingPostReleaseCleanup\.pending/);
  assert.match(mainSource, /reason: "transition-changed"/);
  assert.match(
    mainSource,
    /runPostReleaseDockerStorageCleanup\(\s*pendingPostReleaseCleanup\.transition/,
  );
  assert.match(mainSource, /step: "post_health_cleanup_claim"/);
  assert.match(mainSource, /includeMigration: false/);
  const preparationSource = readRepoFile(
    "electron-app/src/services/update-preparation.js",
  );
  assert.match(
    preparationSource,
    /includeCleanup: false/,
  );

  assert.match(applySource, /"source":"apply-prepared-update"/);
  assert.match(applySource, /"transitionId":"%s"/);
});

test("node build-only mode prepares build metadata before the optional launch", () => {
  const installSource = readRepoFile("install_v2.sh");
  const buildSection = installSource.indexOf(
    'print_section "$BLUE" "🔨 Building Management Application"',
  );
  const nodeBranch = installSource.indexOf(
    'if [ "$USE_NODE" = true ]; then',
    buildSection,
  );
  const packagedBranch = installSource.indexOf("\n    else\n", nodeBranch);
  const launchSection = installSource.indexOf(
    '# Launch the app unless --no-launch was specified',
    nodeBranch,
  );

  assert.notEqual(buildSection, -1);
  assert.notEqual(nodeBranch, -1);
  assert.notEqual(packagedBranch, -1);
  assert.notEqual(launchSection, -1);
  assert.ok(nodeBranch < launchSection);
  assert.match(
    installSource.slice(nodeBranch, packagedBranch),
    /if \[ "\$SKIP_BUILD_INFO" = false \]; then\s+generate_build_info/,
  );

  const launchFunctionStart = installSource.indexOf("ensure_node_and_launch() {");
  const launchFunctionEnd = installSource.indexOf(
    "\n}\n",
    launchFunctionStart,
  );
  assert.doesNotMatch(
    installSource.slice(launchFunctionStart, launchFunctionEnd),
    /generate_build_info/,
  );
});

test("legacy guided-setup app bundles are not preserved across update paths", () => {
  const reconcileSource = readRepoFile("src/scripts/managed-runtime-reconcile.sh");
  const bootstrapSource = readRepoFile("bootstrap.sh");
  const installSource = readRepoFile("install_v2.sh");

  const preserveBlock = reconcileSource.match(
    /MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS=\([\s\S]*?\n\)/,
  );
  assert.ok(preserveBlock, "expected managed runtime preserve list");
  assert.doesNotMatch(preserveBlock[0], /"guided-setup"/);
  assert.doesNotMatch(bootstrapSource, /!\s+-path "\$MANAGED_DIR\/guided-setup\/\*"/);
  assert.match(bootstrapSource, /rm -rf "\$MANAGED_DIR\/guided-setup"/);
  assert.doesNotMatch(installSource, /guided-setup\/dist-update -> \.\.\/electron-app/);
  assert.doesNotMatch(installSource, /ln -sf "\.\.\/electron-app\/dist-update"/);
  assert.match(installSource, /rm -rf "\$MANAGED_DIR\/guided-setup"/);
});

test("debug collection records runtime paths and stale guided-setup app build info", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const debugSource = readRepoFile("src/scripts/debug.sh");

  assert.match(ipcSource, /buildRuntimeDiagnosticsText/);
  assert.match(ipcSource, /runtime_diagnostics_temp\.txt/);
  assert.match(debugSource, /capture_runtime_launch_diagnostics\(\)/);
  assert.match(debugSource, /runtime_diagnostics\.txt/);
  assert.match(debugSource, /stale-guided-setup-app-build-info\.txt/);
});

test("main update tooltip uses stage-level progress and native tooltip IPC instead of per-image Docker rows", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(updatesSource, /window\.electronAPI\?\.updatePrepTooltip\?\.show/);
  assert.match(updatesSource, /phasePercent/);
  assert.match(updatesSource, /phaseDetail/);
  assert.match(updatesSource, /function getPrepHeaderText\(prep\)/);
  assert.match(updatesSource, /labelEl\.textContent = getPrepHeaderText\(prep\);/);
  assert.match(updatesSource, /updateButton\.title = headerDescription;/);
  assert.match(indexSource, /update-prep-detail-text/);
  assert.doesNotMatch(indexSource, /update-prep-docker-list/);
});

test("loading launch gate mirrors Docker-focused preparation logs for copy-logs output", () => {
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.js");

  assert.match(loadingSource, /onUpdatePreparationLog/);
  assert.match(loadingSource, /Using Docker image manifest/);
  assert.match(loadingSource, /Pulling Docker image:/);
  assert.match(loadingSource, /Docker stalled; restarting OrbStack/);
  assert.match(loadingSource, /Retrying Docker image preparation/);
});

test("loading update flow keeps stage copy on the single caption path without rendering secondary task rows", () => {
  const loadingSource = readRepoFile("electron-app/src/renderer/views/loading.js");
  const loadingHtml = readRepoFile("electron-app/src/renderer/views/loading.html");

  assert.match(loadingSource, /updateTaskMode = Boolean\(updateInfo\?\.prepared\?\.ready\) \? 'prepared' : 'legacy';/);
  assert.match(loadingSource, /updateStatus\('Validating prepared update\.\.\.'\);/);
  assert.match(loadingSource, /updateStatus\('Installing prepared files\.\.\.'\);/);
  assert.match(loadingSource, /updateStatus\('Downloading update\.\.\.'\);/);
  assert.match(loadingSource, /updateStatus\('Installing update\.\.\.'\);/);
  assert.doesNotMatch(loadingSource, /prepared-update-task-list/);
  assert.doesNotMatch(loadingSource, /setUpdateTaskActive\(/);
  assert.doesNotMatch(loadingSource, /setUpdateTaskCompleted\(/);
  assert.doesNotMatch(
    loadingHtml,
    /\.task-list\.prepared-update-task-list\s+\.task-item\.completed\s+\.task-icon/s,
  );
});
