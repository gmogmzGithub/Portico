const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  enforceNotStaleGuidedSetupAppLaunch,
  getStaleGuidedSetupLaunchState,
} = require("./stale-guided-setup-app-guard");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function staleAppRef(exitCalls = []) {
  return {
    isPackaged: true,
    getAppPath() {
      return "/Users/dihlo/portico/portico-managed/guided-setup/dist/mac-arm64/Portico.app/Contents/Resources/app.asar";
    },
    getPath(name) {
      assert.equal(name, "exe");
      return "/Users/dihlo/portico/portico-managed/guided-setup/dist/mac-arm64/Portico.app/Contents/MacOS/Portico";
    },
    exit(code) {
      exitCalls.push(code);
    },
  };
}

test("stale guided-setup launch state blocks packaged macOS stale app paths", () => {
  const result = getStaleGuidedSetupLaunchState({
    appRef: staleAppRef(),
    platform: "darwin",
    fsRef: {
      existsSync(candidate) {
        return candidate === "/Applications/Portico.app";
      },
    },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.canonicalExists, true);
  assert.equal(result.staleCandidates.length, 2);
});

test("stale guided-setup guard relaunches the canonical Applications app", () => {
  const exitCalls = [];
  const dialogCalls = [];
  const spawnCalls = [];

  const result = enforceNotStaleGuidedSetupAppLaunch({
    appRef: staleAppRef(exitCalls),
    dialogRef: {
      showErrorBox(title, message) {
        dialogCalls.push({ title, message });
      },
    },
    platform: "darwin",
    fsRef: {
      existsSync(candidate) {
        return candidate === "/Applications/Portico.app";
      },
    },
    spawnRef(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { unref() {} };
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.relaunchedCanonical, true);
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(spawnCalls.map(({ command, args }) => ({ command, args })), [
    { command: "open", args: ["-n", "/Applications/Portico.app"] },
  ]);
  assert.equal(dialogCalls[0].title, "Old App Copy Detected");
});

test("stale guided-setup guard relaunches the per-user Applications app", () => {
  const exitCalls = [];
  const dialogCalls = [];
  const spawnCalls = [];
  const userAppPath = "/Users/tester/Applications/Portico.app";

  const result = enforceNotStaleGuidedSetupAppLaunch({
    appRef: staleAppRef(exitCalls),
    dialogRef: {
      showErrorBox(title, message) {
        dialogCalls.push({ title, message });
      },
    },
    platform: "darwin",
    homedir: "/Users/tester",
    fsRef: {
      existsSync(candidate) {
        return candidate === userAppPath;
      },
    },
    spawnRef(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { unref() {} };
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.canonicalAppPath, userAppPath);
  assert.equal(result.relaunchedCanonical, true);
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(spawnCalls.map(({ command, args }) => ({ command, args })), [
    { command: "open", args: ["-n", userAppPath] },
  ]);
  assert.equal(dialogCalls[0].title, "Old App Copy Detected");
});

test("stale guided-setup guard exits with failure when canonical app is missing", () => {
  const exitCalls = [];
  const dialogCalls = [];

  const result = enforceNotStaleGuidedSetupAppLaunch({
    appRef: staleAppRef(exitCalls),
    dialogRef: {
      showErrorBox(title, message) {
        dialogCalls.push({ title, message });
      },
    },
    platform: "darwin",
    fsRef: {
      existsSync() {
        return false;
      },
    },
    spawnRef() {
      throw new Error("spawn should not run");
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.relaunchedCanonical, false);
  assert.deepEqual(exitCalls, [1]);
  assert.equal(dialogCalls[0].title, "Old App Copy Detected");
});

test("stale guided-setup guard is enforced before migration and window launch", () => {
  const mainSource = readRepoFile("electron-app/src/services/main.js");
  const startupMatch = mainSource.match(
    /app\s*\.whenReady\(\)\s*\.then\(async \(\) => \{([\s\S]*?)\}\)\s*\.catch/s,
  );

  assert.ok(startupMatch, "expected to locate the main startup block");
  const startupBlock = startupMatch[1];
  const staleGuardIndex = startupBlock.indexOf("enforceNotStaleGuidedSetupAppLaunch({");
  const migrationIndex = startupBlock.indexOf("await performMigrationIfNeeded()");
  const loadingWindowIndex = startupBlock.indexOf("createLoadingWindow()");
  const mainWindowIndex = startupBlock.indexOf("createMainWindow()");

  assert.ok(staleGuardIndex >= 0, "expected startup to invoke stale guided-setup guard");
  assert.ok(migrationIndex >= 0, "expected startup to perform migration cleanup");
  assert.ok(staleGuardIndex < migrationIndex, "stale guided-setup guard must run before migration");
  assert.ok(staleGuardIndex < loadingWindowIndex, "stale guard must run before loading windows");
  assert.ok(staleGuardIndex < mainWindowIndex, "stale guard must run before main windows");
});
