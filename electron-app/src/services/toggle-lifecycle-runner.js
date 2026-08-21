function runToggleLifecycle(task, options = {}) {
  if (typeof task !== "function") {
    throw new TypeError("task (function) is required");
  }

  const background = Boolean(options.background);
  const onSuccess =
    typeof options.onSuccess === "function" ? options.onSuccess : () => undefined;
  const onError =
    typeof options.onError === "function" ? options.onError : () => undefined;
  const logger = options.logger || console;
  const label = options.label || "toggle lifecycle";

  if (!background) {
    return task()
      .then(async (result) => {
        await onSuccess(result);
        return { queued: false, result };
      })
      .catch(async (error) => {
        await onError(error);
        throw error;
      });
  }

  Promise.resolve()
    .then(task)
    .then(onSuccess)
    .catch(async (error) => {
      try {
        await onError(error);
      } finally {
        logger.error(`[IPC] Background ${label} failed: ${error.message}`);
      }
    });

  return Promise.resolve({ queued: true });
}

module.exports = {
  runToggleLifecycle,
};
