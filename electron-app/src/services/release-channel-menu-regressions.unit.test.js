const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const bootstrapSource = fs.readFileSync(path.join(__dirname, "bootstrap.js"), "utf8");
const windowsSource = fs.readFileSync(path.join(__dirname, "windows.js"), "utf8");
const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");

test("macOS release channel menu displays the active custom label and restores checks on cancel", () => {
  assert.match(bootstrapSource, /label: `Release Channel: \$\{channelLabel\}`/);
  assert.match(bootstrapSource, /createReleaseChannelMenuItems\(currentChannel/);
  assert.match(
    bootstrapSource,
    /initialValue: currentChannel\.kind === 'custom'[\s\S]*currentChannel\.name/,
  );
  assert.match(
    bootstrapSource,
    /if \(channelName === null\) \{\s*createMenu\(\);\s*return;/,
  );
});

test("custom release channel prompt remains sandboxed and validates before persistence", () => {
  assert.match(windowsSource, /title: 'Custom Release Channel'/);
  assert.match(
    windowsSource,
    /nodeIntegration: false,\s*contextIsolation: true,\s*sandbox: true/,
  );
  assert.match(windowsSource, /validateCustomReleaseChannelName\(value\)/);
  assert.match(windowsSource, /if \(value === null\) \{\s*return null;/);
  assert.match(windowsSource, /return validation\.name/);
});

test("channel changes clear prepared state and expose the custom package through build info IPC", () => {
  assert.match(bootstrapSource, /clearPreparedUpdateAfterChannelChange\(\)/);
  assert.match(bootstrapSource, /webContents\.send\('clear-update-state'\)/);
  assert.match(ipcSource, /bootstrap\.getCurrentChannelInfo\(\)/);
  assert.match(ipcSource, /releaseChannelInfo\.packageName/);
});
