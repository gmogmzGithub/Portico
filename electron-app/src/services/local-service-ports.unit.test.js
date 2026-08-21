const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LOCAL_SERVICE_PORTS,
  assertUniqueLocalServicePorts,
  getLlmDebugMonitorBaseUrl,
} = require("../config/local-service-ports");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

test("app-owned local service ports are reserved and unique", () => {
  assert.deepEqual(LOCAL_SERVICE_PORTS, {
    setupAuthCallback: 8877,
    gitlabMarketplaceAuthCallback: 8878,
    llmDebugMonitor: 8879,
  });
  assert.equal(assertUniqueLocalServicePorts(), true);
  assert.throws(
    () =>
      assertUniqueLocalServicePorts({
        setupAuthCallback: 8877,
        llmDebugMonitor: 8877,
      }),
    /assigned to both setupAuthCallback and llmDebugMonitor/,
  );
  assert.equal(getLlmDebugMonitorBaseUrl(), "http://localhost:8879");
});

test("debug monitor runtime and link consumers use the reserved monitor port", () => {
  const monitorConsumers = [
    "dev/docker-compose.debug-monitor.yml",
    "llm-debug-monitor/Dockerfile",
    "llm-debug-monitor/backend/server.py",
    "llm-debug-monitor/vite.config.ts",
    "llm-debug-monitor/src/components/RequestInspector/CapabilitiesViewer.tsx",
    "llm-debug-monitor/src/components/RequestInspector/ToolCallViewer.tsx",
    "llm-debug-monitor/src/components/RequestTimeline/RequestCard.tsx",
    "src/patches/frontend/src/lib/utils/owuiDebugMonitor.ts",
    "src/scripts/run_google_workspace_chat_consistency.py",
  ];

  for (const relativePath of monitorConsumers) {
    const source = readRepoFile(relativePath);
    assert.match(source, /8879/, `${relativePath} must reference monitor port 8879`);
    assert.doesNotMatch(
      source,
      /8877/,
      `${relativePath} must not reference the Okta callback port`,
    );
  }

  assert.match(
    readRepoFile("electron-app/src/services/bootstrap.js"),
    /getLlmDebugMonitorBaseUrl/,
  );
});
