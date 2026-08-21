// engine-wedge-recovery.js - PORTICO-373
//
// A container engine can stop servicing requests while still accepting them: a
// container sits in `Stopping` past the deadline the daemon already SIGKILLed it
// on, and every later call blocks. We cannot repair that from inside the app, and
// nothing in our teardown code can either. What we can do is recognise it and
// restart the engine -- which is precisely what the two PORTICO-373 reporters did by
// hand (`orbctl restart -a`) after being told to in Slack.
//
// The pattern is not new here. update-preparation.js already classifies a stalled
// pull, logs "Docker stalled; restarting OrbStack...", calls the same restart
// helper and caps its attempts. This module exists so the teardown paths can use
// that same pattern instead of routing users to Terminal, and so the decision is
// testable without a real engine.
//
// Deliberate non-goal: nothing here is wired into diagnostics collection. A tool
// whose job is to explain the machine's state must not mutate it.

// A restart bounces every container in the engine, including ones this app does
// not own, so it is reserved for a probe that actually timed out. A stop that
// failed for any other reason -- a broken Compose frontend, a bad project file --
// gets no engine restart, because restarting would not fix it.
const WEDGE_PROBE_TIMEOUT_MS = 8000;

// One restart per teardown. A genuinely dead engine must not become a loop.
const MAX_ENGINE_RECOVERY_ATTEMPTS = 1;

/**
 * @typedef {Object} EngineWedgeVerdict
 * @property {boolean} wedged            Probe timed out: the engine accepts calls but does not answer.
 * @property {boolean} attempted         Whether an engine restart was started.
 * @property {boolean} recovered         Whether the engine answered again afterwards.
 * @property {string|null} method        How it was restarted ("orbctl" | "app"), when known.
 * @property {string|null} error         Why recovery did not happen or did not work.
 * @property {string} reason             Machine-readable outcome, for logs and typed failures.
 */

/**
 * Decide whether a failed teardown was an engine wedge and, if so, repair it.
 *
 * Dependencies are injected rather than required so the decision table is
 * testable: the real probe and the real restart both need a live engine.
 *
 * @param {Object} options
 * @param {{ timedOut?: boolean }} [options.stopResult] Result of the teardown that failed.
 * @param {Function} options.probeDockerDaemon          Bounded daemon probe -> { ready, timedOut }.
 * @param {Function} options.restartEngine              Engine restart -> { success, error, method }.
 * @param {Function} [options.onLog]                    (message, type) progress sink.
 * @param {Function} [options.onStatus]                 (message) status-line sink.
 * @param {string} [options.projectRoot]
 * @param {number} [options.probeTimeoutMs]
 * @returns {Promise<EngineWedgeVerdict>}
 */
async function recoverWedgedEngineAfterFailedStop({
  stopResult = null,
  probeDockerDaemon,
  restartEngine,
  onLog = null,
  onStatus = null,
  projectRoot = undefined,
  probeTimeoutMs = WEDGE_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof probeDockerDaemon !== "function") {
    throw new TypeError("probeDockerDaemon (function) is required");
  }
  if (typeof restartEngine !== "function") {
    throw new TypeError("restartEngine (function) is required");
  }

  const log = (message, type = "info") => {
    if (typeof onLog === "function") {
      onLog(message, type);
    }
  };
  const status = (message) => {
    if (typeof onStatus === "function") {
      onStatus(message);
    }
  };

  const idle = (reason, extra = {}) => ({
    wedged: false,
    attempted: false,
    recovered: false,
    method: null,
    error: null,
    reason,
    ...extra,
  });

  // Only a timeout is evidence of a wedge. An immediate non-zero exit means the
  // command ran and disagreed with us, and the engine is not the problem.
  if (!stopResult || stopResult.timedOut !== true) {
    return idle("not-a-timeout");
  }

  let probe;
  try {
    probe = await probeDockerDaemon({
      projectRoot,
      timeoutMs: probeTimeoutMs,
    });
  } catch (error) {
    // A probe that throws tells us nothing; treat it as inconclusive rather than
    // as licence to restart the engine.
    return idle("probe-failed", { error: error?.message || "probe failed" });
  }

  if (probe?.ready === true) {
    // The teardown overran its budget on a healthy engine. That is a real
    // problem, but restarting the engine is not its fix.
    return idle("engine-healthy");
  }

  if (probe?.timedOut !== true) {
    return idle("engine-unreachable-not-wedged", {
      error: probe?.error || probe?.message || null,
    });
  }

  log(
    "Container engine stopped responding; restarting it to recover...",
    "warning",
  );
  status("Repairing the container engine...");

  let lastError = null;
  let lastMethod = null;
  for (let attempt = 1; attempt <= MAX_ENGINE_RECOVERY_ATTEMPTS; attempt += 1) {
    let restart;
    try {
      restart = await restartEngine({ projectRoot, onLog, onStatus });
    } catch (error) {
      lastError = error?.message || "engine restart threw";
      continue;
    }

    lastMethod = restart?.method || lastMethod;
    if (restart?.success === true) {
      log("Container engine restarted and is responding again.", "success");
      return {
        wedged: true,
        attempted: true,
        recovered: true,
        method: lastMethod,
        error: null,
        reason: "recovered",
      };
    }
    lastError = restart?.error || "engine restart did not succeed";
  }

  return {
    wedged: true,
    attempted: true,
    recovered: false,
    method: lastMethod,
    error: lastError,
    reason: "recovery-failed",
  };
}

