const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API_SOURCE = fs.readFileSync(
  path.join(__dirname, "api.js"),
  "utf8",
);

test("getServerReadinessStatus can bypass the disabled gate during an in-flight enable", () => {
  assert.match(
    API_SOURCE,
    /const assumeEnabled = options\.assumeEnabled === true;/,
  );
  assert.match(
    API_SOURCE,
    /if \(!assumeEnabled && !isServerEffectivelyEnabled\(serverId, dockerMcpImpl\)\) \{/,
  );
});

test("toggle enable readbacks force live readiness instead of stale disabled or cached state", () => {
  assert.match(
    API_SOURCE,
    /let currentReadiness = await getServerReadinessStatus\(server_id, \{\s*deploymentType,\s*requestTimeoutMs:[\s\S]*?assumeEnabled: true,\s*skipCache: true,\s*\}\);/,
  );
});

test("readiness normalization canonicalizes legacy healthy phases before returning cached state", () => {
  assert.match(
    API_SOURCE,
    /const \{ canonicalizeReadinessPhase \} = require\("\.\/readiness-phase"\);/,
  );
  assert.match(
    API_SOURCE,
    /const readinessPhase = canonicalizeReadinessPhase\(status\);/,
  );
  assert.match(
    API_SOURCE,
    /status:\s*cached\.healthy \? 'healthy' : cached\.phase,/,
  );
});

test("readiness returns persisted startup failures before stale disabled state", () => {
  assert.match(
    API_SOURCE,
    /const \{[\s\S]*clearStartupFailure,[\s\S]*loadStartupFailures,[\s\S]*\} = require\("\.\/mcp-startup-failures"\);/,
  );
  assert.match(API_SOURCE, /function startupFailureReadinessStatus\(serverId,\s*deploymentType,\s*failure\) \{/);
  assert.match(
    API_SOURCE,
    /const startupFailure = getPersistedStartupFailure\(serverId\);[\s\S]*?if \(startupFailure\) \{[\s\S]*?return result;[\s\S]*?\}[\s\S]*?if \(!assumeEnabled && !isServerEffectivelyEnabled\(serverId, dockerMcpImpl\)\) \{/,
  );
  assert.match(API_SOURCE, /assumeEnabled: true,/);
  assert.match(API_SOURCE, /startup_failure:\s*status\.startupFailure,/);
  assert.match(API_SOURCE, /config_path:\s*status\.configPath,/);
});

test("API exposes bulk readiness before single-server readiness route", () => {
  const bulkIndex = API_SOURCE.indexOf("apiApp.post('/api/server-readiness/bulk'");
  const singleIndex = API_SOURCE.indexOf("apiApp.get('/api/server-readiness/:serverId'");

  assert.notEqual(bulkIndex, -1);
  assert.notEqual(singleIndex, -1);
  assert.ok(bulkIndex < singleIndex);
  assert.match(API_SOURCE, /readinessStatusToApiPayload\(serverId, status\)/);
});

test("bulk readiness bypasses per-server health writes and syncs once", () => {
  const bulkSection = API_SOURCE.slice(
    API_SOURCE.indexOf("apiApp.post('/api/server-readiness/bulk'"),
    API_SOURCE.indexOf("apiApp.get('/api/server-readiness/:serverId'"),
  );

  assert.match(bulkSection, /getServerReadinessStatus\(serverId,\s*\{\s*syncHealthStatus:\s*false,\s*\}\)/);
  assert.match(bulkSection, /withTimeout\([\s\S]*SERVER_READINESS_BULK_ITEM_TIMEOUT_MS/);
  assert.match(bulkSection, /await syncHealthStatusFileFromReadinessEntries\(/);
  assert.doesNotMatch(bulkSection, /await syncHealthStatusFileFromReadiness\(serverId/);
});

test("single readiness health sync can be disabled by callers", () => {
  assert.match(
    API_SOURCE,
    /if \(options\.syncHealthStatus !== false\) \{[\s\S]*await syncHealthStatusFileFromReadiness\(serverId,\s*normalized\);/,
  );
  assert.match(API_SOURCE, /async function syncHealthStatusFileFromReadinessEntries\(entries\) \{/);
});

// PORTICO-443: this was a source pin -- it matched api.js's text for the literal
// `req.path.startsWith('/api/server-readiness')`. It broke the moment that single
// hard-coded route became a list, which is exactly the refactor it should have
// tolerated, and it would have passed against an implementation that logged every
// route as long as the characters were present. The invariant it guarded (routine
// probes are not logged on success, failures always are) is now covered
// behaviourally against the real policy module in
// api-request-log-policy.unit.test.js.

test("readiness ignores persisted startup failures for deleted servers", () => {
  assert.match(API_SOURCE, /isInstalledMcpServerId/);
  assert.match(
    API_SOURCE,
    /if \(!isInstalledMcpServerId\(projectRoot,\s*serverId,[\s\S]*?\)\) \{[\s\S]*?clearStartupFailure\(projectRoot,\s*serverId,[\s\S]*?return null;[\s\S]*?\}/,
  );
});

test("readiness ignores persisted compose failures when generated config is not configured", () => {
  assert.match(API_SOURCE, /getGeneratedMcpConfigStatusForServer/);
  assert.match(API_SOURCE, /isRuntimeFileNotConfiguredStatus/);
  assert.match(
    API_SOURCE,
    /const generatedConfigStatus = getGeneratedMcpConfigStatusForServer\([\s\S]*?if \(isRuntimeFileNotConfiguredStatus\(generatedConfigStatus\)\) \{[\s\S]*?clearStartupFailure\(projectRoot,\s*serverId,[\s\S]*?return null;/,
  );
});

test("API enable preflight returns configuration-required instead of failing missing runtime files", () => {
  assert.match(
    API_SOURCE,
    /if \(preflightIssue\.errorCode === 'NOT_CONFIGURED'\) \{[\s\S]*requiresConfiguration:\s*true,[\s\S]*uiStatus:\s*'not_configured'/,
  );
  assert.match(
    API_SOURCE,
    /if \(lifecycleResult\?\.requiresConfiguration\) \{[\s\S]*requiresConfiguration:\s*true,[\s\S]*uiStatus:\s*'not_configured'/,
  );
});

test("API disable clears startup failures before health sync", () => {
  assert.match(
    API_SOURCE,
    /if \(noopResult\) \{[\s\S]*?if \(!enabled\) \{[\s\S]*?clearStartupFailure\(bootstrap\.PROJECT_ROOT,\s*server_id,/,
  );
  assert.match(
    API_SOURCE,
    /await persistMcpToggleState\(server_id,\s*enabled,[\s\S]*?\);[\s\S]*?if \(!enabled\) \{[\s\S]*?clearStartupFailure\(bootstrap\.PROJECT_ROOT,\s*server_id,/,
  );
  assert.match(
    API_SOURCE,
    /updateServerPhase\(server_id,\s*READINESS_PHASE_DISABLED,[\s\S]*?\);[\s\S]*?scheduleLifecycleHealthSync\(\);/,
  );
});
