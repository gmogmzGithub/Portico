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

function loadCostReporting(userDataPath) {
  currentUserDataPath = userDataPath;
  process.env.PORTICO_REPORTING_DIR = userDataPath;
  delete require.cache[costReportingPath];
  return require(costReportingPath);
}

function makeTempUserDataPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cost-reporting-model-groups-"));
}

async function seedEvents(costReporting) {
  const timestamp = "2026-03-06T20:00:00.000Z";
  const events = [
    {
      eventId: "claude-1",
      chatId: "chat-claude",
      messageId: "message-claude",
      modelId: "Claude Sonnet 4.6",
      modelName: "Claude Sonnet 4.6",
      timestamp,
      promptTokens: 1200,
      completionTokens: 120,
      cost: 0.02,
    },
    {
      eventId: "gpt-1",
      chatId: "chat-gpt",
      messageId: "message-gpt",
      modelId: "GPT-4.1",
      modelName: "GPT-4.1",
      timestamp,
      promptTokens: 900,
      completionTokens: 90,
      cost: 0.01,
    },
  ];

  for (const event of events) {
    const result = await costReporting.recordPromptCost(event);
    assert.equal(result.success, true);
  }
}

async function testGroupedModelFilters() {
  const userDataPath = makeTempUserDataPath();
  const costReporting = loadCostReporting(userDataPath);
  await seedEvents(costReporting);

  const claudeResult = await costReporting.getDashboard({
    range: "all",
    modelId: "group:claude",
  });
  assert.equal(claudeResult.success, true);
  assert.equal(claudeResult.data.filtered.eventCount, 1);
  assert.deepEqual(
    claudeResult.data.filtered.models.map((model) => model.modelName),
    ["Claude Sonnet 4.6"],
  );

  const gptResult = await costReporting.getDashboard({
    range: "all",
    modelId: "group:gpt",
  });
  assert.equal(gptResult.success, true);
  assert.equal(gptResult.data.filtered.eventCount, 1);
  assert.deepEqual(
    gptResult.data.filtered.models.map((model) => model.modelName),
    ["GPT-4.1"],
  );
}

async function main() {
  await testGroupedModelFilters();
  console.log("PASS grouped model filters return matching dashboard data");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
