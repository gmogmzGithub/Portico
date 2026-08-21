const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSensitiveInfoRequest,
  normalizeSensitiveInfoVisualAids,
  buildSensitiveInfoSubmittedResult,
  buildSensitiveInfoDismissedResult,
  buildSensitiveInfoTimeoutResult,
  buildSensitiveInfoCancelledResult,
  buildSensitiveInfoErrorResult,
  sanitizeSensitiveInfoResultForStorage,
} = require("./sensitive-info-flows");
const state = require("./shared-state");

test("normalizeSensitiveInfoRequest validates and normalizes the modal payload", () => {
  const normalized = normalizeSensitiveInfoRequest({
    chat_id: " chat-1 ",
    prompt: " Enter the API key. ",
    preamble: " 1. Open the provider settings.\n2. Generate a key. ",
    label: " API key ",
    placeholder: " Paste key ",
    timeout_seconds: 120,
  });

  assert.deepEqual(normalized, {
    chatId: "chat-1",
    prompt: "Enter the API key.",
    preamble: "1. Open the provider settings.\n2. Generate a key.",
    label: "API key",
    placeholder: "Paste key",
    timeoutSeconds: 120,
    visualAids: null,
  });
});

test("normalizeSensitiveInfoVisualAids keeps only workspace-hosted image entries", () => {
  const workspaceUrl =
    "http://localhost:9876/workspace/chat-1/skill-assets/snowflake-setup/generate-token-page.png";
  const normalized = normalizeSensitiveInfoVisualAids([
    { step: 2, image_url: ` ${workspaceUrl} `, alt: " Generate token page " },
    { step: 3, image_url: "https://evil.example.com/steal.png" },
    { step: 0, image_url: workspaceUrl },
    { step: 21, image_url: workspaceUrl },
    { step: "4", image_url: workspaceUrl },
    { step: 5, image_url: `http://127.0.0.1:9876/workspace/chat-1/x.png` },
    "not-an-object",
  ]);

  assert.deepEqual(normalized, [
    { step: 2, image_url: workspaceUrl, alt: "Generate token page" },
    {
      step: 5,
      image_url: "http://127.0.0.1:9876/workspace/chat-1/x.png",
      alt: null,
    },
  ]);
});

test("normalizeSensitiveInfoVisualAids caps entries and returns null when empty", () => {
  assert.equal(normalizeSensitiveInfoVisualAids(undefined), null);
  assert.equal(normalizeSensitiveInfoVisualAids("nope"), null);
  assert.equal(normalizeSensitiveInfoVisualAids([]), null);
  assert.equal(
    normalizeSensitiveInfoVisualAids([
      { step: 1, image_url: "https://remote.example.com/a.png" },
    ]),
    null,
  );

  const many = Array.from({ length: 12 }, (_unused, index) => ({
    step: index + 1,
    image_url: `http://localhost:9876/workspace/chat-1/${index}.png`,
  }));
  assert.equal(normalizeSensitiveInfoVisualAids(many).length, 8);

  const normalizedRequest = normalizeSensitiveInfoRequest({
    chat_id: "chat-1",
    prompt: "Need a key",
    visual_aids: [
      { step: 1, image_url: "http://localhost:9876/workspace/chat-1/a.png" },
    ],
  });
  assert.deepEqual(normalizedRequest.visualAids, [
    {
      step: 1,
      image_url: "http://localhost:9876/workspace/chat-1/a.png",
      alt: null,
    },
  ]);
});

test("sensitive info cancelled result is terminal and value-free", () => {
  const cancelled = buildSensitiveInfoCancelledResult(
    { flowId: "flow-1" },
    "tool_timeout",
  );
  assert.equal(cancelled.success, false);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.flow_id, "flow-1");
  assert.match(cancelled.error, /cancelled before the user responded \(tool_timeout\)/);
  assert.ok(!("sensitive_value" in cancelled));

  const noReason = buildSensitiveInfoCancelledResult({ flowId: "flow-2" });
  assert.doesNotMatch(noReason.error, /\(\)/);
});

