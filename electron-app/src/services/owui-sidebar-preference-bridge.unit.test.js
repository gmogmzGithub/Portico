const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("OWUI sidebar preference bridge wires IPC handlers and preload host methods", () => {
  const ipcSource = readRepoFile("electron-app/src/services/ipc.js");
  const preloadSource = readRepoFile("electron-app/src/services/chat-webview-preload.js");

  assert.match(ipcSource, /readOwuiSidebarPreferences/);
  assert.match(ipcSource, /saveOwuiSidebarPreferences/);
  assert.match(ipcSource, /ipcMain\.handle\("owui-get-sidebar-preference"/);
  assert.match(ipcSource, /ipcMain\.handle\("owui-save-sidebar-preference"/);

  assert.match(
    preloadSource,
    /function getSidebarPreference\(\)\s*\{\s*return ipcRenderer\.invoke\('owui-get-sidebar-preference'\);\s*\}/s,
  );
  assert.match(
    preloadSource,
    /function saveSidebarPreference\(open\)\s*\{\s*return ipcRenderer\.invoke\('owui-save-sidebar-preference', open\);\s*\}/s,
  );
  assert.match(preloadSource, /getSidebarPreference,/);
  assert.match(preloadSource, /saveSidebarPreference,/);
});

test("Sidebar.svelte reads durable preferences only for normal windows", () => {
  const sidebarSource = readRepoFile(
    "src/patches/frontend/src/lib/components/layout/Sidebar.svelte",
  );

  assert.match(sidebarSource, /resolveInitialSidebarOpen/);
  assert.match(sidebarSource, /shouldPersistSidebarPreference/);
  assert.match(sidebarSource, /getSidebarPreference\?:/);
  assert.match(sidebarSource, /saveSidebarPreference\?:/);
  assert.match(sidebarSource, /delegatedSubagentView/);
  assert.match(sidebarSource, /isDelegatedSubagentRoute/);
});
