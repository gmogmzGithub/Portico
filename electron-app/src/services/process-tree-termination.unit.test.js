// PORTICO-373: behavioural coverage for process-group termination.
//
// The bug this guards: a timed-out command reported "Command timed out" while the
// work it launched kept running. `spawn("bash", ["-c", cmd])` leaves the real
// command as a grandchild, so signalling the pid we hold stops the shell and
// nothing else. For `docker compose down` that meant containers were still being
// torn down while the restart that had waited on it moved on to recreating them.
//
// These tests use REAL processes with a SIGTERM-resistant descendant, because a
// mocked child cannot demonstrate the failure at all: the whole defect is about
// which processes a signal actually reaches.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  processTreeIsGone,
  terminateProcessTree,
  waitForTreeExit,
} = require("./process-tree-termination");
const { signalProcessTree } = require("./managed-process");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStubbornScript(dir) {
  // Ignores SIGTERM and keeps a long-lived child. A leader-only SIGTERM cannot
  // stop this; only a group SIGKILL can.
  const scriptPath = path.join(dir, "stubborn.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/bash",
      "trap '' TERM",
      // Redirect so the descendant does not hold the parent's stdio open, which
      // would mask survival behind a pipe that never closes.
      "sleep 120 >/dev/null 2>&1 &",
      "echo \"descendant=$!\"",
      "wait",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return scriptPath;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function spawnStubbornTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portico373-tree-"));
  const scriptPath = makeStubbornScript(dir);

  const child = spawn("bash", ["-c", `bash "${scriptPath}"`], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let descendantPid = null;
  child.stdout.on("data", (chunk) => {
    const match = String(chunk).match(/descendant=(\d+)/);
    if (match) {
      descendantPid = Number(match[1]);
    }
  });

  // Never leave strays behind, on pass or fail.
  t.after(() => {
    try {
      signalProcessTree(child, "SIGKILL");
    } catch (_) {
      /* already gone */
    }
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (_) {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5000;
  while (descendantPid === null && Date.now() < deadline) {
    await sleep(25);
  }
  assert.notEqual(descendantPid, null, "stubborn tree never reported its descendant");
  return { child, descendantPid };
}

test("a terminated tree leaves nothing running, even when the command ignores SIGTERM", async (t) => {
  if (process.platform === "win32") {
    t.skip("process groups are POSIX-only");
    return;
  }
  const { child, descendantPid } = await spawnStubbornTree(t);

  assert.equal(pidIsAlive(descendantPid), true, "descendant should start alive");
  assert.equal(
    processTreeIsGone(child.pid),
    false,
    "a live tree must not report itself gone",
  );

  terminateProcessTree(child, { signalTree: signalProcessTree, graceMs: 300 });
  const gone = await waitForTreeExit(child.pid, { timeoutMs: 8000 });

  assert.equal(gone, true, "the process group must be provably gone");
  assert.equal(
    pidIsAlive(descendantPid),
    false,
    "the SIGTERM-resistant descendant must not survive termination",
  );
});

test("waiting reports not-gone when the tree outlives the window", async (t) => {
  if (process.platform === "win32") {
    t.skip("process groups are POSIX-only");
    return;
  }
  const { child } = await spawnStubbornTree(t);

  // No termination at all: the wait must give up rather than claim success.
  const gone = await waitForTreeExit(child.pid, {
    timeoutMs: 300,
    pollIntervalMs: 50,
  });
  assert.equal(gone, false, "an untouched live tree must report false, not true");
});

test("group termination reaches a descendant that a leader-only signal cannot", async (t) => {
  if (process.platform === "win32") {
    t.skip("process groups are POSIX-only");
    return;
  }
  const { child, descendantPid } = await spawnStubbornTree(t);

  // Exactly what the pre-fix code did: signal the pid we hold, nothing else.
  child.kill("SIGTERM");
  await sleep(700);

  assert.equal(
    pidIsAlive(descendantPid),
    true,
    "leader-only SIGTERM is expected to leave the descendant running -- this is the PORTICO-373 defect being guarded",
  );

  // Now the fix's behaviour.
  terminateProcessTree(child, { signalTree: signalProcessTree, graceMs: 200 });
  assert.equal(
    await waitForTreeExit(child.pid, { timeoutMs: 8000 }),
    true,
    "group termination must finish what the leader-only signal could not",
  );
  assert.equal(pidIsAlive(descendantPid), false);
});

test("gone-ness is tri-state so 'cannot tell' is never read as 'reaped'", () => {
  assert.equal(processTreeIsGone(undefined), null, "no pid means unknown");
  assert.equal(
    processTreeIsGone(1234, { platform: "win32" }),
    null,
    "Windows has no process groups here; must be unknown, not gone",
  );
  assert.equal(
    processTreeIsGone(1234, {
      platform: "darwin",
      kill: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
    }),
    true,
  );
  assert.equal(
    processTreeIsGone(1234, { platform: "darwin", kill: () => undefined }),
    false,
    "something answered, so the tree is not gone",
  );
  assert.equal(
    processTreeIsGone(1234, {
      platform: "darwin",
      kill: () => {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      },
    }),
    false,
    "EPERM proves a process with this group id exists (typically a not-yet-reaped zombie), so it is NOT gone",
  );
  assert.equal(
    processTreeIsGone(1234, {
      platform: "darwin",
      kill: () => {
        const error = new Error("something else");
        error.code = "EINVAL";
        throw error;
      },
    }),
    null,
    "an unexpected errno really is unknown",
  );
});

test("escalation to SIGKILL is scheduled, not immediate", () => {
  const signals = [];
  const scheduled = [];
  const handle = terminateProcessTree(
    { pid: 4321 },
    {
      signalTree: (_child, signal) => signals.push(signal),
      schedule: (fn, ms) => {
        scheduled.push(ms);
        return { fn };
      },
      graceMs: 1500,
    },
  );

  assert.deepEqual(signals, ["SIGTERM"], "SIGTERM first, alone");
  assert.deepEqual(scheduled, [1500], "SIGKILL deferred by the grace period");

  handle.fn();
  assert.deepEqual(
    signals,
    ["SIGTERM", "SIGKILL"],
    "the escalation must signal the group, not just the leader",
  );
});