test("normalizeSensitiveInfoRequest keeps preamble optional and bounded", () => {
  const withoutPreamble = normalizeSensitiveInfoRequest({
    chat_id: "chat-1",
    prompt: "Need a key",
  });
  const blankPreamble = normalizeSensitiveInfoRequest({
    chat_id: "chat-1",
    prompt: "Need a key",
    preamble: "   ",
  });

  assert.equal(withoutPreamble.preamble, null);
  assert.equal(blankPreamble.preamble, null);
  assert.throws(
    () =>
      normalizeSensitiveInfoRequest({
        chat_id: "chat-1",
        prompt: "Need a key",
        preamble: "x".repeat(4001),
      }),
    /preamble must be 4000 characters or fewer/,
  );
});

test("normalizeSensitiveInfoRequest rejects missing required fields and bad timeouts", () => {
  assert.throws(
    () => normalizeSensitiveInfoRequest({ prompt: "Need a key" }),
    /chat_id is required/,
  );
  assert.throws(
    () => normalizeSensitiveInfoRequest({ chat_id: "chat-1" }),
    /prompt is required/,
  );
  assert.throws(
    () =>
      normalizeSensitiveInfoRequest({
        chat_id: "chat-1",
        prompt: "Need a key",
        timeout_seconds: 10,
      }),
    /timeout_seconds must be between 30 and 3600/,
  );
});

test("sensitive info submitted result carries value only in memory", () => {
  const flowEntry = { flowId: "flow-1" };
  const submitted = buildSensitiveInfoSubmittedResult(flowEntry, "secret-value");

  assert.deepEqual(submitted, {
    success: true,
    status: "submitted",
    flow_id: "flow-1",
    sensitive_value: "secret-value",
    message: "Sensitive information submitted.",
  });

  assert.deepEqual(sanitizeSensitiveInfoResultForStorage(submitted), {
    success: true,
    status: "submitted",
    flow_id: "flow-1",
    sensitive_value: null,
    sensitive_value_consumed: true,
    message: "Sensitive information submitted.",
  });
});

test("sensitive info dismissed timeout and error results do not include values", () => {
  const flowEntry = { flowId: "flow-1" };

  assert.deepEqual(buildSensitiveInfoDismissedResult(flowEntry), {
    success: false,
    status: "dismissed",
    flow_id: "flow-1",
    error: "User dismissed the sensitive information modal",
    message: "The user dismissed the sensitive information modal without submitting a value.",
  });
  assert.deepEqual(buildSensitiveInfoTimeoutResult(flowEntry), {
    success: false,
    status: "timeout",
    flow_id: "flow-1",
    error: "User did not submit sensitive information before the modal timed out",
    message: "The sensitive information modal timed out before the user submitted a value.",
  });
  assert.deepEqual(buildSensitiveInfoErrorResult(flowEntry, "bad"), {
    success: false,
    status: "error",
    flow_id: "flow-1",
    error: "bad",
    message: "bad",
  });
});

test("shared sensitive info lifecycle stores active flow until completion", () => {
  const flowId = "sensitive-test-flow";
  state.sensitiveInfoFlowResults.delete(flowId);

  const entry = state.startSensitiveInfoFlow({
    flowId,
    status: "in_progress",
    chatId: "chat-1",
    prompt: "Need a key",
    timeoutSeconds: 120,
    result: null,
    startedAt: Date.now(),
    completedAt: null,
    timeoutHandle: null,
    cleanupHandle: null,
  });
  assert.equal(state.sensitiveInfoFlowResults.get(flowId), entry);

  state.completeSensitiveInfoFlow(flowId, {
    success: true,
    status: "submitted",
    flow_id: flowId,
    sensitive_value: "secret-value",
  });
  const completed = state.sensitiveInfoFlowResults.get(flowId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.sensitive_value, "secret-value");

  if (completed.cleanupHandle) {
    clearTimeout(completed.cleanupHandle);
  }
  state.sensitiveInfoFlowResults.delete(flowId);
});
