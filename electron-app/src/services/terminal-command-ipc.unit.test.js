const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const ipcModulePath = require.resolve("./ipc");
const originalLoad = Module._load;
const TERMINAL_RECOVERY_DONE_MESSAGE = "All done. You may now close this terminal window.";

function loadIpcModule() {
  const previousModule = require.cache[ipcModulePath];
  const handlers = new Map();
  const electronStub = {
    app: {
      getPath() {
        return "/tmp/portico-tests";
      },
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: {
      async openExternal() {
        return true;
      },
      async openPath() {
        return "";
      },
    },
    clipboard: {
      writeText() {},
    },
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
    Notification: function Notification() {},
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }

    if (parent?.filename === ipcModulePath && (request.startsWith("./") || request.startsWith("../"))) {
      return {};
    }

    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  const ipc = require("./ipc");

  return {
    ipc,
    handlers,
    restore() {
      Module._load = originalLoad;
      delete require.cache[ipcModulePath];
      if (previousModule) {
        require.cache[ipcModulePath] = previousModule;
      }
    },
  };
}

function createSpawnStub({ code = 0, stderr = "" } = {}, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stderr) {
        child.stderr.emit("data", Buffer.from(stderr));
      }
      child.emit("close", code);
    });
    return child;
  };
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terminal-command-ipc-"));
}

