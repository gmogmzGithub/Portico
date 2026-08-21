const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function loadUpdateClickHarness({ dialogResult, startResult }) {
  const updateInfo = {
    latestBuildNumber: "08032026-test",
    updateKey: "08032026-test|sha256:test|portico_test",
  };
  const calls = {
    showUpdateDialog: [],
    startUpdateFromMainWindow: [],
  };
  const windowObject = {
    appState: {
      updateAvailable: true,
      updateInfo,
      updatePromptedKey: null,
      updatePrep: {
        state: "ready",
        updateKey: updateInfo.updateKey,
        prepared: { ready: true },
      },
    },
    electronAPI: {
      checkForUpdates: async () => ({ success: true, updateAvailable: false }),
      showUpdateDialog: async (receivedUpdateInfo) => {
        calls.showUpdateDialog.push(receivedUpdateInfo);
        return dialogResult;
      },
      startUpdateFromMainWindow: async (receivedUpdateInfo) => {
        calls.startUpdateFromMainWindow.push(receivedUpdateInfo);
        return startResult;
      },
    },
  };
  const context = {
    window: windowObject,
    document: {
      getElementById: () => null,
      documentElement: { getAttribute: () => null },
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null },
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    readRepoFile("electron-app/src/renderer/components/updates.js"),
    context,
    { filename: "updates.js" },
  );

  return { window: windowObject, updateInfo, calls };
}

test("an explicit update click resumes a suppressed menu auto-install", async () => {
  const harness = loadUpdateClickHarness({
    dialogResult: {
      success: false,
      suppressed: true,
      reason: "manual-auto-install",
    },
    startResult: { success: true, started: true },
  });

  await harness.window.handleUpdateClick();

  assert.deepEqual(harness.calls.showUpdateDialog, [harness.updateInfo]);
  assert.deepEqual(harness.calls.startUpdateFromMainWindow, [harness.updateInfo]);
  assert.equal(
    harness.window.appState.updatePromptedKey,
    harness.updateInfo.updateKey,
  );
});

test("main update install modal switches to Control Plane before revealing the dialog", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(updatesSource, /function revealUpdateModal\(modal\) \{/);
  assert.match(
    updatesSource,
    /window\.ensureControlPlaneTabActive\?\.\(\);\s*revealUpdateModal\(modal\);/s,
  );
  assert.match(
    updatesSource,
    /typeof window\.requestAnimationFrame === "function"/,
  );
});

test("header update control is a real button and click wiring targets that button", () => {
  const indexHtml = readRepoFile("electron-app/src/renderer/views/index.html");
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(
    indexHtml,
    /<button\s+id="update-button"[\s\S]*class="update-button pulsing-glow hidden"[\s\S]*type="button"/,
  );
  assert.doesNotMatch(indexHtml, /<div id="update-button"/);
  assert.match(indexSource, /const updateButton = document\.getElementById\('update-button'\);/);
  assert.match(indexSource, /updateButton\.addEventListener\('click', window\.handleUpdateClick\)/);
  assert.doesNotMatch(indexSource, /querySelector\('\.update-button-content'\)/);
});

test("light theme stable update preparation uses the active tab blue pill and keeps the header button interactive", () => {
  const stylesSource = readRepoFile("electron-app/src/styles.css");

  assert.match(
    stylesSource,
    /\.update-button-shell\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
  );
  assert.match(
    stylesSource,
    /\.update-button\s*\{[^}]*background:\s*transparent;[^}]*appearance:\s*none;[^}]*-webkit-app-region:\s*no-drag;/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.update-button\.preparing\.prep-status-preparing\s*\{[^}]*background:\s*var\(--header-active-tab-bg\);[^}]*color:\s*var\(--header-active-tab-text\);/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.update-button\.preparing\.prep-status-preparing\s+\.update-prep-spinner\s*\{[^}]*border-color:\s*rgba\(var\(--accent-primary-rgb\), 0\.18\);[^}]*border-top-color:\s*var\(--header-active-tab-text\);/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\.update-button\.preparing\s+\.update-button-content\s*\{[^}]*cursor:\s*default;/s,
  );
  assert.match(
    stylesSource,
    /\[data-theme="light"\]\s+\.update-button\.preparing\.prep-status-preparing\s+\.update-button-content\s*\{[^}]*cursor:\s*pointer;/s,
  );
  assert.doesNotMatch(
    stylesSource,
    /\[data-theme="dark"\]\s+\.update-button\.preparing\.prep-status-preparing/,
  );
});

test("update prep native tooltip uses per-kind minimum sizing instead of the generic 120px height floor", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");

  assert.match(
    windowsSource,
    /mcp:\s*\{[\s\S]*minWidth:\s*280,[\s\S]*minHeight:\s*120,[\s\S]*\}/,
  );
  assert.match(
    windowsSource,
    /updatePrep:\s*\{[\s\S]*minWidth:\s*280,[\s\S]*minHeight:\s*1,[\s\S]*\}/,
  );
  assert.match(
    windowsSource,
    /const minWidth = Math\.max\(1, Math\.round\(Number\(config\.minWidth\) \|\| 280\)\);/,
  );
  assert.match(
    windowsSource,
    /const minHeight = Math\.max\(1, Math\.round\(Number\(config\.minHeight\) \|\| 120\)\);/,
  );
  assert.match(
    windowsSource,
    /width:\s*Math\.max\(minWidth, Math\.round\(Number\(width\) \|\| 0\)\),/,
  );
  assert.match(
    windowsSource,
    /height:\s*Math\.max\(minHeight, Math\.round\(Number\(height\) \|\| 0\)\),/,
  );
});

