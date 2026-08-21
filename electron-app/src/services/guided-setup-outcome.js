const GUIDED_SETUP_OUTCOMES = new Set([
  "completed",
  "test_failed",
  "dismissed",
  "redirected_to_chat",
]);

function safeText(value, maxLength = 500) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeCode(value, pattern) {
  const normalized = safeText(value, 100);
  return normalized && pattern.test(normalized) ? normalized : null;
}

function normalizeGuidedSetupOutcome(outcome, success = false) {
  const normalized = safeText(outcome, 40);
  if (normalized && GUIDED_SETUP_OUTCOMES.has(normalized)) {
    return normalized;
  }
  return success === true ? "completed" : "dismissed";
}

function buildGuidedSetupCompletionResult(payload = {}, options = {}) {
  const details =
    payload.details && typeof payload.details === "object"
      ? payload.details
      : {};
  const outcome = normalizeGuidedSetupOutcome(
    payload.outcome,
    payload.success,
  );
  const errorCode = safeCode(
    details.errorCode || payload.errorCode,
    /^[A-Z][A-Z0-9_]*$/,
  );
  const configurationIssue = safeCode(
    details.configurationIssue || payload.configurationIssue,
    /^[a-z][a-z0-9_]*$/,
  );

  return {
    success: outcome === "completed",
    completed: outcome === "completed",
    dismissed: outcome === "dismissed",
    test_failed: outcome === "test_failed",
    redirected_to_chat: outcome === "redirected_to_chat",
    outcome,
    timestamp:
      typeof options.now === "function" ? options.now() : Date.now(),
    flow_id: safeText(payload.flow_id, 200),
    errorCode,
    configurationIssue,
    requiredAction: safeCode(
      details.requiredAction || payload.requiredAction,
      /^[a-z][a-z0-9_]*$/,
    ),
    severity: safeCode(
      details.severity || payload.severity,
      /^(?:warning|error|info)$/,
    ),
    message: safeText(details.message || payload.message),
    recoveryPrompt: safeText(
      details.recoveryPrompt || payload.recoveryPrompt,
    ),
    recoveryLabel: safeText(
      details.recoveryLabel || payload.recoveryLabel,
      160,
    ),
  };
}

module.exports = {
  GUIDED_SETUP_OUTCOMES,
  buildGuidedSetupCompletionResult,
  normalizeGuidedSetupOutcome,
};
