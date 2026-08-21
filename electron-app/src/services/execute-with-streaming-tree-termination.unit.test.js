// PORTICO-373: executeWithStreaming must not lie about having ended a command.
//
// The defect: `spawn("bash", ["-c", cmd])` makes the shell the leader and the
// work that matters a descendant. On timeout the old code sent SIGTERM to the pid
// it held, told the caller "Command timed out", and moved on -- while the real
// command (e.g. `docker compose down`) kept running, reparented to init, still
// mutating container state under the restart that had waited for it. Two users
// were fully blocked by exactly that overlap.
//
// These tests drive the REAL executeWithStreaming from docker-mcp.js against REAL
// processes. A mock cannot demonstrate this bug at all: the whole question is
// which processes a signal actually reaches. docker-mcp.js requires electron, so
// it is loaded through a Module._load harness that stubs only `electron` and
// `./bootstrap`; every other dependency, including the termination path under
// test, is the real one.
//
// The fixture's descendant IGNORES SIGTERM, so a leader-only SIGTERM provably
// cannot stop it and the pre-fix behaviour surfaces as a surviving process rather
// than as a passing test.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TREE_TERMINATION_GRACE_MS } = require("./process-tree-termination");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Load the real docker-mcp under plain `node --test`.
// ---------------------------------------------------------------------------

