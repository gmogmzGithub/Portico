const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API_SOURCE = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");

function routeSection(routeStart, routeEnd) {
  const start = API_SOURCE.indexOf(routeStart);
  assert.notEqual(start, -1, `${routeStart} route should exist`);
  const end = routeEnd ? API_SOURCE.indexOf(routeEnd, start) : API_SOURCE.length;
  assert.notEqual(end, -1, `${routeEnd} route should exist after ${routeStart}`);
  return API_SOURCE.slice(start, end);
}

test("programmatic Host MCP Bridge API exposes status and POC lifecycle routes", () => {
  assert.match(
    API_SOURCE,
    /const \{[\s\S]*configureMcpClients,[\s\S]*detectMcpClients,[\s\S]*DEFAULT_BRIDGE_URL,[\s\S]*\} = require\("\.\/host-mcp-bridge-auto-config"\);/,
  );
  assert.match(API_SOURCE, /apiApp\.get\('\/api\/mcp\/bridge\/status'/);
  assert.match(API_SOURCE, /apiApp\.get\('\/api\/mcp\/bridge\/clients'/);
  assert.match(API_SOURCE, /apiApp\.post\('\/api\/mcp\/bridge\/enable'/);
  assert.match(API_SOURCE, /apiApp\.post\('\/api\/mcp\/bridge\/disable'/);
  assert.match(API_SOURCE, /stopHostMcpBridge/);
  assert.match(API_SOURCE, /readHostMcpBridgePreferences/);
  assert.match(API_SOURCE, /setHostMcpBridgeDesiredEnabled/);
  assert.match(API_SOURCE, /require\("\.\/host-mcp-bridge-telemetry"\)/);
  assert.doesNotMatch(API_SOURCE, /require\("\.\/host-mcp-bridge-auth"\)/);
});

test("clients route answers health, configured clients, and undo guidance without mutating", () => {
  const section = routeSection(
    "apiApp.get('/api/mcp/bridge/clients'",
    "apiApp.post('/api/mcp/bridge/enable'",
  );

  assert.doesNotMatch(section, /requireProgrammaticBridgeHeader/);
  assert.match(section, /detectMcpClients\(\{/);
  assert.match(section, /\.map\(summarizeBridgeClientState\)/);
  assert.match(section, /const bridgeReady = await probeHostMcpBridgeHealth\(state\.hostMcpBridge\.port\);/);
  assert.match(section, /const bridgePreferences = readHostMcpBridgePreferences/);
  assert.match(section, /bridgeEnabled: bridgePreferences\.data\.enabled !== false/);
  assert.match(section, /configuredClients,/);
  assert.match(section, /detectedClients,/);
  assert.match(section, /const scriptAction = bridgeScriptAction\(\{/);
  assert.match(section, /scriptAction,/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_status_checked"/);
  assert.match(section, /summarizeBridgeClientInventory\(clients\)/);
  assert.match(section, /Rerun setup-community\/run-mcp-servers to reselect the active MCP path/);
  assert.doesNotMatch(section, /ensureHostMcpBridgeReady/);
  assert.doesNotMatch(section, /configureMcpClients/);
});

test("status route is operational readiness only and validates bearer auth when present", () => {
  const section = routeSection(
    "apiApp.get('/api/mcp/bridge/status'",
    "apiApp.get('/api/mcp/bridge/clients'",
  );

  assert.match(section, /requireElectronBrokerAuth\(req, res\)/);
  assert.match(section, /brokerAuthReady/);
  assert.match(section, /bridgeReady,/);
  assert.match(section, /bridgeEnabled,/);
  assert.doesNotMatch(section, /configuredClients/);
  assert.doesNotMatch(section, /detectedClients/);
  assert.doesNotMatch(section, /clients,/);
  assert.doesNotMatch(section, /scriptAction/);
  assert.doesNotMatch(section, /summarizeBridgeClientInventory/);
});

test("enable route detects clients, waits for bridge readiness, and uses existing writers", () => {
  const section = routeSection(
    "apiApp.post('/api/mcp/bridge/enable'",
    "apiApp.post('/api/mcp/bridge/disable'",
  );

  assert.match(section, /if \(!requireProgrammaticBridgeHeader\(req, res\)\) \{/);
  assert.match(section, /const clients = detectMcpClients\(\{/);
  assert.match(section, /let clientIds = \[\];/);
  assert.match(section, /clientIds = normalizeBridgeEnableClientIds\(req\.body \|\| \{\}, clients\);/);
  assert.match(section, /setHostMcpBridgeDesiredEnabled\(true,[\s\S]*source: "api_enable"/);
  assert.match(section, /await ensureHostMcpBridgeReady\(\{/);
  assert.match(section, /timeoutMs: normalizeBridgeEnableTimeoutMs/);
  assert.match(section, /await configureMcpClients\(\{/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_enable_requested"/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_enable_failed"/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_enable_completed"/);
  assert.match(section, /emitBridgeClientResultEvents\("client_configure"/);
  assert.match(section, /clientIds,/);
  assert.match(section, /bridgeUrl: DEFAULT_BRIDGE_URL/);
  assert.match(section, /selectedClientIds: clientIds/);
  assert.match(section, /results: configureResult\.results \|\| \[\]/);
});

test("disable route stops only the bridge runtime and keeps client config state intact", () => {
  const section = routeSection(
    "apiApp.post('/api/mcp/bridge/disable'",
    "apiApp.post('/api/mcp/oauth/record'",
  );

  assert.match(section, /if \(!requireProgrammaticBridgeHeader\(req, res\)\) \{/);
  assert.match(section, /const clients = detectMcpClients\(\{/);
  assert.match(section, /\.map\(summarizeBridgeClientState\)/);
  assert.match(section, /setHostMcpBridgeDesiredEnabled\(false,[\s\S]*source: "api_disable"/);
  assert.match(section, /const stopResult = await stopHostMcpBridge\(\{ reason: "programmatic_disable" \}\);/);
  assert.match(section, /await checkDockerStatus\(\);/);
  assert.match(section, /if \(!stopResult\?\.success\) \{/);
  assert.match(section, /Host MCP Bridge did not stop/);
  assert.match(section, /res\.status\(503\)\.json\(\{/);
  assert.match(section, /const scriptAction = "fallback_toolhive";/);
  assert.match(section, /bridgeEnabled: false/);
  assert.match(section, /Client configurations were left unchanged/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_disable_requested"/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_disable_completed"/);
  assert.match(section, /emitBridgeLogRepoEvent\("bridge_disable_failed"/);
  assert.doesNotMatch(section, /configureMcpClients/);
});

test("enable route defaults to detected or already configured clients", () => {
  assert.match(
    API_SOURCE,
    /Array\.isArray\(body\.clientIds\)[\s\S]*Array\.isArray\(body\.client_ids\)/,
  );
  assert.match(
    API_SOURCE,
    /\.filter\(\(client\) => client\?\.detected === true \|\| client\?\.configured === true\)/,
  );
  assert.doesNotMatch(API_SOURCE, /mode === "all"/);
  assert.match(API_SOURCE, /normalizeBridgeEnableClientIds,/);
});

test("mutating bridge enable route has a script-only header guard", () => {
  assert.match(API_SOURCE, /function requireProgrammaticBridgeHeader\(req, res\) \{/);
  assert.match(API_SOURCE, /x-portico-programmatic-bridge/);
  assert.match(
    API_SOURCE,
    /Programmatic Host MCP Bridge configuration requires X-PORTICO-Programmatic-Bridge: 1/,
  );
  assert.match(
    routeSection("apiApp.post('/api/mcp/bridge/disable'", "apiApp.post('/api/mcp/oauth/record'"),
    /if \(!requireProgrammaticBridgeHeader\(req, res\)\) \{/,
  );
  assert.doesNotMatch(API_SOURCE, /Access-Control-Allow-Headers', 'Content-Type, X-PORTICO-Programmatic-Bridge'/);
});

test("status helpers keep script state small and actionable", () => {
  assert.match(API_SOURCE, /function summarizeBridgeClientState\(client\) \{/);
  assert.match(API_SOURCE, /configured: client\.configured === true/);
  assert.match(API_SOURCE, /function bridgeScriptAction\(\{ bridgeReady, configuredClients, detectedClients \}\) \{/);
  assert.match(API_SOURCE, /const hasConfiguredClients = configuredClients\.length > 0;/);
  assert.match(API_SOURCE, /const hasDetectedClients = detectedClients\.length > 0;/);
  assert.match(API_SOURCE, /if \(bridgeReady && hasConfiguredClients\) \{/);
  assert.match(API_SOURCE, /if \(hasConfiguredClients \|\| hasDetectedClients\) \{/);
  assert.match(API_SOURCE, /return "enable_bridge";/);
  assert.match(API_SOURCE, /return "ready";/);
  assert.match(API_SOURCE, /return "fallback_toolhive";/);
  assert.match(API_SOURCE, /summarizeBridgeClientState,/);
  assert.match(API_SOURCE, /bridgeScriptAction,/);
});
