const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = path.join(__dirname, "docker-mcp.js");

function requireOrdered(source, snippets) {
  let cursor = 0;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor);
    assert.notEqual(index, -1, `expected ordered snippet: ${snippet}`);
    cursor = index + snippet.length;
  }
}

test("health runner grants the prepared-snapshot marker only after normalization", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const start = source.indexOf("async function runHealthCheckAndBroadcast");
  const end = source.indexOf("async function runStartupCoreHealthGate", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const runner = source.slice(start, end);
  const normalization =
    "ensureMcpToggleSourceReady(`health-check:${mode}:${reason}`)";
  const normalizationIndex = runner.indexOf(normalization);
  assert.notEqual(normalizationIndex, -1);
  assert.doesNotMatch(
    runner.slice(0, normalizationIndex),
    /HEALTH_SYNC_TOGGLE_SNAPSHOT_READY/,
  );
  requireOrdered(runner, [
    normalization,
    "const healthCheckRunnerEnv = {",
    'HEALTH_SYNC_TOGGLE_SNAPSHOT_READY: "1"',
    'runManagedProcess(\n        "bash"',
    "env: healthCheckRunnerEnv",
  ]);
});
