const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "docker-mcp.js"), "utf8");

test("host MCP runtime and bridge are both pinned to the main callback port", () => {
  const occurrences = source.match(/applyMainStackOAuthCallbackPortEnv\(/g) || [];
  assert.ok(
    occurrences.length >= 2,
    "host MCPO and Host MCP Bridge launch environments must both enforce the callback-port contract",
  );

  const hostStart = source.indexOf("async function startHostMcpoUnlocked");
  const bridgeStart = source.indexOf("async function startHostMcpBridgeUnlocked");
  assert.ok(hostStart >= 0 && bridgeStart > hostStart);
  assert.match(
    source.slice(hostStart, bridgeStart),
    /applyMainStackOAuthCallbackPortEnv\(/,
  );
  assert.match(
    source.slice(bridgeStart),
    /applyMainStackOAuthCallbackPortEnv\(/,
  );
});
