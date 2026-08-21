const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("main window uses native close behavior instead of blocking the macOS traffic light", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  const createMainWindowBlock = windowsSource.slice(
    windowsSource.indexOf("function createMainWindow() {"),
    windowsSource.indexOf("const TOOLTIP_WINDOW_CONFIG = Object.freeze({"),
  );

  assert.doesNotMatch(
    createMainWindowBlock,
    /state\.windows\.main\.on\('close',/,
    "main window should no longer intercept close events before Electron handles them natively",
  );
  assert.match(
    createMainWindowBlock,
    /state\.windows\.main\.on\('closed',/,
    "main window should still clean up after it closes",
  );
});

test("window menu exposes an explicit Close Window command for the focused window", () => {
  const bootstrapSource = readRepoFile("electron-app/src/services/bootstrap.js");

  assert.match(
    bootstrapSource,
    /label:\s*'Close Window',\s*accelerator:\s*'CmdOrCtrl\+Shift\+W',[\s\S]*?\{\s*type:\s*'separator'\s*\},\s*\{\s*role:\s*'minimize'\s*\},\s*\{\s*role:\s*'zoom'\s*\}/,
    "Window menu should expose a Cmd+Shift+W 'Close Window' command before minimize/zoom",
  );
});

test("CmdOrCtrl+W is only intercepted for detachable chat windows", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(
    mainSource,
    /const shouldCloseFocusedChatWindow = canCloseFocusedChatWindow\(\);\s*if \(!shouldCloseFocusedChatWindow\) \{\s*return;\s*\}\s*const now = Date\.now\(\);[\s\S]*event\.preventDefault\(\);\s*closeFocusedChatWindow\(\);/s,
    "main-process shortcut handling should only prevent the native close action when a detachable chat window is actually focused",
  );
});

test("macOS activate restores the main shell after the control plane has been shown once", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");

  assert.match(
    mainSource,
    /let hasShownManagerMainWindow = false;/,
    "main process should track whether the manager shell has been shown already",
  );
  assert.match(
    mainSource,
    /ipcMain\.on\("show-main-window",\s*\(event,\s*options = \{\}\) => \{[\s\S]*hasShownManagerMainWindow = true;/s,
    "show-main-window should mark the manager shell as available for future reactivation",
  );
  assert.match(
    mainSource,
    /app\.on\("activate",\s*\(\) => \{[\s\S]*if \(isManagerMode\) \{[\s\S]*if \(hasShownManagerMainWindow && !isInitializing\) \{\s*createMainWindow\(\);\s*\} else \{\s*createLoadingWindow\(\);\s*\}/s,
    "dock reactivation should reopen the main shell after startup completes and only fall back to the loading screen before then",
  );
});

test("closing all macOS windows preserves the app-owned Host MCP Bridge", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const windowCloseBlock = mainSource.slice(
    mainSource.indexOf('app.on("window-all-closed"'),
    mainSource.indexOf('app.on("activate"'),
  );
  const beforeQuitBlock = mainSource.slice(
    mainSource.indexOf('app.on("before-quit"'),
    mainSource.indexOf("// Docker/MCP functions"),
  );

  assert.doesNotMatch(windowCloseBlock, /stopHostMcpBridge/);
  assert.match(beforeQuitBlock, /stopHostMcpBridge/);
});

test("electron shell and browser views no longer force-reset zoom back to 100%", () => {
  const windowsSource = readRepoFile("electron-app/src/services/windows.js");
  const owuiViewsSource = readRepoFile("electron-app/src/services/owui-views.js");
  const artifactViewsSource = readRepoFile("electron-app/src/services/artifact-views.js");

  assert.doesNotMatch(
    windowsSource,
    /setZoomLevel\(0\)|setZoomFactor\(1\)|webContents\.on\('zoom-changed'/,
    "main shell should not override native Electron zoom shortcuts or menu actions",
  );
  assert.doesNotMatch(
    owuiViewsSource,
    /setZoomLevel\(0\)|setZoomFactor\(1\)|contents\.on\("zoom-changed"|resetContentsZoom\(/,
    "OWUI browser views should not override native Electron zoom shortcuts or menu actions",
  );
  assert.doesNotMatch(
    artifactViewsSource,
    /setZoomLevel\(0\)|setZoomFactor\(1\)|contents\.on\("zoom-changed"|resetContentsZoom\(/,
    "artifact views should not override native Electron zoom shortcuts or menu actions",
  );
});
