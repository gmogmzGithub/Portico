const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");

function routeSection(route, nextMarker) {
  const start = source.indexOf(route);
  assert.notEqual(start, -1, `missing route ${route}`);
  const end = source.indexOf(nextMarker, start + route.length);
  assert.notEqual(end, -1, `missing route boundary ${nextMarker}`);
  return source.slice(start, end);
}

test("REST exposes immediate operation start and authoritative snapshot reads", () => {
  assert.match(source, /require\('\.\/mcp-operation-service'\)/);
  assert.match(
    source,
    /apiApp\.post\('\/api\/mcp-operations',[\s\S]*?mcpOperationService\.startMcpOperation\(/,
  );
  assert.match(source, /apiApp\.get\('\/api\/mcp-operations\/active'/);
  assert.match(source, /apiApp\.get\('\/api\/mcp-operations\/:operationId'/);
  assert.match(source, /res\.status\(202\)\.json\(/);
  const compatibilityHelper = source.slice(
    source.indexOf("function startCompatibilityMcpOperation"),
    source.indexOf("function broadcastMcpRestartComplete"),
  );
  assert.match(compatibilityHelper, /mcpOperationService\.startMcpOperation\(/);
  assert.doesNotMatch(compatibilityHelper, /waitForMcpOperation/);
});

test("legacy full and targeted restart routes delegate to the shared coordinator", () => {
  const fullRestart = routeSection(
    "apiApp.post('/api/restart-mcp'",
    "apiApp.post('/api/restart-mcp-server/:serverId'",
  );
  const targetedRestart = routeSection(
    "apiApp.post('/api/restart-mcp-server/:serverId'",
    "apiApp.post('/api/delete-mcp-server/:serverId'",
  );
  assert.match(
    fullRestart,
    /startCompatibilityMcpOperation\([\s\S]*?'restart',[\s\S]*?enabledServerIds/,
  );
  assert.match(
    targetedRestart,
    /startCompatibilityMcpOperation\([\s\S]*?'restart',[\s\S]*?\[serverId\]/,
  );
  assert.match(fullRestart, /\.\.\.operationResult/);
  assert.match(fullRestart, /operationId: operation\.operationId/);
  assert.match(targetedRestart, /\.\.\.operationResult/);
  assert.match(targetedRestart, /automaticRecovery/);
  assert.match(targetedRestart, /recoverySource === 'mcp-orc'/);
  assert.match(targetedRestart, /source: 'mcp-orc'/);
  assert.match(targetedRestart, /MCP_OPERATION_COORDINATOR_UNAVAILABLE/);
});

test("legacy toggle route uses one operation and exposes additive legacy fields", () => {
  const toggle = routeSection(
    "apiApp.post('/api/toggle-mcp-server'",
    "// ============================================================================\n  // OAUTH FLOW ENDPOINT",
  );
  const operationBranchStart = toggle.indexOf(
    "if (mcpOperationService.hasMcpOperationCoordinator())",
  );
  const legacyPersistenceStart = toggle.indexOf(
    "await persistMcpToggleState(server_id, enabled",
  );
  assert.ok(operationBranchStart >= 0);
  assert.ok(legacyPersistenceStart > operationBranchStart);
  assert.match(
    toggle.slice(operationBranchStart, legacyPersistenceStart),
    /startCompatibilityMcpOperation\([\s\S]*?enabled \? 'enable' : 'disable'/,
  );
  assert.match(toggle, /\.\.\.operationResult/);
  assert.match(
    source,
    /function buildLegacyMcpOperationResult|mcpOperationService\.buildLegacyMcpOperationResult/,
  );
  assert.match(ipcSource, /row\.configurationMessage \|\| null/);
});

test("assistant enable preflight returns saved_secret_unavailable before creating an operation or persisting a toggle", () => {
  const toggle = routeSection(
    "apiApp.post('/api/toggle-mcp-server'",
    "// ============================================================================\n  // OAUTH FLOW ENDPOINT",
  );
  const preflightIndex = toggle.indexOf(
    'if (isSavedSecretUnavailableIssue(preflightIssue))',
  );
  const operationIndex = toggle.indexOf(
    'startCompatibilityMcpOperation(',
  );
  const persistenceIndex = toggle.indexOf(
    'await persistMcpToggleState(server_id, enabled',
  );

  assert.ok(preflightIndex >= 0);
  assert.ok(operationIndex > preflightIndex);
  assert.ok(persistenceIndex > preflightIndex);
  assert.match(
    toggle.slice(preflightIndex, operationIndex),
    /savedSecretUnavailableToggleResponse\(server_id, preflightIssue\)/,
  );
  assert.match(
    source,
    /configurationIssue:\s*issue\.configurationIssue,[\s\S]*requiresSecretReplacement:\s*true,[\s\S]*recoveryPrompt:\s*issue\.recoveryPrompt/,
  );
});

test("operation conflicts return the active snapshot with MCP_OPERATION_BUSY", () => {
  assert.match(source, /error\?\.code === "MCP_OPERATION_BUSY"/);
  assert.match(source, /activeOperation:/);
  assert.match(source, /operationId: error\?\.operationId \|\| operation\?\.operationId/);
});

test("operation preflight rejects Core enable and disable mutations", () => {
  assert.match(
    ipcSource,
    /deploymentType === "core" && kind !== "restart"[\s\S]*MCP_CORE_TOGGLE_FORBIDDEN/,
  );
});
