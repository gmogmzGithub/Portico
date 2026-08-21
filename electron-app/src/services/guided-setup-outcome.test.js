const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGuidedSetupCompletionResult,
  normalizeGuidedSetupOutcome,
} = require("./guided-setup-outcome");

test("guided setup completion keeps all four explicit modal outcomes distinct", () => {
  const cases = [
    ["completed", { success: true, completed: true }],
    ["test_failed", { success: false, test_failed: true }],
    ["dismissed", { success: false, dismissed: true }],
    ["redirected_to_chat", { success: false, redirected_to_chat: true }],
  ];

  for (const [outcome, expected] of cases) {
    const result = buildGuidedSetupCompletionResult(
      { outcome, flow_id: "guided-1" },
      { now: () => 42 },
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.timestamp, 42);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(result[key], value, `${outcome} ${key}`);
    }
  }
});

test("legacy boolean acknowledgements remain compatible without conflating test failures", () => {
  assert.equal(normalizeGuidedSetupOutcome(undefined, true), "completed");
  assert.equal(normalizeGuidedSetupOutcome(undefined, false), "dismissed");
  assert.equal(
    normalizeGuidedSetupOutcome("test_failed", false),
    "test_failed",
  );
});

test("guided setup failure details are allowlisted and control characters are removed", () => {
  const result = buildGuidedSetupCompletionResult({
    outcome: "test_failed",
    flow_id: "guided-2",
    details: {
      errorCode: "SAVED_SECRET_UNAVAILABLE",
      configurationIssue: "saved_secret_unavailable",
      requiredAction: "replace_saved_secret",
      severity: "warning",
      message: "Saved connection unavailable\nreplace it securely.",
      recoveryPrompt:
        "My Snowflake token is broken. Help me replace it with a fresh token.",
      recoveryLabel: "Replace Snowflake connection in chat",
      ignoredContainerLogs: 'token = "MUST_NOT_ESCAPE"',
    },
  });

  assert.equal(result.errorCode, "SAVED_SECRET_UNAVAILABLE");
  assert.equal(result.configurationIssue, "saved_secret_unavailable");
  assert.equal(result.requiredAction, "replace_saved_secret");
  assert.equal(result.severity, "warning");
  assert.equal(
    result.message,
    "Saved connection unavailable replace it securely.",
  );
  assert.equal(result.recoveryLabel, "Replace Snowflake connection in chat");
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_ESCAPE/);
});
