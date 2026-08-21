const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const owuiViewsPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "owui-views.js",
);

test("OWUI session routes chat export downloads through the Electron save-path helper", () => {
  const source = fs.readFileSync(owuiViewsPath, "utf8");

  assert.match(source, /owuiSession\.on\("will-download",\s*\(event,\s*item,\s*webContents\)\s*=>/);
  assert.match(source, /classifyOwuiChatExportDownload\(\s*\{/);
  assert.match(source, /dialog\.showSaveDialogSync\(/);
  assert.match(source, /normalizeChatExportSavePath\(/);
  assert.match(source, /item\.setSavePath\(/);
  assert.match(source, /item\.cancel\(\)/);
});
