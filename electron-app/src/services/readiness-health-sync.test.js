const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildHealthSummary,
  shouldReconcileHealthStatusFromReadiness,
  reconcileHealthStatusFromReadiness,
} = require("./readiness-health-sync");

test("buildHealthSummary recounts known buckets from server entries", () => {
  const summary = buildHealthSummary({
    healthy: { status: "healthy" },
    oauth: { status: "needs_oauth" },
    failed: { status: "failed" },
    checking: { status: "checking" },
  });

  assert.deepEqual(summary, {
    total: 4,
    healthy: 1,
    needs_oauth: 1,
    timeout: 0,
    failed: 1,
    not_running: 0,
    not_configured: 0,
    starting: 1,
    disabled: 0,
  });
});

test("shouldReconcileHealthStatusFromReadiness only reconciles terminal non-host states", () => {
  assert.equal(
    shouldReconcileHealthStatusFromReadiness({
      deploymentType: "docker",
      healthy: true,
    }),
    true,
  );
  assert.equal(
    shouldReconcileHealthStatusFromReadiness({
      deploymentType: "docker",
      readinessPhase: "needs_oauth",
    }),
    true,
  );
  assert.equal(
    shouldReconcileHealthStatusFromReadiness({
      deploymentType: "docker",
      readinessPhase: "starting",
      healthy: false,
    }),
    false,
  );
  assert.equal(
    shouldReconcileHealthStatusFromReadiness({
      deploymentType: "host",
      healthy: true,
    }),
    false,
  );
});

test("reconcileHealthStatusFromReadiness promotes a ready server to healthy and recomputes summary", () => {
  const healthData = {
    servers: {
      "gitlab-mcp": {
        status: "starting",
        error: "Server is still initializing",
        running: false,
      },
      slack: {
        status: "not_configured",
        error: "missing token",
        running: false,
      },
    },
    summary: {
      total: 2,
      healthy: 0,
      needs_oauth: 0,
      timeout: 0,
      failed: 0,
      not_running: 0,
      not_configured: 1,
      starting: 1,
      disabled: 0,
    },
  };

  const result = reconcileHealthStatusFromReadiness(
    "gitlab-mcp",
    {
      deploymentType: "docker",
      healthy: true,
      readinessPhase: "tool_ready",
    },
    {
      healthData,
      host: "localhost",
      port: 8765,
    },
  );

  assert.equal(result, healthData);
  assert.deepEqual(healthData.servers["gitlab-mcp"], {
    status: "healthy",
    error: null,
    running: true,
    host: "localhost",
    port: 8765,
    oauth_state: null,
    configured: true,
  });
  assert.deepEqual(healthData.summary, {
    total: 2,
    healthy: 1,
    needs_oauth: 0,
    timeout: 0,
    failed: 0,
    not_running: 0,
    not_configured: 1,
    starting: 0,
    disabled: 0,
  });
});

test("reconcileHealthStatusFromReadiness records needs_oauth state", () => {
  const healthData = {
    servers: {
      datadog: {
        status: "starting",
        error: "Server is still initializing",
        running: false,
      },
    },
    summary: {
      total: 1,
      healthy: 0,
      needs_oauth: 0,
      timeout: 0,
      failed: 0,
      not_running: 0,
      not_configured: 0,
      starting: 1,
      disabled: 0,
    },
  };

  reconcileHealthStatusFromReadiness(
    "datadog",
    {
      deploymentType: "docker",
      readinessPhase: "needs_oauth",
      oauthState: "active",
    },
    { healthData },
  );

  assert.equal(healthData.servers.datadog.status, "needs_oauth");
  assert.equal(healthData.servers.datadog.configured, true);
  assert.equal(healthData.summary.needs_oauth, 1);
  assert.equal(healthData.summary.starting, 0);
});

test("reconcileHealthStatusFromReadiness skips non-terminal readiness and validates health data", () => {
  assert.equal(
    reconcileHealthStatusFromReadiness(
      "gitlab-mcp",
      {
        deploymentType: "docker",
        readinessPhase: "starting",
      },
      { healthData: { servers: {}, summary: {} } },
    ),
    null,
  );

  assert.throws(
    () =>
      reconcileHealthStatusFromReadiness("gitlab-mcp", {
        deploymentType: "docker",
        healthy: true,
      }),
    /healthData \(object\) is required/,
  );
});
