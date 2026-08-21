// PORTICO-373 - behavioural coverage for the wedged-engine decision table.
//
// recoverWedgedEngineAfterFailedStop takes its probe and its engine restart as
// injected functions precisely so this table can be exercised without a live
// container engine. Every case here drives the REAL module and asserts both the
// verdict it returns and which injected function it actually called: an engine
// restart bounces containers this app does not own, so "restartEngine was never
// invoked" is a safety property, not an implementation detail.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_ENGINE_RECOVERY_ATTEMPTS,
  WEDGE_PROBE_TIMEOUT_MS,
  recoverWedgedEngineAfterFailedStop,
} = require("./engine-wedge-recovery");

// Recording fakes: each keeps every call's arguments so a test can assert on the
// call count (zero included) and on what the module passed down.
function recordingProbe(behaviour) {
  const calls = [];
  const probe = async (options) => {
    calls.push(options);
    if (typeof behaviour === "function") {
      return behaviour(options);
    }
    return behaviour;
  };
  probe.calls = calls;
  return probe;
}

function recordingRestart(behaviour) {
  const calls = [];
  const restart = async (options) => {
    calls.push(options);
    if (typeof behaviour === "function") {
      return behaviour(options);
    }
    return behaviour;
  };
  restart.calls = calls;
  return restart;
}

const TIMED_OUT_STOP = { success: false, error: "Command timed out", timedOut: true };

test("a stop result of null is not treated as a wedge and never restarts the engine", async () => {
  const probe = recordingProbe({ ready: false, timedOut: true });
  const restartEngine = recordingRestart({ success: true });

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: null,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.wedged, false);
  assert.equal(verdict.attempted, false);
  assert.equal(verdict.recovered, false);
  assert.equal(verdict.reason, "not-a-timeout");
  assert.equal(verdict.method, null);
  assert.equal(verdict.error, null);
  // No probe and no restart: an absent stop result is no evidence of anything.
  assert.equal(probe.calls.length, 0);
  assert.equal(restartEngine.calls.length, 0);
});

test("a stop that failed without timing out never restarts the engine", async () => {
  // The PORTICO-373 safety property: a broken Compose frontend or a bad project file
  // makes the stop fail immediately, and bouncing the engine would not fix it
  // while it would kill every unrelated container the user is running.
  const nonTimeoutFailures = [
    { success: false, error: "no configuration file provided" },
    { success: false, error: "boom", timedOut: false },
    { success: false, error: "stringly typed", timedOut: "true" },
  ];

  for (const stopResult of nonTimeoutFailures) {
    const probe = recordingProbe({ ready: false, timedOut: true });
    const restartEngine = recordingRestart({ success: true });

    const verdict = await recoverWedgedEngineAfterFailedStop({
      stopResult,
      probeDockerDaemon: probe,
      restartEngine,
    });

    assert.equal(verdict.wedged, false, JSON.stringify(stopResult));
    assert.equal(verdict.attempted, false, JSON.stringify(stopResult));
    assert.equal(verdict.reason, "not-a-timeout", JSON.stringify(stopResult));
    assert.equal(probe.calls.length, 0, JSON.stringify(stopResult));
    assert.equal(restartEngine.calls.length, 0, JSON.stringify(stopResult));
  }
});

test("a timed-out stop against a healthy engine probes but does not restart", async () => {
  const probe = recordingProbe({ ready: true });
  const restartEngine = recordingRestart({ success: true });

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.reason, "engine-healthy");
  assert.equal(verdict.wedged, false);
  assert.equal(verdict.attempted, false);
  assert.equal(verdict.recovered, false);
  assert.equal(probe.calls.length, 1);
  assert.equal(restartEngine.calls.length, 0);
});

test("a probe that throws is inconclusive: no restart, and its message is surfaced", async () => {
  const probe = recordingProbe(() => {
    throw new Error("docker context inspect exploded");
  });
  const restartEngine = recordingRestart({ success: true });

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.reason, "probe-failed");
  assert.equal(verdict.wedged, false);
  assert.equal(verdict.attempted, false);
  assert.equal(verdict.error, "docker context inspect exploded");
  assert.equal(probe.calls.length, 1);
  assert.equal(restartEngine.calls.length, 0);
});

