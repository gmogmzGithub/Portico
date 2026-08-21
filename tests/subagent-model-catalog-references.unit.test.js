const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function activeGptDisplayNames() {
  const catalog = read("model_catalog.yaml");
  return new Set(
    [...catalog.matchAll(/^\s+- model_name:\s*["'](GPT-[^"']+)["']/gm)].map(
      (match) => match[1],
    ),
  );
}

test("active subagent guidance matches the GPT model catalog", () => {
  const catalogModels = activeGptDisplayNames();
  assert.ok(catalogModels.size > 0, "model catalog must contain GPT entries");

  const subagentDocs = read("mcp-configs/subagents/subagents.md");
  const gptRow = subagentDocs.match(/^\| \*\*GPT-5\*\* \|(.*?)\|$/m);
  assert.ok(gptRow, "subagent docs must contain a GPT-5 row");
  const documentedSubagentModels = new Set(
    [...gptRow[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  );

  assert.deepEqual(
    [...documentedSubagentModels].sort(),
    [...catalogModels].sort(),
  );
});

test("scheduling E2E default is an active catalog model", () => {
  const driver = read("src/scripts/rust_core_mcp_e2e_driver.py");
  const schedulingSection = driver.match(
    /def exercise_scheduling\(base_url\):([\s\S]*?)(?=\ndef [a-z_]+\()/,
  );
  assert.ok(schedulingSection, "scheduling E2E function must exist");
  const modelDefault = schedulingSection[1].match(
    /"model_id":\s*"([^"]+)"/,
  );
  assert.ok(modelDefault, "scheduling E2E must define a model_id");

  assert.equal(modelDefault[1], "GPT-5.6 Sol");
  assert.ok(activeGptDisplayNames().has(modelDefault[1]));
});

function activeClaudeDisplayNames() {
  const catalog = read("model_catalog.yaml");
  return new Set(
    [...catalog.matchAll(/^\s+- model_name:\s*["'](Claude [^"']+)["']/gm)].map(
      (match) => match[1],
    ),
  );
}

test("active subagent guidance matches the Claude model catalog", () => {
  const catalogModels = activeClaudeDisplayNames();
  assert.ok(catalogModels.size > 0, "model catalog must contain Claude entries");

  const subagentDocs = read("mcp-configs/subagents/subagents.md");
  const claudeRow = subagentDocs.match(/^\| \*\*Claude\*\* \|(.*?)\|$/m);
  assert.ok(claudeRow, "subagent docs must contain a Claude row");
  const documentedSubagentModels = new Set(
    [...claudeRow[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  );

  assert.deepEqual(
    [...documentedSubagentModels].sort(),
    [...catalogModels].sort(),
  );
});
