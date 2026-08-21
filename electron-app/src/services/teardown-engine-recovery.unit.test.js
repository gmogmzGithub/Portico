// PORTICO-373: behavioural coverage for runTeardownWithEngineRecovery.
//
// This is the decision that PORTICO-373 got wrong. The old code ran the teardown,
// logged a warning when it failed, and continued into config generation and
// service startup — so an engine hiccup became a stalled restart, and the
// unfinished teardown's runtime-secret cleanup raced the recreation that followed.
//
// The property under test is `ok`: it must be true only when a teardown actually
// succeeded, because the caller uses it to decide whether it may touch config,
// secrets or containers at all.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runTeardownWithEngineRecovery,
} = require("./engine-wedge-recovery");

const stop = (overrides = {}) => ({
  success: false,
  error: "Command timed out",
  timedOut: true,
  ...overrides,
});

function recorder(results) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    fn: async (...args) => {
      calls.push(args);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
}

test("a clean teardown proceeds and never touches the container engine", async () => {
  const runStop = recorder([{ success: true }]);
  const recoverEngine = recorder([{}]);

  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: recoverEngine.fn,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.engineRecovery, null);
  assert.equal(
    recoverEngine.calls.length,
    0,
    "a successful stop must not probe or restart the engine",
  );
});

test("a repaired engine earns exactly one retry, and success proceeds", async () => {
  let attempt = 0;
  const runStop = {
    calls: [],
    fn: async () => {
      attempt += 1;
      runStop.calls.push(attempt);
      return attempt === 1 ? stop() : { success: true };
    },
  };
  const retries = [];

  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: async () => ({ wedged: true, recovered: true, reason: "recovered" }),
    onRetry: () => retries.push("retried"),
  });

  assert.equal(outcome.ok, true, "the retry succeeded, so the restart may continue");
  assert.equal(outcome.attempts, 2);
  assert.equal(runStop.calls.length, 2, "exactly one retry, not a loop");
  assert.deepEqual(retries, ["retried"], "the retry is announced to the user once");
});

test("an unrepaired engine is not retried and does not proceed", async () => {
  const runStop = recorder([stop()]);

  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: async () => ({
      wedged: true,
      recovered: false,
      reason: "recovery-failed",
      error: "Docker did not become ready",
    }),
  });

  assert.equal(outcome.ok, false, "must fail closed");
  assert.equal(
    runStop.calls.length,
    1,
    "retrying a stop against an engine that never answered only burns the budget twice",
  );
  assert.equal(outcome.engineRecovery.error, "Docker did not become ready");
});

test("a stop that fails without a wedge does not proceed either", async () => {
  const runStop = recorder([stop({ timedOut: false, error: "compose exited 1" })]);
  const recoverEngine = recorder([
    { wedged: false, recovered: false, reason: "not-a-timeout" },
  ]);

  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: recoverEngine.fn,
  });

  assert.equal(outcome.ok, false);
  assert.equal(runStop.calls.length, 1);
  assert.equal(outcome.engineRecovery.reason, "not-a-timeout");
});

test("a retry that also fails still fails closed", async () => {
  const runStop = recorder([stop(), stop()]);

  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: async () => ({ wedged: true, recovered: true, reason: "recovered" }),
  });

  assert.equal(outcome.ok, false, "a repaired engine is not permission to continue");
  assert.equal(outcome.attempts, 2);
  assert.equal(runStop.calls.length, 2, "still capped at one retry");
});

test("the failed stop result is carried out, so the user can be told what happened", async () => {
  const outcome = await runTeardownWithEngineRecovery({
    runStop: async () => stop({ error: "Managed runtime stop timed out." }),
    recoverEngine: async () => ({ wedged: true, recovered: false }),
  });

  assert.equal(outcome.stopResult.error, "Managed runtime stop timed out.");
  assert.equal(outcome.stopResult.timedOut, true);
});

test("the recovery hook receives the failed stop result it must classify", async () => {
  const seen = [];
  await runTeardownWithEngineRecovery({
    runStop: async () => stop({ error: "boom" }),
    recoverEngine: async (failedStop) => {
      seen.push(failedStop);
      return { wedged: false, recovered: false };
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].error, "boom");
  assert.equal(
    seen[0].timedOut,
    true,
    "timedOut must reach the classifier — it is the only evidence of a wedge",
  );
});

test("maxRetries of zero never retries", async () => {
  const runStop = recorder([stop()]);
  const outcome = await runTeardownWithEngineRecovery({
    runStop: runStop.fn,
    recoverEngine: async () => ({ wedged: true, recovered: true }),
    maxRetries: 0,
  });

  assert.equal(runStop.calls.length, 1);
  assert.equal(outcome.ok, false);
});

test("missing dependencies fail loudly rather than silently skipping the teardown", async () => {
  await assert.rejects(
    () => runTeardownWithEngineRecovery({ recoverEngine: async () => ({}) }),
    /runStop/,
  );
  await assert.rejects(
    () => runTeardownWithEngineRecovery({ runStop: async () => ({ success: true }) }),
    /recoverEngine/,
  );
  await assert.rejects(() => runTeardownWithEngineRecovery(), /runStop/);
});

test("a slow teardown on a healthy engine is retried, not failed outright", async () => {
  // The regression risk this change introduces: docker-compose.sh stop runs two
  // full `docker compose down` passes, so a big healthy stack can overrun 60s.
  // Failing closed on the first overrun would block slow machines that previously
  // limped through, so a healthy engine earns the same one retry -- and the second
  // pass has less to do, because whatever stopped stays stopped.
  let attempt = 0;
  const outcome = await runTeardownWithEngineRecovery({
    runStop: async () => {
      attempt += 1;
      return attempt === 1 ? stop() : { success: true };
    },
    recoverEngine: async () => ({
      wedged: false,
      recovered: false,
      reason: "engine-healthy",
    }),
  });

  assert.equal(attempt, 2, "a healthy-but-slow stop deserves a second window");
  assert.equal(outcome.ok, true);
});

test("an engine that never answered is still not retried", async () => {
  let attempt = 0;
  const outcome = await runTeardownWithEngineRecovery({
    runStop: async () => {
      attempt += 1;
      return stop();
    },
    recoverEngine: async () => ({
      wedged: false,
      recovered: false,
      reason: "engine-unreachable-not-wedged",
    }),
  });

  assert.equal(attempt, 1, "a second stop against a dead engine only wastes the budget");
  assert.equal(outcome.ok, false);
});