/**
 * Run a teardown, repairing a wedged container engine once and retrying if that
 * worked. Extracted from main.js so the retry/abort decision is testable: main.js
 * itself requires electron and cannot be loaded under `node --test`.
 *
 * The `ok` field is the whole point. Callers must not proceed to anything that
 * regenerates config or recreates containers unless it is true -- an unfinished
 * teardown is still deleting the runtime-secret cache dir that the next step
 * recreates and mounts.
 *
 * @param {Object} options
 * @param {Function} options.runStop        () => Promise<{ success, error, timedOut }>
 * @param {Function} options.recoverEngine  (stopResult) => Promise<EngineWedgeVerdict>
 * @param {Function} [options.onRetry]      Called before the retry attempt.
 * @param {number} [options.maxRetries]     Retries after a successful engine repair.
 * @returns {Promise<{ ok: boolean, stopResult: Object, engineRecovery: Object|null, attempts: number }>}
 */
async function runTeardownWithEngineRecovery({
  runStop,
  recoverEngine,
  onRetry = null,
  maxRetries = 1,
} = {}) {
  if (typeof runStop !== "function") {
    throw new TypeError("runStop (function) is required");
  }
  if (typeof recoverEngine !== "function") {
    throw new TypeError("recoverEngine (function) is required");
  }

  let attempts = 1;
  let stopResult = await runStop();
  if (stopResult?.success === true) {
    return { ok: true, stopResult, engineRecovery: null, attempts };
  }

  const engineRecovery = await recoverEngine(stopResult);

  // Retry when the engine was repaired, and ALSO when the probe found the engine
  // healthy. The second case is the slow-machine case: `docker-compose.sh stop`
  // runs two full `docker compose down` passes plus cleanup, so on a large stack a
  // healthy teardown can legitimately overrun its budget. Failing closed is right,
  // but failing closed on the FIRST overrun would turn a slow machine into a
  // blocked one -- and a retry there is cheap, because everything the first pass
  // already stopped stays stopped, so the second pass has less to do.
  //
  // Not retried: an engine that never answered. That second attempt cannot do
  // anything except burn the budget again.
  const retryIsWorthwhile =
    engineRecovery?.recovered === true ||
    engineRecovery?.reason === "engine-healthy";

  if (retryIsWorthwhile) {
    for (let retry = 0; retry < maxRetries; retry += 1) {
      if (typeof onRetry === "function") {
        onRetry();
      }
      attempts += 1;
      stopResult = await runStop();
      if (stopResult?.success === true) {
        break;
      }
    }
  }

  return {
    ok: stopResult?.success === true,
    stopResult,
    engineRecovery,
    attempts,
  };
}

module.exports = {
  MAX_ENGINE_RECOVERY_ATTEMPTS,
  WEDGE_PROBE_TIMEOUT_MS,
  recoverWedgedEngineAfterFailedStop,
  runTeardownWithEngineRecovery,
};
