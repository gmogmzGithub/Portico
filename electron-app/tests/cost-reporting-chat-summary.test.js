const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..", "..");
const costReportingPath = path.join(
  repoRoot,
  "electron-app",
  "src",
  "services",
  "cost-reporting.js",
);

let currentUserDataPath = "";

const electronStub = {
  app: {
    getPath(name) {
      if (name === "userData") {
        return currentUserDataPath;
      }
      return "";
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return electronStub;
  }
  return originalLoad.apply(this, arguments);
};

function loadCostReporting(reportingPath) {
  currentUserDataPath = reportingPath;
  process.env.PORTICO_REPORTING_DIR = reportingPath;
  delete require.cache[costReportingPath];
  return require(costReportingPath);
}

function makeTempReportingPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cost-reporting-chat-summary-"));
}

function writeEvent(eventsDir, filename, event) {
  fs.writeFileSync(path.join(eventsDir, filename), JSON.stringify(event, null, 2));
}

function makeEvent(overrides = {}) {
  return {
    eventId: "chat-1:message-1:call-1",
    turnId: "chat-1:message-1",
    callId: "call-1",
    chatId: "chat-1",
    messageId: "message-1",
    modelId: "Claude Opus 4.6",
    modelName: "Claude Opus 4.6",
    source: "bifrost-bridge",
    completedAt: Date.now(),
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      cost: 0.01,
    },
    ...overrides,
  };
}

