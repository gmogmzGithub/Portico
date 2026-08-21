function normalizeRetryCount(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

function buildQueuedFullHealthRetryPlan(options = {}) {
  const maxRetries = Math.max(
    0,
    normalizeRetryCount(options.maxRetries ?? 1),
  );
  const previousRetryCount = normalizeRetryCount(options.retryCount);
  const nextRetryCount = previousRetryCount + 1;

  if (nextRetryCount > maxRetries) {
    return {
      shouldRetry: false,
      retryCount: previousRetryCount,
      nextReasons: [],
    };
  }

  return {
    shouldRetry: true,
    retryCount: nextRetryCount,
    nextReasons: ["retry-on-demand"],
  };
}

module.exports = {
  buildQueuedFullHealthRetryPlan,
  normalizeRetryCount,
};
