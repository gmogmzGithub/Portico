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
  return fs.mkdtempSync(path.join(os.tmpdir(), "cost-reporting-backend-events-"));
}

function writeEvent(eventsDir, filename, event) {
  fs.writeFileSync(path.join(eventsDir, filename), JSON.stringify(event, null, 2));
}

function assertClose(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

async function testBackendEventFilesAreLoadedWithoutRendererWrites() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  writeEvent(eventsDir, "event-1.json", {
    eventId: "chat-1:message-1:call-1",
    turnId: "chat-1:message-1",
    callId: "call-1",
    chatId: "chat-1",
    messageId: "message-1",
    modelId: "Atlas Opus 4.6",
    modelName: "Atlas Opus 4.6",
    source: "bifrost-bridge",
    completedAt: Date.now(),
    usage: {
      prompt_tokens: 1234,
      completion_tokens: 56,
      cached_tokens: 789,
      cost: 0.12,
    },
  });

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all" });
  assert.equal(result.success, true);
  assert.equal(result.data.filtered.eventCount, 1);
  assert.equal(result.data.filtered.summary.promptTokens, 1234);
  assert.equal(result.data.filtered.summary.completionTokens, 56);
  assert.equal(result.data.filtered.models[0].modelName, "Atlas Opus 4.6");
  assert.equal(result.data.reportingPath, reportingPath);
}

async function testBackendEventsForSameVisibleTurnAreSummedPerCall() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(eventsDir, "event-1.json", {
    eventId: "chat-1:message-1:call-1",
    turnId: "chat-1:message-1",
    callId: "call-1",
    chatId: "chat-1",
    messageId: "message-1",
    modelId: "GPT-5.4",
    modelName: "GPT-5.4",
    source: "bifrost-bridge",
    completedAt: Date.now(),
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      cache_read_input_tokens: 80,
    },
  });
  writeEvent(eventsDir, "event-2.json", {
    eventId: "chat-1:message-1:call-2",
    turnId: "chat-1:message-1",
    callId: "call-2",
    chatId: "chat-1",
    messageId: "message-1",
    modelId: "GPT-5.4",
    modelName: "GPT-5.4",
    source: "bifrost-bridge",
    completedAt: Date.now() + 1,
    usage: {
      prompt_tokens: 120,
      completion_tokens: 11,
      cache_read_input_tokens: 90,
    },
  });

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all" });
  assert.equal(result.success, true);
  assert.equal(result.data.filtered.eventCount, 2);
  assert.equal(result.data.filtered.summary.promptTokens, 220);
  assert.equal(result.data.filtered.summary.completionTokens, 21);
  assert.equal(result.data.filtered.summary.cacheReadTokens, 170);
}

async function testChatSummaryPrefersTranslatedBifrostEventsOverProviderRawDuplicates() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(eventsDir, "sonnet-translated.json", {
    eventId: "chat-live:msg-sonnet:call-ui-sonnet",
    turnId: "chat-live:msg-sonnet",
    callId: "call-ui-sonnet",
    chatId: "chat-live",
    messageId: "msg-sonnet",
    modelId: "Atlas Sonnet 4.6",
    modelName: "Atlas Sonnet 4.6",
    source: "bifrost-bridge",
    upstreamRequestId: "upstream-sonnet",
    completedAt: Date.now(),
    usage: {
      prompt_tokens: 41625,
      completion_tokens: 549,
      total_tokens: 42174,
      cost: 0.17678,
      prompt_tokens_details: {
        cached_tokens: 41616,
        cached_write_tokens: 41616,
      },
    },
  });
  writeEvent(eventsDir, "sonnet-provider-raw.json", {
    eventId: "chat-live:msg-sonnet:call-provider-sonnet",
    turnId: "chat-live:msg-sonnet",
    callId: "call-provider-sonnet",
    chatId: "chat-live",
    messageId: "msg-sonnet",
    modelId: "us.anthropic.atlas-sonnet-4-6",
    modelName: "us.anthropic.atlas-sonnet-4-6",
    source: "bifrost-bridge",
    upstreamRequestId: "upstream-sonnet",
    completedAt: Date.now() + 1,
    usage: {
      input_tokens: 9,
      output_tokens: 549,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 41616,
    },
  });
  writeEvent(eventsDir, "haiku-translated.json", {
    eventId: "chat-live:msg-haiku:call-ui-haiku",
    turnId: "chat-live:msg-haiku",
    callId: "call-ui-haiku",
    chatId: "chat-live",
    messageId: "msg-haiku",
    modelId: "Atlas Haiku 4.5",
    modelName: "Atlas Haiku 4.5",
    source: "bifrost-bridge",
    upstreamRequestId: "upstream-haiku",
    completedAt: Date.now() + 2,
    usage: {
      prompt_tokens: 798,
      completion_tokens: 25,
      total_tokens: 823,
      cost: 0.00093,
      prompt_tokens_details: {
        cached_tokens: 0,
      },
    },
  });
  writeEvent(eventsDir, "haiku-provider-raw.json", {
    eventId: "chat-live:msg-haiku:call-provider-haiku",
    turnId: "chat-live:msg-haiku",
    callId: "call-provider-haiku",
    chatId: "chat-live",
    messageId: "msg-haiku",
    modelId: "us.anthropic.atlas-haiku-4-5-20251001-v1:0",
    modelName: "us.anthropic.atlas-haiku-4-5-20251001-v1:0",
    source: "bifrost-bridge",
    upstreamRequestId: "upstream-haiku",
    completedAt: Date.now() + 3,
    usage: {
      input_tokens: 798,
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

  const costReporting = loadCostReporting(reportingPath);
  const summaryResult = await costReporting.getChatCostSummary({ chatIds: ["chat-live"] });

  assert.equal(summaryResult.success, true);
  assert.equal(summaryResult.data.eventCount, 2);
  assert.equal(summaryResult.data.summary.modelCount, 2);
  assert.equal(summaryResult.data.summary.promptTokens, 42423);
  assert.equal(summaryResult.data.summary.completionTokens, 574);
  assert.equal(summaryResult.data.summary.cachedTokens, 0);
  assert.equal(summaryResult.data.summary.cacheReadTokens, 0);
  assert.equal(summaryResult.data.summary.cacheWriteTokens, 41616);
  assertClose(summaryResult.data.summary.totalCost, 0.17771);
  assertClose(summaryResult.data.summary.estimatedCostWithoutCache, 0.146498);
  assertClose(summaryResult.data.summary.netCacheSavings, -0.031212);

  const dashboardResult = await costReporting.getDashboard({ range: "all" });
  assert.equal(dashboardResult.success, true);
  assert.equal(dashboardResult.data.filtered.eventCount, 2);
  assert.equal(dashboardResult.data.filtered.models.length, 2);
  assert.equal(dashboardResult.data.filtered.summary.cacheReadTokens, 0);
  assert.equal(dashboardResult.data.filtered.summary.cacheWriteTokens, 41616);
  assertClose(dashboardResult.data.filtered.summary.totalCost, 0.17771);
  assertClose(dashboardResult.data.filtered.summary.netCacheSavings, -0.031212);
}

async function main() {
  await testBackendEventFilesAreLoadedWithoutRendererWrites();
  await testBackendEventsForSameVisibleTurnAreSummedPerCall();
  await testChatSummaryPrefersTranslatedBifrostEventsOverProviderRawDuplicates();
  console.log("PASS backend event files populate dashboard without renderer writes");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
