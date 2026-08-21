const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
const singleHandlerSection = ipcSource.slice(
  ipcSource.indexOf('"toggle-mcp-server"'),
  ipcSource.indexOf('// Bulk toggle (enable/disable)', ipcSource.indexOf('"toggle-mcp-server"')),
);
const bulkHandlerSection = ipcSource.slice(
  ipcSource.indexOf("const executeBulkMcpToggle"),
  ipcSource.indexOf('// Get tools list for a specific MCP server', ipcSource.indexOf('"toggle-mcp-servers-bulk"')),
);

test("bulk enable records invalid selected servers without poisoning startable servers", () => {
  assert.match(bulkHandlerSection, /const failedEnableServerIds = \[\];/);
  assert.match(
    bulkHandlerSection,
    /fatalPreflightResults\.push\(failureResult\);[\s\S]*failedEnableServerIds\.push\(serverId\);[\s\S]*recordAndPublishStartupFailure/s,
  );
  assert.match(
    bulkHandlerSection,
    /failedEnableServerIds\.forEach\(\(serverId\) => \{[\s\S]*toggles\[serverId\] = false;/s,
  );
  assert.match(
    bulkHandlerSection,
    /if \(!issue\) \{[\s\S]*startableServerIds\.push\(serverId\);[\s\S]*continue;[\s\S]*\}/s,
  );
});

test("bulk enable publishes startup failures immediately", () => {
  assert.match(
    ipcSource,
    /function recordAndPublishStartupFailure\(failure,\s*options = \{\}\) \{/,
  );
  assert.match(
    ipcSource,
    /dockerMcp\.publishStartupFailureState\(recorded,\s*\{/,
  );
  assert.match(
    bulkHandlerSection,
    /recordAndPublishStartupFailure\(failureResult\.startupFailure,\s*\{[\s\S]*?reason: `bulk-preflight-failure:\$\{serverId\}`/s,
  );
});

test("bulk enable retries generation/start after excluding an attributed bad server", () => {
  assert.match(
    bulkHandlerSection,
    /for \(let attempt = 0; attempt < 2 && pendingStartIds\.length > 0; attempt \+= 1\)/,
  );
  assert.match(bulkHandlerSection, /const restartResult = await restartMcpoServers\(pendingStartIds\);/);
  assert.match(bulkHandlerSection, /extractAttributedServerFailure/);
  assert.match(
    bulkHandlerSection,
    /toggles\[attributedFailure\.serverId\] = false;/,
  );
  assert.match(
    bulkHandlerSection,
    /pendingStartIds = pendingStartIds\.filter\(\s*\(serverId\) => serverId !== attributedFailure\.serverId,/s,
  );
  assert.match(bulkHandlerSection, /continue;/);
});

test("bulk toggle returns one result for every requested server", () => {
  assert.match(bulkHandlerSection, /const requestedResultMap = new Map\(\);/);
  assert.match(
    bulkHandlerSection,
    /const finalResults = normalizedServerIds\.map\(\(serverId\) => \{/,
  );
  assert.match(bulkHandlerSection, /results: finalResults,/);
});

test("single and bulk disables clear startup failures", () => {
  // Disable noop path: clear is gated on !enabled (no-op early-return for
  // already-correct state).
  assert.match(
    singleHandlerSection,
    /if \(noopResult\) \{[\s\S]*?if \(!enabled\) \{[\s\S]*?clearStartupFailure\(bootstrap\.PROJECT_ROOT,\s*serverId,/,
  );
  // Real toggle path: after persisting the toggle, the handler clears stale
  // startup failures unconditionally so re-enabling also wipes prior crashes.
  assert.match(
    singleHandlerSection,
    /await mutateMcpToggles\([\s\S]*?\);[\s\S]*?clearStartupFailure\(bootstrap\.PROJECT_ROOT,\s*serverId,/,
  );
  assert.match(
    bulkHandlerSection,
    /clearStartupFailures\(bootstrap\.PROJECT_ROOT,\s*normalizedServerIds,/,
  );
});

test("host-only bulk disable does not depend on Docker Compose enumeration", () => {
  const disableStart = bulkHandlerSection.indexOf(
    "// 2b. Disable path: regen once, then fast-remove targeted containers",
  );
  const hostRestart = bulkHandlerSection.indexOf(
    "if (hostServers.length > 0)",
    disableStart,
  );
  const disableSetup = bulkHandlerSection.slice(disableStart, hostRestart);

  assert.ok(disableStart >= 0);
  assert.ok(hostRestart > disableStart);
  assert.match(
    disableSetup,
    /if \(dockerTargets\.length > 0\) \{[\s\S]*dockerMcp\.getConfiguredComposeServices\(/s,
  );
  assert.match(
    disableSetup,
    /serverIds: dockerServers/,
  );
});
