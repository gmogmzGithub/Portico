// process-tree-termination.js - PORTICO-373
//
// Terminating a shell command means terminating its whole process tree, not the
// pid we happen to hold. `spawn("bash", ["-c", cmd])` gives us a leader; the
// command that matters is usually a grandchild. Signalling only the leader lets
// that grandchild keep running -- reparented to init, still mutating whatever it
// was mutating -- while the caller is told the command ended. That is the PORTICO-373
// defect: a stop that "timed out" was still tearing containers down while the
// restart it had blocked moved on to recreating them.
//
// Extracted from docker-mcp.js so the invariant is testable with real processes:
// docker-mcp.js requires electron and cannot be loaded under `node --test`.

// How long a tree gets to honour SIGTERM before it is SIGKILLed.
const TREE_TERMINATION_GRACE_MS = 2000;
// How often "is the tree gone yet" is re-checked while waiting.
const TREE_EXIT_POLL_INTERVAL_MS = 100;

/**
 * Is every process in this group gone?
 *
 * Tri-state on purpose. `null` means we genuinely cannot tell -- no process
 * groups (Windows) or no usable pid -- and callers must not read it as either
 * outcome. Collapsing null into true is how a surviving tree gets reported as
 * reaped.
 *
 * EPERM counts as NOT gone, which is the subtle case and was originally wrong
 * here. A group we just SIGKILLed routinely answers EPERM for a moment: the
 * descendants are dead but the leader is a zombie until its parent reaps it, and
 * zombies cannot be signalled. EPERM therefore proves a process with this group
 * id still exists, so it is evidence of survival, not of uncertainty. Treating it
 * as "cannot tell" made a caller that polls until "not false" stop one moment
 * too early and report a tree it had not yet confirmed dead.
 *
 * @param {number|undefined} pid Group leader pid (equals the pgid for a detached child).
 * @param {{ platform?: string, kill?: Function }} [deps]
 * @returns {boolean|null} true = gone, false = still there, null = cannot tell
 */
function processTreeIsGone(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  const kill = deps.kill || process.kill.bind(process);

  if (platform === "win32" || !pid) {
    return null;
  }

  try {
    kill(-pid, 0);
    return false;
  } catch (error) {
    const code = error && error.code;
    if (code === "ESRCH") {
      return true;
    }
    if (code === "EPERM") {
      return false;
    }
    return null;
  }
}

/**
 * SIGTERM the tree now, SIGKILL it if it is still there after the grace period.
 *
 * Returns the escalation timer so a caller can hold it. Callers must NOT cancel
 * it when the promise settles or the leader exits: the escalation exists for
 * descendants that outlive the leader, and cancelling it on close is precisely
 * how a "terminated" command keeps running. A late SIGKILL against an
 * already-dead group is a harmless ESRCH.
 *
 * @param {import("child_process").ChildProcess} child
 * @param {{ signalTree: Function, schedule?: Function, graceMs?: number }} deps
 * @returns {any} the scheduled escalation handle
 */
function terminateProcessTree(child, deps) {
  const { signalTree } = deps;
  const schedule = deps.schedule || setTimeout;
  const graceMs =
    typeof deps.graceMs === "number" ? deps.graceMs : TREE_TERMINATION_GRACE_MS;

  signalTree(child, "SIGTERM");
  return schedule(() => {
    signalTree(child, "SIGKILL");
  }, graceMs);
}

/**
 * Wait until the tree is provably gone, or until the window expires.
 *
 * Resolves the same tri-state as processTreeIsGone, so a caller can report
 * "confirmed gone" separately from "gave up waiting" and separately again from
 * "cannot tell on this platform".
 *
 * @param {number|undefined} pid
 * @param {{ timeoutMs: number, pollIntervalMs?: number, isGone?: Function, sleep?: Function, now?: Function }} [deps]
 * @returns {Promise<boolean|null>}
 */
async function waitForTreeExit(pid, deps = {}) {
  const timeoutMs = Number(deps.timeoutMs) || 0;
  const pollIntervalMs =
    typeof deps.pollIntervalMs === "number"
      ? deps.pollIntervalMs
      : TREE_EXIT_POLL_INTERVAL_MS;
  const isGone = deps.isGone || ((target) => processTreeIsGone(target));
  const now = deps.now || Date.now;
  const sleep =
    deps.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + timeoutMs;
  for (;;) {
    const gone = isGone(pid);
    if (gone !== false || now() >= deadline) {
      return gone;
    }
    await sleep(pollIntervalMs);
  }
}

module.exports = {
  TREE_TERMINATION_GRACE_MS,
  TREE_EXIT_POLL_INTERVAL_MS,
  processTreeIsGone,
  terminateProcessTree,
  waitForTreeExit,
};