function loadRealDockerMcp() {
  const dockerMcpModulePath = require.resolve("./docker-mcp");
  const previousDockerMcp = require.cache[dockerMcpModulePath];
  const originalLoad = Module._load;

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico373-dmcp-"));
  const projectRoot = path.join(sandboxRoot, "project");
  const appData = path.join(sandboxRoot, "appdata");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  const electronStub = {
    app: {
      getPath() {
        return appData;
      },
      getVersion() {
        return "0.0.0-test";
      },
      on() {},
      whenReady: async () => {},
    },
    ipcMain: { handle() {}, on() {} },
    shell: {},
    clipboard: {},
    dialog: {},
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
  };

  // The spawned child runs with cwd = PROJECT_ROOT, so it must be a real
  // directory; keeping it inside a temp sandbox means no test writes into the
  // repository.
  const bootstrapStub = {
    PROJECT_ROOT: projectRoot,
    SCRIPTS_DIR: path.join(projectRoot, "src", "scripts"),
    APP_SERVICES: __dirname,
    execPromise: async () => ({ stdout: "", stderr: "" }),
    sendInitLog() {},
    logToInitFile() {},
    getConfigPath() {
      return appData;
    },
    getLogPaths() {
      return {};
    },
    clearWebviewCache() {},
    getThemeIcon() {},
    updateWindowMenu() {},
  };

  // Only the Docker status poller is stubbed, so no background polling starts
  // inside the test runner. The termination path is untouched.
  const stubs = {
    "./docker-status-probe": {
      createSerialPoller: () => ({
        start() {},
        stop() {},
        trigger() {},
        poke() {},
        isRunning() {
          return false;
        },
      }),
      probeDockerStatus: async () => ({ running: false }),
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    if (request === "./bootstrap" || request === "../bootstrap") {
      return bootstrapStub;
    }
    const parentFile = parent?.filename || "";
    if (
      parentFile === dockerMcpModulePath &&
      Object.prototype.hasOwnProperty.call(stubs, request)
    ) {
      return stubs[request];
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  let dockerMcp;
  try {
    delete require.cache[dockerMcpModulePath];
    dockerMcp = require("./docker-mcp");
  } finally {
    Module._load = originalLoad;
  }

  return {
    dockerMcp,
    restore() {
      delete require.cache[dockerMcpModulePath];
      if (previousDockerMcp) {
        require.cache[dockerMcpModulePath] = previousDockerMcp;
      }
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    },
  };
}

const harness = loadRealDockerMcp();
const { executeWithStreaming } = harness.dockerMcp;
test.after(() => harness.restore());

// ---------------------------------------------------------------------------
// Process inspection. Deliberately per-pid: signalling a process GROUP would be
// meaningless (and unsafe) in the pre-fix shape, where the child shares this
// test runner's own group. `process.kill(pid, 0)` is used rather than ps/pgrep
// so the test needs nothing from the environment but Node itself.
// ---------------------------------------------------------------------------

// Does a process group with this id exist? True only when the child was spawned
// detached, because then its pgid equals its pid. EPERM counts as existing: the
// group is there, we simply may not signal it.
function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function pidIsAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !pidIsAlive(pid);
}

function killPid(pid, signal) {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch (_) {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Fixture: a command whose real work is a SIGTERM-resistant descendant.
// ---------------------------------------------------------------------------

function createStubbornCommand(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portico373-tree-"));
  const leaderScript = path.join(dir, "leader.sh");
  const descendantScript = path.join(dir, "descendant.sh");
  const descendantPidFile = path.join(dir, "descendant.pid");
  const leaderPidFile = path.join(dir, "leader.pid");

  // Stands in for `docker compose down`: ignores SIGTERM, so only SIGKILL can
  // end it. Short sleeps rather than one long one, so no stray outlives it by
  // more than a second even if it is killed mid-sleep.
  fs.writeFileSync(
    descendantScript,
    ["#!/bin/bash", "trap '' TERM", "while :; do", "  sleep 1", "done", ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );

  // The descendant's stdio goes to /dev/null so it never holds the parent's
  // pipes open: an inherited pipe would keep the promise pending and hide the
  // survival this test exists to detect.
  // Pid files are written via a rename so a reader never sees a partial value.
  fs.writeFileSync(
    leaderScript,
    [
      "#!/bin/bash",
      "trap '' TERM",
      `bash "${descendantScript}" >/dev/null 2>&1 &`,
      "descendant=$!",
      `printf '%s\\n' "$$" > "${leaderPidFile}.partial"`,
      `mv "${leaderPidFile}.partial" "${leaderPidFile}"`,
      `printf '%s\\n' "$descendant" > "${descendantPidFile}.partial"`,
      `mv "${descendantPidFile}.partial" "${descendantPidFile}"`,
      'echo "descendant=$descendant"',
      "wait",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const spawnedPids = [];

  // Runs on the pass AND the fail path, including when an assertion throws
  // before the command was ever terminated.
  t.after(async () => {
    for (const pid of spawnedPids) {
      killPid(pid, "SIGKILL");
    }
    for (const pid of spawnedPids) {
      assert.equal(
        await waitForPidExit(pid, 3000),
        true,
        `test cleanup left pid ${pid} behind`,
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function readPidFile(file, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(file, "utf8").trim();
        if (raw) {
          const pid = Number(raw);
          spawnedPids.push(pid);
          return pid;
        }
      } catch (_) {
        /* not written yet */
      }
      await sleep(25);
    }
    throw new Error(`fixture never wrote ${path.basename(file)}`);
  }

  return {
    command: "bash",
    args: [`"${leaderScript}"`],
    // Resolves once the tree is fully up: the leader and the descendant it
    // launched. Both pids are registered for cleanup as soon as they are known.
    async started(timeoutMs = 5000) {
      const leaderPid = await readPidFile(leaderPidFile, timeoutMs);
      const descendantPid = await readPidFile(descendantPidFile, timeoutMs);
      return { leaderPid, descendantPid };
    },
  };
}

function skipUnlessPosix(t) {
  if (process.platform === "win32") {
    t.skip("process-group termination is POSIX-only");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The PORTICO-373 invariant.
// ---------------------------------------------------------------------------

test("a timed-out command leaves no part of its tree running, even when the work ignores SIGTERM", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  // Default options on purpose: this is the contract every existing caller gets.
  const pending = executeWithStreaming(fixture.command, fixture.args, 400, {
    isolateProcessGroup: true,
  });
  const { descendantPid } = await fixture.started();
  assert.equal(
    pidIsAlive(descendantPid),
    true,
    "fixture descendant should be running before the timeout fires",
  );

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error, "Command timed out");
  assert.equal(result.code, -1);

  // The whole bug in one assertion: the caller has been told the command ended,
  // so nothing from that command may still be doing work. Pre-fix, this
  // descendant ran on -- reparented to init -- while the caller proceeded.
  assert.equal(
    await waitForPidExit(descendantPid, TREE_TERMINATION_GRACE_MS + 6000),
    true,
    `pid ${descendantPid} survived the timeout that reported the command as over -- the PORTICO-373 orphan`,
  );
});

test("an aborted command also takes its whole tree with it", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);
  const controller = new AbortController();

  // No timeout at all: abort is the only thing that can end this.
  const pending = executeWithStreaming(fixture.command, fixture.args, 0, {
    isolateProcessGroup: true,
    signal: controller.signal,
  });
  const { descendantPid } = await fixture.started();
  controller.abort();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.aborted, true);
  assert.equal(result.error, "Command aborted");

  assert.equal(
    await waitForPidExit(descendantPid, TREE_TERMINATION_GRACE_MS + 6000),
    true,
    `pid ${descendantPid} survived an abort that reported the command as over`,
  );
});

// ---------------------------------------------------------------------------
// The settle contract: opt-in confirmation vs. the default every caller has.
// ---------------------------------------------------------------------------

test("confirmTreeExitMs does not release the caller while the tree is still alive", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  const timeoutMs = 400;
  const startedAt = Date.now();
  const pending = executeWithStreaming(fixture.command, fixture.args, timeoutMs, {
    confirmTreeExitMs: 8000,
  });
  const { descendantPid } = await fixture.started();

  const result = await pending;
  const settledAfterMs = Date.now() - startedAt;

  assert.equal(result.success, false);
  // The tree ignores SIGTERM, so it cannot be gone before the SIGKILL
  // escalation. Settling earlier would mean the caller was released while the
  // command was still running -- the race this option exists to close, and the
  // one that let a teardown delete the runtime-secret cache under the startup
  // that followed it.
  assert.ok(
    settledAfterMs >= timeoutMs + TREE_TERMINATION_GRACE_MS,
    `settled after ${settledAfterMs}ms, before the SIGTERM grace period could even elapse`,
  );
  assert.notEqual(
    result.treeExited,
    false,
    "confirmed-exit mode must not report a tree it gave up waiting on",
  );
  assert.equal(
    await waitForPidExit(descendantPid, 2000),
    true,
    "the tree must be down by the time confirmed-exit mode settles",
  );
});

test("confirmTreeExitMs gives up at its window instead of hanging, and reports that it did", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  // Window deliberately shorter than the SIGTERM grace period, so the tree is
  // still alive when the window closes.
  const timeoutMs = 400;
  const confirmTreeExitMs = Math.floor(TREE_TERMINATION_GRACE_MS / 2);
  const startedAt = Date.now();
  const pending = executeWithStreaming(fixture.command, fixture.args, timeoutMs, {
    isolateProcessGroup: true,
    confirmTreeExitMs,
  });
  const { descendantPid } = await fixture.started();

  const result = await pending;
  const settledAfterMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(
    result.treeExited,
    false,
    "giving up on the wait must be reported as 'not confirmed gone', never as gone",
  );
  assert.ok(
    settledAfterMs >= timeoutMs + confirmTreeExitMs,
    `settled after ${settledAfterMs}ms; the confirmation window was cut short`,
  );
  // Boundedness is asserted through treeExited above, not through wall clock. The
  // tree only dies when the SIGTERM grace elapses, so `treeExited === false` proves
  // the wait returned while the tree was still alive -- i.e. the window bounded it.
  // A tight elapsed-time ceiling here was load-sensitive: it passed standalone and
  // failed under the parallel test gate, which is a property of the runner rather
  // than of the code under test.

  // Giving up on the wait must not give up on the kill.
  assert.equal(
    await waitForPidExit(descendantPid, TREE_TERMINATION_GRACE_MS + 6000),
    true,
    `pid ${descendantPid} survived a timeout whose confirmation window expired`,
  );
});

test("the default (confirmTreeExitMs 0) still settles promptly, and the tree still dies afterwards", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  const timeoutMs = 400;
  const startedAt = Date.now();
  const pending = executeWithStreaming(fixture.command, fixture.args, timeoutMs, {
    isolateProcessGroup: true,
  });
  const { descendantPid } = await fixture.started();

  const result = await pending;
  const settledAfterMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  // Prompt: the default must not start waiting on process exits. All fourteen
  // existing callers depend on the timeout returning at the timeout.
  assert.ok(
    settledAfterMs < timeoutMs + TREE_TERMINATION_GRACE_MS,
    `default mode blocked for ${settledAfterMs}ms; it must not wait for the tree`,
  );
  assert.equal(
    result.treeExited,
    false,
    "the default must report the tree as not-yet-gone rather than claim it was reaped",
  );
  assert.equal(
    pidIsAlive(descendantPid),
    true,
    "precondition: a SIGTERM-resistant tree is expected to still be up at the prompt settle",
  );

  // Settling early must not cancel the escalation. The pending SIGKILL is the
  // only thing that can end a command which ignores SIGTERM, and cancelling it
  // when the promise settles is how the orphan came back.
  assert.equal(
    await waitForPidExit(descendantPid, TREE_TERMINATION_GRACE_MS + 6000),
    true,
    "the SIGKILL escalation must still fire after the promise has settled",
  );
});

// ---------------------------------------------------------------------------
// Unchanged behaviour for commands that finish on their own.
// ---------------------------------------------------------------------------

test("a command that succeeds still resolves success with its output", async () => {
  const result = await executeWithStreaming("echo", ["portico373-ok"], 10000);

  assert.equal(result.success, true);
  assert.match(result.output, /portico373-ok/);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.aborted, undefined);
});

test("a command that exits non-zero still resolves failure with its exit code", async () => {
  const result = await executeWithStreaming(
    "bash",
    ["-c", "'echo portico373-partial; exit 7'"],
    10000,
  );

  assert.equal(result.success, false);
  assert.equal(result.code, 7);
  assert.match(result.output, /portico373-partial/);
  assert.equal(result.timedOut, undefined);
});

// PORTICO-373 risk containment: process-group isolation is opt-in, so the twelve
// callers that never needed it must be byte-identical to the pre-fix behaviour.
// These two cases are the contract that keeps the blast radius at two call sites.
test("without opting in, the child is NOT detached and only the leader is signalled", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  const pending = executeWithStreaming(fixture.command, fixture.args, 400);
  const { descendantPid, leaderPid } = await fixture.started();

  // A detached child leads a process group whose id is its own pid, so that group
  // answers signal 0. A non-detached child does not, so there is no such group.
  // Asserted through kill rather than `ps`, which is not always permitted.
  assert.equal(
    groupExists(leaderPid),
    false,
    "default callers must not get a process group of their own",
  );

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.error, "Command timed out");
  assert.equal(
    result.treeExited,
    undefined,
    "non-isolated results must not gain tree-exit reporting",
  );

  // The descendant surviving here is the OLD behaviour, preserved deliberately.
  // Fixing it for every caller would mean detaching every caller, which changes
  // parent-death and signal semantics far beyond this ticket.
  assert.equal(
    pidIsAlive(descendantPid),
    true,
    "unchanged callers keep the pre-fix outcome; only opted-in callers reap the tree",
  );
});

test("opting in changes exactly that: the child leads its own group", async (t) => {
  if (skipUnlessPosix(t)) {
    return;
  }
  const fixture = createStubbornCommand(t);

  const pending = executeWithStreaming(fixture.command, fixture.args, 400, {
    isolateProcessGroup: true,
  });
  const { leaderPid } = await fixture.started();

  assert.equal(
    groupExists(leaderPid),
    true,
    "an isolated child leads its own signalable process group",
  );

  await pending;
});