test("renderer update tooltip measurement uses rendered dimensions with non-zero fallbacks", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(
    updatesSource,
    /const tooltipRect = tooltipEl\.getBoundingClientRect\(\);/,
  );
  assert.match(
    updatesSource,
    /const tooltipWidth = Math\.max\(\s*280,\s*Math\.round\(tooltipRect\.width \|\| 0\),[\s\S]*Math\.round\(tooltipEl\.scrollWidth \|\| 0\),[\s\S]*360,\s*\);/s,
  );
  assert.match(
    updatesSource,
    /const tooltipHeight = Math\.max\(\s*1,\s*Math\.round\(tooltipRect\.height \|\| 0\),[\s\S]*Math\.round\(tooltipEl\.scrollHeight \|\| 0\),\s*\);/s,
  );
});

test("menu auto-install update workflows can fall back to the loading window when the control plane is unavailable", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(mainSource, /const canUseLoadingWindow = postPreparationAction === "auto-install";/);
  assert.match(
    mainSource,
    /state\.windows\.main && !state\.windows\.main\.isDestroyed\(\)\s*\? \{ kind: "main", ref: state\.windows\.main \}\s*:\s*canUseLoadingWindow &&\s*state\.windows\.loading &&\s*!state\.windows\.loading\.isDestroyed\(\)/s,
  );
  assert.match(mainSource, /sendToLoadingWindow\("menu-update-requested", payload\);/);
});

test("background update preparation prompts for ordinary updates and auto-starts forced updates", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");

  assert.match(
    updatesSource,
    /if \(!isManualActionForCurrentUpdate\) \{[\s\S]*state\.updateInfo\?\.forceUpdate === true[\s\S]*window\.electronAPI\.startUpdateFromMainWindow\(state\.updateInfo\)[\s\S]*Failed to auto-start required background update[\s\S]*return;[\s\S]*if \(state\.updatePromptedKey === updateKey\) return;[\s\S]*state\.updatePromptedKey = updateKey;[\s\S]*window\.electronAPI\.showUpdateDialog\(state\.updateInfo\)[\s\S]*Failed to show prepared background update dialog[\s\S]*return;[\s\S]*\}\s*if \(pendingManualUpdateAction\.started\)/s,
  );

  const backgroundGuardIndex = updatesSource.indexOf("if (!isManualActionForCurrentUpdate)");
  const forceAutoStartIndex = updatesSource.indexOf(
    "window.electronAPI.startUpdateFromMainWindow(state.updateInfo)",
    backgroundGuardIndex,
  );
  const duplicateGuardIndex = updatesSource.indexOf(
    "if (state.updatePromptedKey === updateKey) return",
    backgroundGuardIndex,
  );
  const promptedKeySetIndex = updatesSource.indexOf(
    "state.updatePromptedKey = updateKey",
    duplicateGuardIndex,
  );
  const promptIndex = updatesSource.indexOf(
    "window.electronAPI.showUpdateDialog(state.updateInfo)",
    backgroundGuardIndex,
  );
  const manualStartedIndex = updatesSource.indexOf(
    "if (pendingManualUpdateAction.started)",
    backgroundGuardIndex,
  );

  assert.notEqual(backgroundGuardIndex, -1);
  assert.notEqual(forceAutoStartIndex, -1);
  assert.notEqual(duplicateGuardIndex, -1);
  assert.notEqual(promptedKeySetIndex, -1);
  assert.notEqual(promptIndex, -1);
  assert.notEqual(manualStartedIndex, -1);
  assert.ok(
    forceAutoStartIndex < duplicateGuardIndex,
    "forced background updates must keep the auto-install path",
  );
  assert.ok(
    duplicateGuardIndex < promptedKeySetIndex && promptedKeySetIndex < promptIndex,
    "ordinary background updates must set the prompted key before opening the dialog",
  );
  assert.ok(
    promptIndex < manualStartedIndex,
    "ordinary background updates must prompt before the manual action path",
  );
});

test("prepared update modal hides legacy completed badges while keeping prepared install rows", () => {
  const updatesSource = readRepoFile("electron-app/src/renderer/components/updates.js");
  const indexHtml = readRepoFile("electron-app/src/renderer/views/index.html");

  assert.match(updatesSource, /taskList\.classList\.toggle\("prepared-update-task-list", isPrepared\);/);
  assert.match(updatesSource, /Validating prepared update/);
  assert.match(updatesSource, /Installing prepared files/);
  assert.match(
    indexHtml,
    /\.task-list\.prepared-update-task-list\s+\.task-item\.completed\s+\.task-icon\s*\{[^}]*background:\s*transparent;[^}]*color:\s*inherit;/s,
  );
  assert.match(
    indexHtml,
    /\.task-list\.prepared-update-task-list\s+\.task-item\.completed\s+\.task-icon::before\s*\{[^}]*content:\s*none;/s,
  );
});

test("main-window prepared updates have a main-process app-install fallback", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(mainSource, /function startPreparedAppInstaller\(\{ source = "unknown" \} = \{\}\) \{/);
  assert.match(mainSource, /let preparedAppInstallerToken = null;/);
  assert.match(
    mainSource,
    /if \(preparedAppInstallerToken === updateToken\) \{[\s\S]*Prepared app installer already started/s,
  );
  assert.match(
    mainSource,
    /function schedulePreparedAppInstallerFallback\(updateInfo, readyForRestart, code\) \{/,
  );
  assert.match(
    mainSource,
    /Renderer did not request prepared app restart; starting fallback installer/,
  );
  assert.match(
    mainSource,
    /schedulePreparedAppInstallerFallback\(updateInfo, readyForRestart, code\);/,
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("restart-after-update", async \(\) => \{[\s\S]*return startPreparedAppInstaller\(\{ source: "renderer-ipc" \}\);/s,
  );
});
