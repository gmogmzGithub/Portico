const test = require("node:test");
const assert = require("node:assert/strict");

const { isFreshHealthResult } = require("./health-check-exec-policy");

const expected = {
  expectedRunId: "run-current",
  expectedMode: "startup-core",
  recordedRunId: "run-current",
  runnerStartedAt: 10_000,
  priorStatusMarker: { ino: 1, mtimeMs: 9_000, size: 100 },
  statusMarker: { ino: 2, mtimeMs: 10_100, size: 120 },
  healthData: {
    servers: {
      "mcp-assistant": { deployment: "core", is_core: true, status: "healthy" },
      slack: { deployment: "docker", is_core: false, status: "starting" },
    },
    sync_diagnostics: {
      health_sync_run_id: "run-current",
      health_check_mode: "startup-core",
      configured_core_server_ids: ["mcp-assistant"],
    },
  },
};

test("fresh health proof requires producer-bound run metadata", () => {
  assert.equal(isFreshHealthResult(expected), true);

  assert.equal(
    isFreshHealthResult({
      ...expected,
      // Simulates a concurrent targeted-readiness writer changing the status
      // file while the current health run ID remains in the mutable sidecar.
      healthData: {
        servers: expected.healthData.servers,
        sync_diagnostics: {
          health_sync_run_id: "run-previous",
          health_check_mode: "startup-core",
        },
      },
    }),
    false,
  );
  assert.equal(
    isFreshHealthResult({
      ...expected,
      healthData: {
        servers: expected.healthData.servers,
        sync_diagnostics: {
          health_sync_run_id: "run-current",
          health_check_mode: "light",
        },
      },
    }),
    false,
  );
});

test("fresh health proof requires every startup-core service to be healthy", () => {
  assert.equal(
    isFreshHealthResult({
      ...expected,
      healthData: {
        servers: {
          "mcp-assistant": {
            deployment: "core",
            is_core: true,
            status: "healthy",
          },
          skills: { deployment: "docker", is_core: true, status: "starting" },
        },
        sync_diagnostics: {
          health_sync_run_id: "run-current",
          health_check_mode: "startup-core",
          configured_core_server_ids: ["mcp-assistant", "skills"],
        },
      },
    }),
    false,
  );
  assert.equal(
    isFreshHealthResult({
      ...expected,
      healthData: {
        servers: {
          slack: { deployment: "docker", is_core: false, status: "healthy" },
        },
        sync_diagnostics: expected.healthData.sync_diagnostics,
      },
    }),
    false,
  );
});

test("fresh health proof rejects stale files and mismatched sidecars", () => {
  assert.equal(
    isFreshHealthResult({
      ...expected,
      statusMarker: expected.priorStatusMarker,
    }),
    false,
  );
  assert.equal(
    isFreshHealthResult({
      ...expected,
      recordedRunId: "run-previous",
    }),
    false,
  );
});
