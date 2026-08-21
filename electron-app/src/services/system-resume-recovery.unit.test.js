const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectNetworkSessions,
  handleSystemResume,
} = require("./system-resume-recovery");

function createSession(name, calls, options = {}) {
  return {
    async clearHostResolverCache() {
      calls.push(`clear:${name}`);
      if (options.reject) {
        throw new Error(`${name} failed`);
      }
    },
  };
}

test("collectNetworkSessions includes WebContentsView sessions and de-duplicates them", () => {
  const calls = [];
  const defaultSession = createSession("default", calls);
  const owuiSession = createSession("owui", calls);
  const sessions = collectNetworkSessions({
    defaultSession,
    browserWindows: [
      { isDestroyed: () => false, webContents: { session: defaultSession } },
      { isDestroyed: () => true, webContents: { session: owuiSession } },
    ],
    webContentsEntries: [
      { isDestroyed: () => false, session: owuiSession },
      { isDestroyed: () => false, session: owuiSession },
    ],
  });

  assert.deepEqual(sessions, [defaultSession, owuiSession]);
});

test("system resume clears every live session before renderer recovery and health refresh", async () => {
  const calls = [];
  const warnings = [];
  const defaultSession = createSession("default", calls);
  const owuiSession = createSession("owui", calls, { reject: true });

  const result = await handleSystemResume({
    defaultSession,
    browserWindows: [
      { isDestroyed: () => false, webContents: { session: defaultSession } },
    ],
    webContentsEntries: [
      { isDestroyed: () => false, session: owuiSession },
    ],
    resumePrerequisites(payload) {
      calls.push(`prerequisites:${payload.reason}`);
    },
    notifyRenderers(payload) {
      calls.push(`notify:${payload.reason}`);
    },
    async refreshHealth(payload) {
      calls.push(`health:${payload.reason}`);
    },
    now: () => Date.parse("2026-07-12T16:30:00.000Z"),
    logger: {
      warn(...args) {
        warnings.push(args.join(" "));
      },
    },
  });

  assert.deepEqual(calls, [
    "prerequisites:system-resume",
    "clear:default",
    "clear:owui",
    "notify:system-resume",
    "health:system-resume",
  ]);
  assert.equal(result.clearedSessionCount, 2);
  assert.equal(result.resolverCacheTimedOut, false);
  assert.equal(result.resumedAt, "2026-07-12T16:30:00.000Z");
  assert.equal(warnings.some((line) => line.includes("owui failed")), true);
});

test("system resume wiring probes quietly instead of forcing a webview rebuild", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const chatSource = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "components", "chat-tab.js"),
    "utf8",
  );
  const resumeBlockStart = mainSource.indexOf('powerMonitor.on("resume"');
  const resumeBlockEnd = mainSource.indexOf("windows.setDependencies", resumeBlockStart);
  const resumeBlock = mainSource.slice(resumeBlockStart, resumeBlockEnd);

  assert.match(mainSource, /webContents\.getAllWebContents\(\)/);
  assert.match(resumeBlock, /sendToAllWindows\("system-resumed", payload\)/);
  assert.doesNotMatch(resumeBlock, /force-webview-recovery/);
  assert.match(mainSource, /reason:\s*"system-resume"/);
  assert.match(preloadSource, /onSystemResume:[\s\S]*ipcRenderer\.on\('system-resumed'/);
  assert.match(chatSource, /SYSTEM_RESUME_PROBE_DELAY_MS = 3000/);
  assert.match(chatSource, /probeVisibleWebviewAfterSystemResume/);
  assert.match(chatSource, /allowAutoReload: false/);
});

test("transient wake status cannot tear down chat or steal focus", () => {
  const controlPlaneSource = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "components", "control-plane.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const statusStart = controlPlaneSource.indexOf("function updateDockerStatus(status)");
  const statusEnd = controlPlaneSource.indexOf("function updateEnvSummary", statusStart);
  const statusBlock = controlPlaneSource.slice(statusStart, statusEnd);
  const focusStart = ipcSource.indexOf('ipcMain.handle("owui-focus-view"');
  const focusEnd = ipcSource.indexOf('ipcMain.handle("owui-capture-page"', focusStart);
  const focusBlock = ipcSource.slice(focusStart, focusEnd);

  assert.doesNotMatch(statusBlock, /state\.chatLoaded\s*=\s*false/);
  assert.doesNotMatch(statusBlock, /webview\.src\s*=\s*['"]{2}/);
  assert.match(focusBlock, /!ownerWindow\.isFocused\(\)/);
  assert.match(focusBlock, /skipped:\s*"window-not-focused"/);
});
