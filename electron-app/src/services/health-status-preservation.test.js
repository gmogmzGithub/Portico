const test = require("node:test");
const assert = require("node:assert/strict");

const {
  preserveLaggingServerStates,
} = require("./health-status-preservation");

test("preserves healthy lagging servers instead of collapsing them to starting", () => {
  const healthStatus = {
    servers: {
      "mcp-atlassian": {
        status: "starting",
        deployment: "docker",
      },
    },
    sync_diagnostics: {
      lagging_server_ids: ["mcp-atlassian"],
    },
  };
  const previousHealthStatus = {
    servers: {
      "mcp-atlassian": {
        status: "healthy",
        readiness_phase: "tool_ready",
        running: true,
        host: "localhost",
        port: 8765,
        error: null,
      },
    },
  };
  let recomputed = 0;

  preserveLaggingServerStates(healthStatus, previousHealthStatus, {
    recomputeSummary() {
      recomputed += 1;
    },
  });

  assert.equal(healthStatus.servers["mcp-atlassian"].status, "healthy");
  assert.equal(
    healthStatus.servers["mcp-atlassian"].readiness_phase,
    "tool_ready",
  );
  assert.deepEqual(healthStatus.sync_diagnostics.preserved_server_ids, [
    "mcp-atlassian",
  ]);
  assert.equal(healthStatus.sync_diagnostics.preserved_servers, 1);
  assert.equal(recomputed, 1);
});

test("preserves a healthy lagging server even when the old snapshot omitted readiness_phase", () => {
  const healthStatus = {
    servers: {
      scheduling: {
        status: "starting",
        deployment: "core",
      },
    },
    sync_diagnostics: {
      lagging_server_ids: ["scheduling"],
    },
  };
  const previousHealthStatus = {
    servers: {
      scheduling: {
        status: "healthy",
        running: true,
        error: null,
      },
    },
  };

  preserveLaggingServerStates(healthStatus, previousHealthStatus);

  assert.equal(healthStatus.servers.scheduling.status, "healthy");
  assert.equal(healthStatus.servers.scheduling.readiness_phase, "tool_ready");
});

test("preserves needs_oauth lagging servers with oauth state", () => {
  const healthStatus = {
    servers: {
      "portico-taxonomy": {
        status: "starting",
        deployment: "docker",
      },
    },
    sync_diagnostics: {
      lagging_server_ids: ["portico-taxonomy"],
    },
  };
  const previousHealthStatus = {
    servers: {
      "portico-taxonomy": {
        status: "needs_oauth",
        readiness_phase: "needs_oauth",
        oauth_state: "active",
        authorization_url_available: true,
        running: false,
        error: "Server configured but waiting for OAuth authorization",
      },
    },
  };

  preserveLaggingServerStates(healthStatus, previousHealthStatus);

  assert.equal(healthStatus.servers["portico-taxonomy"].status, "needs_oauth");
  assert.equal(
    healthStatus.servers["portico-taxonomy"].oauth_state,
    "active",
  );
  assert.equal(
    healthStatus.servers["portico-taxonomy"].authorization_url_available,
    true,
  );
});

test("does not preserve previous transient lagging state", () => {
  const healthStatus = {
    servers: {
      datadog: {
        status: "starting",
        deployment: "docker",
      },
    },
    sync_diagnostics: {
      lagging_server_ids: ["datadog"],
    },
  };
  const previousHealthStatus = {
    servers: {
      datadog: {
        status: "starting",
      },
    },
  };

  preserveLaggingServerStates(healthStatus, previousHealthStatus);

  assert.equal(healthStatus.servers.datadog.status, "starting");
  assert.deepEqual(healthStatus.sync_diagnostics.preserved_server_ids, []);
  assert.equal(healthStatus.sync_diagnostics.preserved_servers, 0);
});