function cleanupTempRoot(tempRoot) {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function unquoteShellSingleQuoted(value) {
  return value.replace(/'\\''/g, "'");
}

function getRunScriptPathFromCopiedCommand(copiedCommand) {
  const match = String(copiedCommand).match(/^\/bin\/bash '(.+\/run\.command)'$/);
  assert.ok(match, `expected copied command to run a temp script, got: ${copiedCommand}`);
  return unquoteShellSingleQuoted(match[1]);
}

function readRunnerFromCopiedCommand(copiedCommand) {
  const runScriptPath = getRunScriptPathFromCopiedCommand(copiedCommand);
  const tempDir = path.dirname(runScriptPath);
  const doneMessagePath = path.join(tempDir, "done.txt");
  return {
    runScriptPath,
    tempDir,
    doneMessagePath,
    script: fs.readFileSync(runScriptPath, "utf8"),
    doneMessage: fs.readFileSync(doneMessagePath, "utf8"),
    mode: fs.statSync(runScriptPath).mode & 0o777,
  };
}

test("openTerminalWithCopiedCommand copies and starts an executable command file with LaunchServices", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const spawnCalls = [];
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("sudo -v", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn: createSpawnStub({ code: 0 }, spawnCalls),
      shell: {
        async openPath(value) {
          throw new Error(`should not fall back to ${value}`);
        },
      },
    });

    assert.deepEqual(result, {
      success: true,
      copied: true,
      terminalOpened: true,
      commandStarted: true,
    });
    assert.equal(copied.length, 1);
    assert.doesNotMatch(copied[0], /sudo -v/);
    assert.doesNotMatch(copied[0], new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));

    const runner = readRunnerFromCopiedCommand(copied[0]);
    assert.equal(runner.doneMessage, `${TERMINAL_RECOVERY_DONE_MESSAGE}\n`);
    assert.equal(runner.mode, 0o700);
    assert.match(runner.script, /sudo -v/);
    assert.match(runner.script, /cat "\$DONE_MESSAGE_FILE"/);
    assert.equal(runner.script.includes(TERMINAL_RECOVERY_DONE_MESSAGE), false);
    assert.ok(
      runner.script.indexOf("sudo -v") < runner.script.indexOf('cat "$DONE_MESSAGE_FILE"'),
      "completion message should print after the recovery command body",
    );

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "/usr/bin/open");
    assert.deepEqual(spawnCalls[0].args, [
      "-b",
      "com.apple.Terminal",
      runner.runScriptPath,
    ]);
    assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand makes one LaunchServices request without a focus pass", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const spawnCalls = [];
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("sudo -v", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn: createSpawnStub({ code: 0 }, spawnCalls),
    });

    assert.deepEqual(result, {
      success: true,
      copied: true,
      terminalOpened: true,
      commandStarted: true,
    });
    assert.equal(copied.length, 1);
    assert.equal(getRunScriptPathFromCopiedCommand(copied[0]).startsWith(tempRoot), true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "/usr/bin/open");
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand falls back to opening Terminal after command-file launch failure", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const opened = [];
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("brew --version", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn: createSpawnStub({ code: 1, stderr: "SECRET_TOKEN=do-not-log" }),
      shell: {
        async openPath(value) {
          opened.push(value);
          return "";
        },
      },
      existsSync(value) {
        return value === "/System/Applications/Utilities/Terminal.app";
      },
    });

    assert.deepEqual(result, {
      success: true,
      copied: true,
      terminalOpened: true,
      commandStarted: false,
      terminalPath: "/System/Applications/Utilities/Terminal.app",
      fallbackReason: "Terminal command launcher exited with code 1.",
    });
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN|do-not-log/);
    assert.equal(copied.length, 1);
    const runner = readRunnerFromCopiedCommand(copied[0]);
    assert.match(runner.script, /brew --version/);
    assert.equal(runner.doneMessage, `${TERMINAL_RECOVERY_DONE_MESSAGE}\n`);
    assert.deepEqual(opened, ["/System/Applications/Utilities/Terminal.app"]);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand reports Terminal launch failure after copying", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("brew --version", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn: createSpawnStub({ code: 1, stderr: "SECRET_TOKEN=do-not-log" }),
      shell: {
        async openPath() {
          return "open failed";
        },
      },
      existsSync() {
        return true;
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.copied, true);
    assert.equal(result.terminalOpened, false);
    assert.equal(result.commandStarted, false);
    assert.match(result.error, /failed to open Terminal: Terminal\.app could not be opened/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN|do-not-log|open failed/);
    assert.equal(copied.length, 1);
    assert.match(readRunnerFromCopiedCommand(copied[0]).script, /brew --version/);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand rejects clipboard failures before launching Terminal", async () => {
  const loaded = loadIpcModule();
  let spawnCount = 0;
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("sudo -v", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText() {
          throw new Error("clipboard denied");
        },
      },
      spawn() {
        spawnCount += 1;
      },
    });

    assert.deepEqual(result, {
      success: false,
      error: "Failed to copy Terminal command: clipboard denied",
    });
    assert.equal(spawnCount, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand rejects invalid commands before clipboard writes", async () => {
  const loaded = loadIpcModule();
  let copyCount = 0;
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("   ", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText() {
          copyCount += 1;
        },
      },
      spawn() {
        throw new Error("should not launch");
      },
      shell: {
        async openPath() {
          throw new Error("should not open");
        },
      },
    });

    assert.deepEqual(result, {
      success: false,
      error: "Missing Terminal command.",
    });
    assert.equal(copyCount, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand rejects oversized commands before clipboard writes", async () => {
  const loaded = loadIpcModule();
  let copyCount = 0;
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("x".repeat(64 * 1024 + 1), {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText() {
          copyCount += 1;
        },
      },
      spawn() {
        throw new Error("should not launch");
      },
    });

    assert.deepEqual(result, {
      success: false,
      error: "Terminal command is too large to copy safely.",
    });
    assert.equal(copyCount, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand preserves quoted command text only inside the private runner", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const spawnCalls = [];
  const tempRoot = createTempRoot();
  const command = `printf '%s\\n' "it's $HOME"`;

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand(command, {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn: createSpawnStub({ code: 0 }, spawnCalls),
    });

    assert.equal(result.commandStarted, true);
    assert.equal(copied.length, 1);
    assert.doesNotMatch(copied[0], /printf|HOME/);
    const runner = readRunnerFromCopiedCommand(copied[0]);
    assert.ok(runner.script.includes(command));
    assert.deepEqual(spawnCalls[0].args, [
      "-b",
      "com.apple.Terminal",
      runner.runScriptPath,
    ]);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("openTerminalWithCopiedCommand sanitizes synchronous launcher failures", async () => {
  const loaded = loadIpcModule();
  const copied = [];
  const tempRoot = createTempRoot();

  try {
    const result = await loaded.ipc._test.openTerminalWithCopiedCommand("sudo -v", {
      platform: "darwin",
      tempRoot,
      clipboard: {
        writeText(value) {
          copied.push(value);
        },
      },
      spawn() {
        const error = new Error("SECRET_TOKEN=do-not-log /private/tmp/sensitive");
        error.code = "EACCES";
        throw error;
      },
      shell: {
        async openPath() {
          return "";
        },
      },
      existsSync(value) {
        return value === "/System/Applications/Utilities/Terminal.app";
      },
    });

    assert.deepEqual(result, {
      success: true,
      copied: true,
      terminalOpened: true,
      commandStarted: false,
      terminalPath: "/System/Applications/Utilities/Terminal.app",
      fallbackReason: "Terminal command launcher failed (EACCES).",
    });
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN|do-not-log|sensitive/);
  } finally {
    cleanupTempRoot(tempRoot);
    loaded.restore();
  }
});

test("Terminal command IPC and preload bridge are wired", () => {
  const loaded = loadIpcModule();

  try {
    loaded.ipc.registerUtilityHandlers();
    assert.equal(typeof loaded.handlers.get("open-terminal-with-command"), "function");

    const repoRoot = path.resolve(__dirname, "../../..");
    const preloadSource = fs.readFileSync(
      path.join(repoRoot, "electron-app/src/services/preload.js"),
      "utf8",
    );
    assert.match(
      preloadSource,
      /openTerminalWithCommand:\s*\(command\)\s*=>\s*ipcRenderer\.invoke\('open-terminal-with-command', command\)/,
    );

    const ipcSource = fs.readFileSync(ipcModulePath, "utf8");
    assert.doesNotMatch(ipcSource, /function runTerminalAutomation\s*\(/);
    assert.match(
      ipcSource,
      /spawnImpl\(openPath, \["-b", "com\.apple\.Terminal", runScriptPath\]/,
    );
  } finally {
    loaded.restore();
  }
});
