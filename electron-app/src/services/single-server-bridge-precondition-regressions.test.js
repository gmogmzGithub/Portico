const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
const dockerSource = fs.readFileSync(
  path.join(__dirname, "docker-mcp.js"),
  "utf8",
);

function assertContainsInOrder(haystack, needles, message) {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(index, -1, `${message}: missing ${needle}`);
    assert.ok(index > cursor, `${message}: ${needle} is out of order`);
    cursor = index;
  }
}

test("start-single-mcp-server ensures the Host MCP Bridge OAuth broker is healthy before launching the container", () => {
  const handlerStart = source.indexOf(
    'ipcMain.handle("start-single-mcp-server"',
  );
  assert.notEqual(handlerStart, -1, "start-single-mcp-server handler missing");

  const handlerEnd = source.indexOf(
    '"stop-single-mcp-server"',
    handlerStart,
  );
  assert.ok(handlerEnd > handlerStart, "stop-single-mcp-server handler missing");

  const handlerBody = source.slice(handlerStart, handlerEnd);

  // The bridge readiness guard must run BEFORE we allocate ports / launch the
  // single-server stack, otherwise the container can come up against a
  // missing OAuth broker (host.docker.internal:8891) and fail with an opaque
  // connection-refused error.
  assertContainsInOrder(
    handlerBody,
    [
      "const bridgeReady = await ensureHostMcpBridgeReady();",
      "if (!bridgeReady.ready) {",
      "return { success: false, error: bridgeReady.error };",
      "await ensureSingleServerCallbackPortAvailable();",
      "await allocateSingleServerPorts();",
    ],
    "single-server start must gate on the OAuth broker before launching",
  );
});

test("shared ensureHostMcpBridgeReady covers healthy, start-and-wait, and timeout outcomes", () => {
  assert.match(source, /ensureHostMcpBridgeReady,/);
  const helperStart = dockerSource.indexOf(
    "async function ensureHostMcpBridgeReady(",
  );
  assert.notEqual(helperStart, -1, "ensureHostMcpBridgeReady helper missing");

  const helperEnd = dockerSource.indexOf(
    "async function stopHostMcpBridgeUnlocked",
    helperStart,
  );
  const helperBody = dockerSource.slice(helperStart, helperEnd);

  assertContainsInOrder(
    helperBody,
    [
      "if (await checkHostMcpBridgeHealth()) {",
      "return { ready: true, alreadyRunning: true };",
      "startResult = await startHostMcpBridge();",
      "while (Date.now() < deadline) {",
      "const healthy = expectedProcessGroupPid",
      "if (healthy) {",
      "ready: false,",
      "did not become healthy within",
    ],
    "bridge readiness helper must self-heal and fail closed with a reason",
  );
  assert.match(dockerSource, /ensureHostMcpBridgeReady,/);
});

test("Host MCP Bridge health validates the Electron broker auth channel before reuse", () => {
  const healthStart = dockerSource.indexOf(
    "async function checkHostMcpBridgeHealth(",
  );
  assert.notEqual(healthStart, -1, "checkHostMcpBridgeHealth helper missing");

  const healthEnd = dockerSource.indexOf(
    "async function startHostMcpBridgeUnlocked",
    healthStart,
  );
  assert.ok(healthEnd > healthStart, "startHostMcpBridgeUnlocked helper missing");
  const healthBody = dockerSource.slice(healthStart, healthEnd);

  assertContainsInOrder(
    healthBody,
    [
      "if (response.status !== 200) {",
      "if (options.validateElectronBroker !== false) {",
      "const bridgeStatus = await checkHostMcpBridgeBrokerStatus(timeoutMs);",
      "return false;",
    ],
    "bridge /health alone must not allow stale Electron broker-token reuse",
  );
  assert.match(healthBody, /\/bridge\/status/);
  assert.match(healthBody, /clientId: "host-mcp-bridge-health"/);
  assert.match(healthBody, /scopes: \["bridge:status"\]/);
});
