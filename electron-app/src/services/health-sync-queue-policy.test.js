const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQueuedFullHealthRetryPlan,
  normalizeRetryCount,
} = require("./health-sync-queue-policy");

test("normalizeRetryCount floors invalid values to zero", () => {
  assert.equal(normalizeRetryCount(undefined), 0);
  assert.equal(normalizeRetryCount(null), 0);
  assert.equal(normalizeRetryCount("nope"), 0);
  assert.equal(normalizeRetryCount(-5), 0);
  assert.equal(normalizeRetryCount("2"), 2);
});

test("buildQueuedFullHealthRetryPlan retries until the configured ceiling", () => {
  const first = buildQueuedFullHealthRetryPlan({
    retryCount: 0,
    maxRetries: 1,
  });
  assert.deepEqual(first, {
    shouldRetry: true,
    retryCount: 1,
    nextReasons: ["retry-on-demand"],
  });

  const second = buildQueuedFullHealthRetryPlan({
    retryCount: first.retryCount,
    maxRetries: 1,
  });
  assert.deepEqual(second, {
    shouldRetry: false,
    retryCount: 1,
    nextReasons: [],
  });
});

test("buildQueuedFullHealthRetryPlan supports disabling retries entirely", () => {
  const plan = buildQueuedFullHealthRetryPlan({
    retryCount: 0,
    maxRetries: 0,
  });
  assert.deepEqual(plan, {
    shouldRetry: false,
    retryCount: 0,
    nextReasons: [],
  });
});