test("an engine that answers 'not ready' without timing out is not a wedge", async () => {
  const probe = recordingProbe({
    ready: false,
    timedOut: false,
    error: "Cannot connect to the Docker daemon",
  });
  const restartEngine = recordingRestart({ success: true });

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.reason, "engine-unreachable-not-wedged");
  assert.equal(verdict.wedged, false);
  assert.equal(verdict.attempted, false);
  assert.equal(verdict.error, "Cannot connect to the Docker daemon");
  assert.equal(probe.calls.length, 1);
  assert.equal(restartEngine.calls.length, 0);
});

test("a probe timeout restarts the engine and reports recovery with the method used", async () => {
  const probe = recordingProbe({ ready: false, timedOut: true });
  const restartEngine = recordingRestart({ success: true, method: "orbctl" });
  const logs = [];
  const statuses = [];

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
    onLog: (message, type) => logs.push({ message, type }),
    onStatus: (message) => statuses.push(message),
    projectRoot: "/tmp/portico-373-project",
  });

  assert.deepEqual(verdict, {
    wedged: true,
    attempted: true,
    recovered: true,
    method: "orbctl",
    error: null,
    reason: "recovered",
  });
  assert.equal(probe.calls.length, 1);
  assert.equal(restartEngine.calls.length, 1);
  assert.equal(restartEngine.calls[0].projectRoot, "/tmp/portico-373-project");
  // The user is told the engine is being repaired rather than left on a silent
  // stall, which is the whole reason this path exists.
  assert.ok(logs.length > 0, "expected the recovery to log progress");
  assert.ok(statuses.length > 0, "expected the recovery to set a status line");
});

test("a restart that reports failure yields recovery-failed and propagates its error", async () => {
  const probe = recordingProbe({ ready: false, timedOut: true });
  const restartEngine = recordingRestart({
    success: false,
    error: "orbctl restart -a exited 1",
    method: "orbctl",
  });

  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.wedged, true);
  assert.equal(verdict.attempted, true);
  assert.equal(verdict.recovered, false);
  assert.equal(verdict.reason, "recovery-failed");
  assert.equal(verdict.error, "orbctl restart -a exited 1");
  assert.equal(verdict.method, "orbctl");
  assert.equal(restartEngine.calls.length, MAX_ENGINE_RECOVERY_ATTEMPTS);
});

test("a restart that throws does not escape to the caller", async () => {
  const probe = recordingProbe({ ready: false, timedOut: true });
  const restartEngine = recordingRestart(() => {
    throw new Error("orbctl not installed");
  });

  // The caller is a teardown path that must still be able to fail closed with a
  // real verdict; an exception here would take the whole initialization down.
  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: probe,
    restartEngine,
  });

  assert.equal(verdict.wedged, true);
  assert.equal(verdict.attempted, true);
  assert.equal(verdict.recovered, false);
  assert.equal(verdict.reason, "recovery-failed");
  assert.equal(verdict.error, "orbctl not installed");
  assert.equal(restartEngine.calls.length, MAX_ENGINE_RECOVERY_ATTEMPTS);
});