function assertClose(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

async function testChatCostSummarySumsAllCallsForOneChat() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(
    eventsDir,
    "chat-1-call-1.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      turnId: "chat-1:message-1",
      callId: "call-1",
      chatId: "chat-1",
      messageId: "message-1",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.01,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "chat-1-call-2.json",
    makeEvent({
      eventId: "chat-1:message-1:call-2",
      turnId: "chat-1:message-1",
      callId: "call-2",
      chatId: "chat-1",
      messageId: "message-1",
      completedAt: Date.now() + 1,
      usage: {
        prompt_tokens: 250,
        completion_tokens: 25,
        cost: 0.025,
      },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatCostSummary({ chatIds: ["chat-1"] });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.chatIds, ["chat-1"]);
  assert.equal(result.data.eventCount, 2);
  assert.equal(result.data.summary.promptTokens, 350);
  assert.equal(result.data.summary.completionTokens, 35);
  assert.equal(result.data.summary.responses, 2);
  assert.equal(result.data.summary.modelCount, 1);
  assertClose(result.data.summary.totalCost, 0.035);
}

async function testChatCostSummaryAggregatesRequestedWorkflowChatsOnly() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(
    eventsDir,
    "root-call.json",
    makeEvent({
      eventId: "root:msg-1:call-1",
      turnId: "root:msg-1",
      callId: "call-1",
      chatId: "root",
      messageId: "msg-1",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.01,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "child-call.json",
    makeEvent({
      eventId: "child:msg-2:call-2",
      turnId: "child:msg-2",
      callId: "call-2",
      chatId: "child",
      messageId: "msg-2",
      modelId: "GPT-5.4",
      modelName: "GPT-5.4",
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        cost: 0.02,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "grandchild-call.json",
    makeEvent({
      eventId: "grandchild:msg-3:call-3",
      turnId: "grandchild:msg-3",
      callId: "call-3",
      chatId: "grandchild",
      messageId: "msg-3",
      usage: {
        prompt_tokens: 300,
        completion_tokens: 30,
        cost: 0.03,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "other-call.json",
    makeEvent({
      eventId: "other:msg-9:call-9",
      turnId: "other:msg-9",
      callId: "call-9",
      chatId: "other",
      messageId: "msg-9",
      usage: {
        prompt_tokens: 900,
        completion_tokens: 90,
        cost: 0.09,
      },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatCostSummary({
    chatIds: ["root", "child", "grandchild", "root"],
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.chatIds, ["root", "child", "grandchild"]);
  assert.equal(result.data.eventCount, 3);
  assert.equal(result.data.summary.promptTokens, 600);
  assert.equal(result.data.summary.completionTokens, 60);
  assert.equal(result.data.summary.responses, 3);
  assert.equal(result.data.summary.modelCount, 2);
  assertClose(result.data.summary.totalCost, 0.06);
}

async function testReloadsOverwrittenExistingEventFiles() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const eventPath = path.join(eventsDir, "event.json");
  writeEvent(
    eventsDir,
    "event.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      turnId: "chat-1:message-1",
      callId: "call-1",
      chatId: "chat-1",
      messageId: "message-1",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.01,
      },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const initial = await costReporting.getDashboard({ range: "all" });
  assert.equal(initial.success, true);
  assert.equal(initial.data.filtered.summary.promptTokens, 100);
  assertClose(initial.data.filtered.summary.totalCost, 0.01);

  fs.writeFileSync(
    eventPath,
    JSON.stringify(
      makeEvent({
        eventId: "chat-1:message-1:call-1",
        turnId: "chat-1:message-1",
        callId: "call-1",
        chatId: "chat-1",
        messageId: "message-1",
        completedAt: Date.now() + 5000,
        usage: {
          prompt_tokens: 900,
          completion_tokens: 99,
          cost: 0.09,
        },
      }),
      null,
      2,
    ),
  );

  const refreshed = await costReporting.getDashboard({ range: "all" });
  assert.equal(refreshed.success, true);
  assert.equal(refreshed.data.filtered.summary.promptTokens, 900);
  assert.equal(refreshed.data.filtered.summary.completionTokens, 99);
  assertClose(refreshed.data.filtered.summary.totalCost, 0.09);

  const summary = await costReporting.getChatCostSummary({ chatIds: ["chat-1"] });
  assert.equal(summary.success, true);
  assert.equal(summary.data.eventCount, 1);
  assert.equal(summary.data.summary.promptTokens, 900);
  assertClose(summary.data.summary.totalCost, 0.09);
}

async function testChatTurnSummaryUsesPeakPromptTokensAcrossVisibleTurnRequests() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(
    eventsDir,
    "turn-call-1.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      turnId: "chat-1:message-1",
      callId: "call-1",
      chatId: "chat-1",
      messageId: "message-1",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        cost: 0.01,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "turn-call-2.json",
    makeEvent({
      eventId: "chat-1:message-1:call-2",
      turnId: "chat-1:message-1",
      callId: "call-2",
      chatId: "chat-1",
      messageId: "message-1",
      completedAt: Date.now() + 1,
      usage: {
        prompt_tokens: 250,
        completion_tokens: 25,
        cost: 0.025,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "other-message.json",
    makeEvent({
      eventId: "chat-1:message-2:call-1",
      turnId: "chat-1:message-2",
      callId: "call-1",
      chatId: "chat-1",
      messageId: "message-2",
      completedAt: Date.now() + 2,
      usage: {
        prompt_tokens: 999,
        completion_tokens: 99,
        cost: 0.099,
      },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatTurnSummary({
    chatId: "chat-1",
    messageId: "message-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.chatId, "chat-1");
  assert.equal(result.data.messageId, "message-1");
  assert.equal(result.data.eventCount, 2);
  assert.equal(result.data.summary.promptTokens, 250);
  // Legacy events carry no context estimate: contextTokens falls back to
  // the peak billed prompt tokens.
  assert.equal(result.data.summary.contextTokens, 250);
  assert.equal(result.data.summary.requestCount, 2);
}

async function testChatTurnSummaryPrefersLatestContextEstimateOverBilledPeak() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  // Pro-mode shape: billed prompt_tokens aggregates hidden internal passes
  // (913k for a ~60k context); the bridge-side estimate carries occupancy.
  writeEvent(
    eventsDir,
    "pro-call-1.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      turnId: "chat-1:message-1",
      callId: "call-1",
      modelId: "GPT-5.6 Sol Pro",
      modelName: "GPT-5.6 Sol Pro",
      completedAt: Date.now(),
      contextTokensEstimate: 60000,
      usage: {
        prompt_tokens: 913410,
        completion_tokens: 11175,
        cost: 1.73,
      },
    }),
  );
  writeEvent(
    eventsDir,
    "pro-call-2.json",
    makeEvent({
      eventId: "chat-1:message-1:call-2",
      turnId: "chat-1:message-1",
      callId: "call-2",
      modelId: "GPT-5.6 Sol Pro",
      modelName: "GPT-5.6 Sol Pro",
      completedAt: Date.now() + 1,
      contextTokensEstimate: 61000,
      usage: {
        prompt_tokens: 450000,
        completion_tokens: 8977,
        cost: 1.63,
      },
    }),
  );
  // A trailing event without the estimate (e.g. older bridge build) must not
  // reset the gauge to the billed figure.
  writeEvent(
    eventsDir,
    "pro-call-3.json",
    makeEvent({
      eventId: "chat-1:message-1:call-3",
      turnId: "chat-1:message-1",
      callId: "call-3",
      modelId: "GPT-5.6 Sol Pro",
      modelName: "GPT-5.6 Sol Pro",
      completedAt: Date.now() + 2,
      usage: {
        prompt_tokens: 480000,
        completion_tokens: 500,
        cost: 0.4,
      },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatTurnSummary({
    chatId: "chat-1",
    messageId: "message-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.summary.requestCount, 3);
  // Spend metric stays the billed peak; occupancy uses the latest estimate.
  assert.equal(result.data.summary.promptTokens, 913410);
  assert.equal(result.data.summary.contextTokens, 61000);
}

async function testDuplicateEventMergeKeepsContextEstimate() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(
    eventsDir,
    "dup-a.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      contextTokensEstimate: 61000,
      usage: { prompt_tokens: 913410, completion_tokens: 100, cost: 1.0 },
    }),
  );
  // Duplicate of the same request (same eventId) without the estimate field
  // must not wipe it during the merge.
  writeEvent(
    eventsDir,
    "dup-b.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      completedAt: Date.now() + 5,
      usage: { prompt_tokens: 913410, completion_tokens: 120, cost: 1.1 },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatTurnSummary({
    chatId: "chat-1",
    messageId: "message-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.summary.requestCount, 1);
  assert.equal(result.data.summary.contextTokens, 61000);
}

async function testChatTurnSummaryClampsInflatedLegacyEstimateToBilledPeak() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  // Event written before the bridge priced base64 payloads correctly: the
  // chars/4 estimate counted a screenshot's 1.1M-char data URL as ~286k
  // tokens on top of a real ~82k prompt. Occupancy can never exceed the
  // turn's peak billed prompt, so the read-side clamp corrects persisted
  // history without rewriting the events store.
  writeEvent(
    eventsDir,
    "image-call-1.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      contextTokensEstimate: 369611,
      usage: { prompt_tokens: 82349, completion_tokens: 75, cost: 0.17 },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatTurnSummary({
    chatId: "chat-1",
    messageId: "message-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.summary.promptTokens, 82349);
  assert.equal(result.data.summary.contextTokens, 82349);
}

async function testChatTurnSummaryClampUsesTurnPeakWithLegacyEstimatelessEvents() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  // Estimate-less legacy round with the turn's billed peak...
  writeEvent(
    eventsDir,
    "mixed-call-1.json",
    makeEvent({
      eventId: "chat-1:message-1:call-1",
      completedAt: Date.now(),
      usage: { prompt_tokens: 100000, completion_tokens: 40, cost: 0.2 },
    }),
  );
  // ...followed by an image-inflated estimate: the clamp ceiling is the
  // turn's peak billed prompt, not the same event's billed figure.
  writeEvent(
    eventsDir,
    "mixed-call-2.json",
    makeEvent({
      eventId: "chat-1:message-1:call-2",
      callId: "call-2",
      completedAt: Date.now() + 1,
      contextTokensEstimate: 369611,
      usage: { prompt_tokens: 82349, completion_tokens: 75, cost: 0.17 },
    }),
  );

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getChatTurnSummary({
    chatId: "chat-1",
    messageId: "message-1",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.summary.requestCount, 2);
  assert.equal(result.data.summary.promptTokens, 100000);
  assert.equal(result.data.summary.contextTokens, 100000);
}

async function main() {
  await testChatCostSummarySumsAllCallsForOneChat();
  console.log("PASS chat cost summary sums all backend calls for one chat");

  await testChatCostSummaryAggregatesRequestedWorkflowChatsOnly();
  console.log("PASS chat cost summary aggregates only requested workflow chats");

  await testReloadsOverwrittenExistingEventFiles();
  console.log("PASS cost reporting reloads overwritten event files");

  await testChatTurnSummaryUsesPeakPromptTokensAcrossVisibleTurnRequests();
  console.log("PASS chat turn summary reports peak prompt tokens for the visible turn");

  await testChatTurnSummaryPrefersLatestContextEstimateOverBilledPeak();
  console.log("PASS chat turn summary prefers latest context estimate over billed peak");

  await testDuplicateEventMergeKeepsContextEstimate();
  console.log("PASS duplicate event merge keeps the context estimate");

  await testChatTurnSummaryClampsInflatedLegacyEstimateToBilledPeak();
  console.log("PASS chat turn summary clamps inflated legacy estimates to the billed peak");

  await testChatTurnSummaryClampUsesTurnPeakWithLegacyEstimatelessEvents();
  console.log("PASS chat turn summary clamp uses the turn peak with estimate-less events");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
