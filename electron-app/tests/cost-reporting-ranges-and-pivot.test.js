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
  return fs.mkdtempSync(path.join(os.tmpdir(), "cost-reporting-ranges-pivot-"));
}

function writeEvent(eventsDir, filename, event) {
  fs.writeFileSync(
    path.join(eventsDir, filename),
    JSON.stringify(event, null, 2),
  );
}

function makeEvent(overrides = {}) {
  return {
    eventId: `chat-1:msg-1`,
    chatId: "chat-1",
    messageId: "msg-1",
    modelId: "Atlas Opus 4.6",
    modelName: "Atlas Opus 4.6",
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

// -- Feature 1: 1h and 4h ranges --

async function testOneHourRangeReturnsRecentEventsOnly() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  const thirtyMinAgo = now - 30 * 60 * 1000;
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  writeEvent(eventsDir, "recent.json", makeEvent({
    eventId: "chat-1:msg-recent",
    messageId: "msg-recent",
    completedAt: thirtyMinAgo,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "old-2h.json", makeEvent({
    eventId: "chat-1:msg-2h",
    messageId: "msg-2h",
    completedAt: twoHoursAgo,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));
  writeEvent(eventsDir, "old-1d.json", makeEvent({
    eventId: "chat-1:msg-1d",
    messageId: "msg-1d",
    completedAt: oneDayAgo,
    usage: { prompt_tokens: 300, completion_tokens: 30, cost: 0.03 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "1h" });

  assert.equal(result.success, true);
  assert.equal(result.data.filters.range, "1h");
  assert.equal(result.data.filters.granularity, "hour");
  assert.equal(result.data.filtered.eventCount, 1);
  assert.equal(result.data.filtered.summary.promptTokens, 100);
}

async function testFourHourRangeReturnsRecentEventsOnly() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  const oneHourAgo = now - 1 * 60 * 60 * 1000;
  const threeHoursAgo = now - 3 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  writeEvent(eventsDir, "recent-1h.json", makeEvent({
    eventId: "chat-1:msg-1h",
    messageId: "msg-1h",
    completedAt: oneHourAgo,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "recent-3h.json", makeEvent({
    eventId: "chat-1:msg-3h",
    messageId: "msg-3h",
    completedAt: threeHoursAgo,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));
  writeEvent(eventsDir, "old-1d.json", makeEvent({
    eventId: "chat-1:msg-1d",
    messageId: "msg-1d",
    completedAt: oneDayAgo,
    usage: { prompt_tokens: 300, completion_tokens: 30, cost: 0.03 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "4h" });

  assert.equal(result.success, true);
  assert.equal(result.data.filters.range, "4h");
  assert.equal(result.data.filters.granularity, "hour");
  assert.equal(result.data.filtered.eventCount, 2);
  assert.equal(result.data.filtered.summary.promptTokens, 300);
}

async function testOneHourRangeSeriesIsHourly() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "recent.json", makeEvent({
    eventId: "chat-1:msg-recent",
    messageId: "msg-recent",
    completedAt: now - 10 * 60 * 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "1h" });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.granularity, "hour");
  assert.ok(result.data.filtered.series.trend.length > 0, "should have hourly series entries");
}

// -- Feature 2: Chat pivot --

async function testChatPivotGroupsEventsByChatId() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "chat-a-1.json", makeEvent({
    eventId: "chat-A:msg-1",
    chatId: "chat-A",
    messageId: "msg-1",
    completedAt: now - 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "chat-a-2.json", makeEvent({
    eventId: "chat-A:msg-2",
    chatId: "chat-A",
    messageId: "msg-2",
    completedAt: now - 500,
    usage: { prompt_tokens: 150, completion_tokens: 15, cost: 0.015 },
  }));
  writeEvent(eventsDir, "chat-b-1.json", makeEvent({
    eventId: "chat-B:msg-3",
    chatId: "chat-B",
    messageId: "msg-3",
    completedAt: now - 2000,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));
  writeEvent(eventsDir, "chat-b-2.json", makeEvent({
    eventId: "chat-B:msg-4",
    chatId: "chat-B",
    messageId: "msg-4",
    completedAt: now - 1500,
    usage: { prompt_tokens: 250, completion_tokens: 25, cost: 0.025 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.trend.length, 2);

  const chatA = result.data.filtered.series.trend.find((s) => s.date === "chat-A");
  const chatB = result.data.filtered.series.trend.find((s) => s.date === "chat-B");
  assert.ok(chatA, "should have entry for chat-A");
  assert.ok(chatB, "should have entry for chat-B");
  assert.equal(chatA.responses, 2);
  assert.equal(chatB.responses, 2);
  assert.equal(chatA.promptTokens, 250);
  assert.equal(chatB.promptTokens, 450);
}

async function testChatPivotWithRangeFiltering() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

  writeEvent(eventsDir, "chat-a-recent.json", makeEvent({
    eventId: "chat-A:msg-1",
    chatId: "chat-A",
    messageId: "msg-1",
    completedAt: twoHoursAgo,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "chat-b-old.json", makeEvent({
    eventId: "chat-B:msg-2",
    chatId: "chat-B",
    messageId: "msg-2",
    completedAt: twoDaysAgo,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "1d", pivot: "chat" });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.trend.length, 1);
  assert.equal(result.data.filtered.series.trend[0].date, "chat-A");
}

async function testChatPivotWithModelFilter() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "atlas-chat.json", makeEvent({
    eventId: "chat-atlas:msg-1",
    chatId: "chat-atlas",
    messageId: "msg-1",
    modelId: "Atlas Sonnet 4.6",
    modelName: "Atlas Sonnet 4.6",
    completedAt: now - 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "gpt-chat.json", makeEvent({
    eventId: "chat-gpt:msg-2",
    chatId: "chat-gpt",
    messageId: "msg-2",
    modelId: "GPT-5.4",
    modelName: "GPT-5.4",
    completedAt: now - 500,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({
    range: "all",
    pivot: "chat",
    modelId: "group:atlas",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.trend.length, 1);
  assert.equal(result.data.filtered.series.trend[0].date, "chat-atlas");
}

async function testChatPivotSortedChronologically() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "chat-b-early.json", makeEvent({
    eventId: "chat-B:msg-1",
    chatId: "chat-B",
    messageId: "msg-1",
    completedAt: now - 5000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "chat-a-later.json", makeEvent({
    eventId: "chat-A:msg-2",
    chatId: "chat-A",
    messageId: "msg-2",
    completedAt: now - 1000,
    usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0.02 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.trend.length, 2);
  assert.equal(result.data.filtered.series.trend[0].date, "chat-B");
  assert.equal(result.data.filtered.series.trend[1].date, "chat-A");
}

async function testChatPivotEmptyChatIdFallsBackToEventId() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "no-chat.json", makeEvent({
    eventId: "no-chat-event-1",
    chatId: "",
    messageId: "msg-1",
    completedAt: now - 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  assert.equal(result.data.filtered.series.trend.length, 1);
  // Should use eventId as the key since chatId is empty
  const entry = result.data.filtered.series.trend[0];
  assert.ok(entry.date.length > 0, "should have a non-empty date key");
  assert.equal(entry.responses, 1);
}

async function testPivotDefaultsToTime() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(eventsDir, "event-1.json", makeEvent({
    eventId: "chat-1:msg-1",
    completedAt: Date.now() - 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all" });

  assert.equal(result.success, true);
  assert.equal(result.data.filters.pivot, "time");
}

async function testChatPivotIncludesModelNameSingleModel() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "chat-a-1.json", makeEvent({
    eventId: "chat-A:msg-1",
    chatId: "chat-A",
    messageId: "msg-1",
    modelId: "Atlas Opus 4.6",
    modelName: "Atlas Opus 4.6",
    completedAt: now - 2000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "chat-a-2.json", makeEvent({
    eventId: "chat-A:msg-2",
    chatId: "chat-A",
    messageId: "msg-2",
    modelId: "Atlas Opus 4.6",
    modelName: "Atlas Opus 4.6",
    completedAt: now - 1000,
    usage: { prompt_tokens: 150, completion_tokens: 15, cost: 0.015 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  const entry = result.data.filtered.series.trend[0];
  assert.equal(entry.modelName, "Atlas Opus 4.6");
  assert.equal(entry.chatId, "chat-A");
}

async function testChatPivotIncludesModelNameMultiModel() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  const now = Date.now();
  writeEvent(eventsDir, "chat-a-atlas.json", makeEvent({
    eventId: "chat-A:msg-1",
    chatId: "chat-A",
    messageId: "msg-1",
    modelId: "Atlas Opus 4.6",
    modelName: "Atlas Opus 4.6",
    completedAt: now - 2000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));
  writeEvent(eventsDir, "chat-a-gpt.json", makeEvent({
    eventId: "chat-A:msg-2",
    chatId: "chat-A",
    messageId: "msg-2",
    modelId: "GPT-5.4",
    modelName: "GPT-5.4",
    completedAt: now - 1000,
    usage: { prompt_tokens: 150, completion_tokens: 15, cost: 0.015 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  const entry = result.data.filtered.series.trend[0];
  // Multi-model chat should list both models
  assert.ok(entry.modelName.includes("Atlas Opus 4.6"), "should include Atlas model");
  assert.ok(entry.modelName.includes("GPT-5.4"), "should include GPT model");
  assert.ok(entry.modelName.includes(", "), "should be comma-separated");
}

async function testChatPivotReturnsCorrectFilterMetadata() {
  const reportingPath = makeTempReportingPath();
  const eventsDir = path.join(reportingPath, "events");
  fs.mkdirSync(eventsDir, { recursive: true });

  writeEvent(eventsDir, "event-1.json", makeEvent({
    eventId: "chat-1:msg-1",
    completedAt: Date.now() - 1000,
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  }));

  const costReporting = loadCostReporting(reportingPath);
  const result = await costReporting.getDashboard({ range: "all", pivot: "chat" });

  assert.equal(result.success, true);
  assert.equal(result.data.filters.pivot, "chat");
}

async function main() {
  // Feature 1: 1h/4h ranges
  await testOneHourRangeReturnsRecentEventsOnly();
  console.log("PASS 1h range returns only recent events");

  await testFourHourRangeReturnsRecentEventsOnly();
  console.log("PASS 4h range returns only recent events");

  await testOneHourRangeSeriesIsHourly();
  console.log("PASS 1h range series uses hourly granularity");

  // Feature 2: Chat pivot
  await testChatPivotGroupsEventsByChatId();
  console.log("PASS chat pivot groups events by chatId");

  await testChatPivotWithRangeFiltering();
  console.log("PASS chat pivot respects range filtering");

  await testChatPivotWithModelFilter();
  console.log("PASS chat pivot respects model filter");

  await testChatPivotSortedChronologically();
  console.log("PASS chat pivot sorts chats chronologically");

  await testChatPivotEmptyChatIdFallsBackToEventId();
  console.log("PASS chat pivot falls back to eventId for empty chatId");

  await testPivotDefaultsToTime();
  console.log("PASS pivot defaults to time when not specified");

  await testChatPivotIncludesModelNameSingleModel();
  console.log("PASS chat pivot includes modelName for single-model chat");

  await testChatPivotIncludesModelNameMultiModel();
  console.log("PASS chat pivot includes comma-separated modelName for multi-model chat");

  await testChatPivotReturnsCorrectFilterMetadata();
  console.log("PASS chat pivot returns correct filter metadata");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