test("the engine is never restarted more than MAX_ENGINE_RECOVERY_ATTEMPTS times", async () => {
  // A genuinely dead engine must not become a restart loop, whichever way the
  // restart reports its failure.
  const behaviours = [
    { success: false, error: "still wedged" },
    {},
    null,
    () => {
      throw new Error("threw every time");
    },
  ];

  for (const behaviour of behaviours) {
    const probe = recordingProbe({ ready: false, timedOut: true });
    const restartEngine = recordingRestart(behaviour);

    const verdict = await recoverWedgedEngineAfterFailedStop({
      stopResult: TIMED_OUT_STOP,
      probeDockerDaemon: probe,
      restartEngine,
    });

    assert.equal(verdict.recovered, false);
    assert.equal(verdict.reason, "recovery-failed");
    assert.ok(
      restartEngine.calls.length <= MAX_ENGINE_RECOVERY_ATTEMPTS,
      "restartEngine was called " +
        restartEngine.calls.length +
        " times, over the cap of " +
        MAX_ENGINE_RECOVERY_ATTEMPTS,
    );
    assert.equal(restartEngine.calls.length, MAX_ENGINE_RECOVERY_ATTEMPTS);
    // Absolute bound as well as agreement with the exported constant: each
    // restart bounces every container in the engine, so what matters to the user
    // is the real number of bounces, not that the loop matches whatever the cap
    // happens to say. Raising the cap must not silently become a retry storm.
    assert.ok(
      restartEngine.calls.length <= 2,
      "expected at most one or two engine restarts per teardown, got " +
        restartEngine.calls.length,
    );
  }
});

test("the probe is called with the timeout it was given, and with the default otherwise", async () => {
  const explicitProbe = recordingProbe({ ready: true });
  await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: explicitProbe,
    restartEngine: recordingRestart({ success: true }),
    projectRoot: "/tmp/portico-373-project",
    probeTimeoutMs: 1234,
  });

  assert.equal(explicitProbe.calls.length, 1);
  assert.equal(explicitProbe.calls[0].timeoutMs, 1234);
  assert.equal(explicitProbe.calls[0].projectRoot, "/tmp/portico-373-project");

  // The probe must always be bounded: with no override it still gets a finite
  // timeout, because an unbounded probe would hang on the very engine it is
  // trying to diagnose.
  const defaultProbe = recordingProbe({ ready: true });
  await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: defaultProbe,
    restartEngine: recordingRestart({ success: true }),
  });

  assert.equal(defaultProbe.calls.length, 1);
  assert.equal(defaultProbe.calls[0].timeoutMs, WEDGE_PROBE_TIMEOUT_MS);
  assert.equal(typeof WEDGE_PROBE_TIMEOUT_MS, "number");
  assert.ok(WEDGE_PROBE_TIMEOUT_MS > 0);
});

test("onLog and onStatus are optional on the path that would use them", async () => {
  // The recovery path logs and sets a status; omitting both sinks must not throw,
  // because one caller (the update-apply path) has no status line to write to.
  const verdict = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: recordingProbe({ ready: false, timedOut: true }),
    restartEngine: recordingRestart({ success: true, method: "app" }),
  });

  assert.equal(verdict.reason, "recovered");
  assert.equal(verdict.method, "app");

  // Non-function sinks are ignored rather than called.
  const nonFunctionSinks = await recoverWedgedEngineAfterFailedStop({
    stopResult: TIMED_OUT_STOP,
    probeDockerDaemon: recordingProbe({ ready: false, timedOut: true }),
    restartEngine: recordingRestart({ success: true, method: "app" }),
    onLog: "not a function",
    onStatus: 42,
  });

  assert.equal(nonFunctionSinks.reason, "recovered");
});

test("a missing probe or a missing restart is rejected as a TypeError", async () => {
  await assert.rejects(
    () =>
      recoverWedgedEngineAfterFailedStop({
        stopResult: TIMED_OUT_STOP,
        restartEngine: recordingRestart({ success: true }),
      }),
    TypeError,
  );

  await assert.rejects(
    () =>
      recoverWedgedEngineAfterFailedStop({
        stopResult: TIMED_OUT_STOP,
        probeDockerDaemon: recordingProbe({ ready: true }),
      }),
    TypeError,
  );

  // The guards run before the decision table, so even a stop result that would
  // short-circuit to "not-a-timeout" cannot slip past them.
  await assert.rejects(
    () => recoverWedgedEngineAfterFailedStop({ stopResult: null }),
    TypeError,
  );
  await assert.rejects(() => recoverWedgedEngineAfterFailedStop(), TypeError);
});
