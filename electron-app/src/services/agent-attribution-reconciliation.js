// Coordinates the bounded, app-owned attribution repair after core services
// become healthy. The Rust Subagents server owns model mutation; Electron owns
// authenticated identity, the strict Marketplace registry, and pending-link
// finalization.

const SUBAGENTS_SERVER_ID = "subagents";
const SUBAGENTS_PORT = 8766;
const RECONCILE_TOOL = "subagents_reconcile_agent_attribution";
const DEFAULT_TIMEOUT_MS = 15_000;

let inFlight = null;
let completedWithoutFailures = false;
let scheduledTimer = null;

function taggedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        taggedError(
          `Agent attribution reconciliation timed out after ${timeoutMs}ms.`,
          "agent_attribution_timeout",
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))].sort();
}

async function reconcileAgentAttribution(options = {}) {
  if (inFlight) return await inFlight;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const invokeMcpTool =
    options.invokeMcpTool || require("./docker-mcp").invokeMcpTool;
  const linkDeps =
    options.agentLinkDeps && typeof options.agentLinkDeps === "object"
      ? options.agentLinkDeps
      : {};

  inFlight = withTimeout(
    (async () => {
      const result = await invokeMcpTool(
        SUBAGENTS_SERVER_ID,
        RECONCILE_TOOL,
        {},
        SUBAGENTS_PORT,
      );
      if (!result?.success) {
        throw taggedError(
          result?.error || "Agent attribution reconciliation failed.",
          result?.code || "agent_attribution_failed",
        );
      }
      const data = result?.data && typeof result.data === "object" ? result.data : {};
      const finalizedPendingIds = normalizeIds(data.finalized_pending_ids);
      for (const agentId of finalizedPendingIds) {
        await require("./ai-marketplace-agent-links").finalizeAttribution(
          agentId,
          linkDeps,
        );
      }

      const repairedIds = normalizeIds(data.repaired_ids);
      const sourceBackfilledIds = normalizeIds(data.source_backfilled_ids);
      const marketplaceAdoptedIds = normalizeIds(data.marketplace_adopted_ids);
      const skippedIds = normalizeIds(data.skipped_ids);
      const failures = Array.isArray(data.failures) ? data.failures : [];
      const failedIds = normalizeIds(failures.map((entry) => entry?.id));
      console.log("[AgentAttribution] reconciliation completed", {
        repairedCount: repairedIds.length,
        repairedIds,
        sourceBackfilledIds,
        marketplaceAdoptedIds,
        skippedCount: skippedIds.length,
        skippedIds,
        finalizedPendingCount: finalizedPendingIds.length,
        finalizedPendingIds,
        failedCount: failedIds.length,
        failedIds,
      });
      if (failures.length) {
        const error = taggedError(
          `Agent attribution reconciliation had ${failures.length} partial failure(s).`,
          "agent_attribution_partial_failure",
        );
        error.result = data;
        throw error;
      }
      completedWithoutFailures = true;
      return data;
    })(),
    timeoutMs,
  ).finally(() => {
    inFlight = null;
  });
  return await inFlight;
}

function scheduleAgentAttributionReconciliation(options = {}) {
  if (completedWithoutFailures || inFlight || scheduledTimer) return false;
  const delayMs =
    Number.isFinite(options.delayMs) && options.delayMs >= 0 ? options.delayMs : 0;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    void reconcileAgentAttribution(options).catch((error) => {
      console.warn("[AgentAttribution] reconciliation deferred", {
        code: error?.code || "agent_attribution_failed",
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
  completedWithoutFailures = false;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  RECONCILE_TOOL,
  SUBAGENTS_PORT,
  SUBAGENTS_SERVER_ID,
  reconcileAgentAttribution,
  resetForTests,
  scheduleAgentAttributionReconciliation,
};
