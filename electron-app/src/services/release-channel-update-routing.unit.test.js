const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("release channel changes recheck app updates without syncing marketplaces", () => {
  const updatesSource = readRepoFile(
    "electron-app/src/renderer/components/updates.js",
  );
  const marketplacesSource = readRepoFile(
    "electron-app/src/renderer/components/marketplaces.js",
  );
  const indexSource = readRepoFile("electron-app/src/renderer/views/index.js");

  assert.match(
    updatesSource,
    /window\.checkForAppUpdates\s*=\s*checkForAppUpdates;/,
  );
  assert.match(
    marketplacesSource,
    /window\.checkForMarketplaceUpdates\s*=\s*checkForMarketplaceUpdates;/,
  );
  assert.match(
    indexSource,
    /if \(window\.checkForAppUpdates\) window\.checkForAppUpdates\(\);/,
  );

  assert.doesNotMatch(updatesSource, /window\.checkForUpdates\s*=/);
  assert.doesNotMatch(marketplacesSource, /window\.checkForUpdates\s*=/);
  assert.doesNotMatch(indexSource, /window\.checkForMarketplaceUpdates/);
});

test("background app updates prompt after preparation while forced updates auto-install", () => {
  const updatesSource = readRepoFile(
    "electron-app/src/renderer/components/updates.js",
  );

  assert.match(
    updatesSource,
    /if \(!isManualActionForCurrentUpdate\) \{[\s\S]*state\.updateInfo\?\.forceUpdate === true[\s\S]*window\.electronAPI\.startUpdateFromMainWindow\(state\.updateInfo\)[\s\S]*return;[\s\S]*if \(state\.updatePromptedKey === updateKey\) return;[\s\S]*state\.updatePromptedKey = updateKey;[\s\S]*window\.electronAPI\.showUpdateDialog\(state\.updateInfo\)[\s\S]*return;[\s\S]*\}\s*if \(pendingManualUpdateAction\.started\)/s,
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
  const promptIndex = updatesSource.indexOf(
    "window.electronAPI.showUpdateDialog(state.updateInfo)",
    backgroundGuardIndex,
  );

  assert.notEqual(backgroundGuardIndex, -1);
  assert.notEqual(forceAutoStartIndex, -1);
  assert.notEqual(duplicateGuardIndex, -1);
  assert.notEqual(promptIndex, -1);
  assert.ok(
    forceAutoStartIndex < duplicateGuardIndex,
    "forced updates must keep auto-install semantics",
  );
  assert.ok(
    duplicateGuardIndex < promptIndex,
    "ordinary prepared updates must dedupe before prompting",
  );
});

test("marketplace Sync All keeps its marketplace-specific update route", () => {
  const marketplacesSource = readRepoFile(
    "electron-app/src/renderer/components/marketplaces.js",
  );

  assert.match(
    marketplacesSource,
    /checkUpdatesBtn\.addEventListener\("click", checkForMarketplaceUpdates\);/,
  );
  assert.match(
    marketplacesSource,
    /async function checkForMarketplaceUpdates\(\)[\s\S]*?window\.electronAPI\.syncAllMarketplaces\(\)[\s\S]*?window\.electronAPI\.checkSkillUpdates\(\)/,
  );
});
