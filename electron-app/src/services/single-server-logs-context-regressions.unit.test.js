const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// Regression guard for the wizard-vs-managed log diagnostics bug: callers in
// the single-server/wizard context should use the semantic wizard log helper,
// which prefers `mcpo-single-<id>` behind the Electron API boundary. The
// steady-state View logs path must keep using the normal managed-first helper.

test("preload exposes normal and wizard log helpers with distinct container preferences", () => {
  const source = readRepoFile("electron-app/src/services/preload.js");
  assert.match(
    source,
    /getSingleMcpServerLogs:\s*\(serverId,\s*lines\s*=\s*100,\s*options\s*=\s*\{\}\)\s*=>\s*ipcRenderer\.invoke\('get-single-mcp-server-logs',\s*serverId,\s*lines,\s*options\)/,
  );
  assert.match(
    source,
    /getWizardMcpServerLogs:\s*\(serverId,\s*lines\s*=\s*100,\s*options\s*=\s*\{\}\)\s*=>\s*ipcRenderer\.invoke\('get-single-mcp-server-logs',\s*serverId,\s*lines,\s*\{\s*\.\.\.options,\s*preferSingleServer:\s*true\s*\}\)/,
  );
});

test("ipc handler forwards preferSingleServer into getMcpServerLogs", () => {
  const source = readRepoFile("electron-app/src/services/ipc.js");
  assert.match(
    source,
    /get-single-mcp-server-logs",\s*async\s*\(event,\s*serverId,\s*lines\s*=\s*100,\s*options\s*=\s*\{\}\)/,
  );
  assert.match(
    source,
    /getMcpServerLogs\(serverId,\s*\{\s*lines,\s*preferSingleServer\s*\}\)/,
  );
});

const WIZARD_LOG_CALLERS = [
  "electron-app/src/renderer/screens/guided-setup/screen-oauth.js",
  "electron-app/src/renderer/components/oauth-wizard-modal.js",
  "electron-app/src/renderer/components/mcp-config-modal.js",
  "electron-app/src/renderer/views/guided-setup.js",
];

for (const relativePath of WIZARD_LOG_CALLERS) {
  test(`${relativePath} requests logs through the semantic wizard helper`, () => {
    const source = readRepoFile(relativePath);
    const calls = source.match(/getWizardMcpServerLogs\([^)]*\)/g) || [];
    assert.ok(calls.length > 0, `expected getWizardMcpServerLogs calls in ${relativePath}`);
    assert.doesNotMatch(
      source,
      /getSingleMcpServerLogs\([^)]*preferSingleServer/,
      `wizard log calls should not pass raw preferSingleServer options in ${relativePath}`,
    );
  });
}

test("steady-state View logs button keeps managed-first ordering (no preferSingleServer)", () => {
  const source = readRepoFile("electron-app/src/renderer/components/mcp-servers.js");
  const calls = source.match(/getSingleMcpServerLogs\([^)]*\)/g) || [];
  assert.ok(calls.length > 0, "expected getSingleMcpServerLogs call in mcp-servers.js");
  assert.doesNotMatch(source, /getWizardMcpServerLogs/);
  for (const call of calls) {
    assert.doesNotMatch(
      call,
      /preferSingleServer/,
      `steady-state log call must not force single-server preference -> ${call}`,
    );
  }
});
