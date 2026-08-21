// Bounded coordinator for idempotent skills-user attribution/canonicalization.
// There is deliberately no one-time completion marker: partial failures and
// temporarily unavailable identity are retried after later successful health
// syncs and before subsequent Control Plane scans.

const DEFAULT_TIMEOUT_MS = 15_000;

let inFlight = null;
let scheduledTimer = null;

function taggedError(message, code, result = undefined) {
  const error = new Error(message);
  error.code = code;
  if (result !== undefined) error.result = result;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        taggedError(
          `User-skill reconciliation timed out after ${timeoutMs}ms.`,
          "user_skill_reconciliation_timeout",
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function sortedIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort();
}

async function reconcileUserSkills(options = {}) {
  if (inFlight) return await inFlight;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const reconcile =
    options.reconcile || require("./user-skill-service").reconcileUserSkills;

  inFlight = withTimeout(
    (async () => {
      const result = await reconcile({
        projectRoot: options.projectRoot,
        identity: options.identity,
      });
      const repairedIds = sortedIds(result?.repaired_ids);
      const skippedIds = sortedIds(result?.skipped_ids);
      const failedIds = sortedIds((result?.failures || []).map((failure) => failure?.id));
      console.log("[UserSkills] reconciliation completed", {
        repairedCount: repairedIds.length,
        repairedIds,
        skippedCount: skippedIds.length,
        skippedIds,
        failedCount: failedIds.length,
        failedIds,
      });
      if (failedIds.length) {
        throw taggedError(
          `User-skill reconciliation had ${failedIds.length} partial failure(s).`,
          "user_skill_reconciliation_partial_failure",
          result,
        );
      }
      return result;
    })(),
    timeoutMs,
  ).finally(() => {
    inFlight = null;
  });
  return await inFlight;
}

function scheduleUserSkillReconciliation(options = {}) {
  if (inFlight || scheduledTimer) return false;
  const delayMs =
    Number.isFinite(options.delayMs) && options.delayMs >= 0 ? options.delayMs : 0;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    void reconcileUserSkills(options).catch((error) => {
      console.warn("[UserSkills] reconciliation deferred", {
        code: error?.code || "user_skill_reconciliation_failed",
      });
    });
  }, delayMs);
  scheduledTimer.unref?.();
  return true;
}

function resetForTests() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
  inFlight = null;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  reconcileUserSkills,
  resetForTests,
  scheduleUserSkillReconciliation,
};
