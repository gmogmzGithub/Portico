const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectToggleLifecycleNoop,
  normalizeReadinessPhase,
} = require("./toggle-lifecycle-noop");

test("normalizeReadinessPhase reads both readinessPhase and readiness_phase", () => {
  assert.equal(normalizeReadinessPhase({ readinessPhase: "tool_ready" }), "tool_ready");
  assert.equal(normalizeReadinessPhase({ readiness_phase: "disabled" }), "disabled");
  assert.equal(
    normalizeReadinessPhase({ readiness_phase: "healthy", healthy: true }),
    "tool_ready",
  );
  assert.equal(normalizeReadinessPhase(null), null);
});

test("detectToggleLifecycleNoop returns disabled no-op when toggle is off and container is not running", async () => {
  const result = await detectToggleLifecycleNoop("google_workspace", false, {
    deploymentType: "docker",
    isServerEffectivelyEnabled: () => false,
    getServerReadinessStatus: () => ({ readinessPhase: "disabled", healthy: false }),
    getMcpoServerStatus: () => ({ running: false, status: "not_found" }),
  });

  assert.deepEqual(result, {
    enabled: false,
    healthy: false,
    readinessPhase: "disabled",
    message: "Server google_workspace is already disabled.",
  });
});

test("detectToggleLifecycleNoop does not suppress disable when the container is still running", async () => {
  const result = await detectToggleLifecycleNoop("google_workspace", false, {
    deploymentType: "docker",
    isServerEffectivelyEnabled: () => false,
    getServerReadinessStatus: () => ({ readinessPhase: "disabled", healthy: false }),
    getMcpoServerStatus: () => ({ running: true, status: "running" }),
  });

  assert.equal(result, null);
});

test("detectToggleLifecycleNoop returns enabled ready no-op", async () => {
  const result = await detectToggleLifecycleNoop("google_workspace", true, {
    deploymentType: "docker",
    isServerEffectivelyEnabled: () => true,
    getServerReadinessStatus: () => ({ readinessPhase: "tool_ready", healthy: true }),
  });

  assert.deepEqual(result, {
    enabled: true,
    healthy: true,
    readinessPhase: "tool_ready",
    message: "Server google_workspace is already enabled and its tools are ready.",
  });
});

test("detectToggleLifecycleNoop returns enabled oauth-ready no-op", async () => {
  const result = await detectToggleLifecycleNoop("google_workspace", true, {
    deploymentType: "docker",
    isServerEffectivelyEnabled: () => true,
    getServerReadinessStatus: () => ({ readinessPhase: "needs_oauth", healthy: false }),
  });

  assert.deepEqual(result, {
    enabled: true,
    healthy: false,
    readinessPhase: "needs_oauth",
    message: "Server google_workspace is already enabled and is ready for OAuth authorization.",
  });
});

test("detectToggleLifecycleNoop returns null when enable still needs lifecycle work", async () => {
  const result = await detectToggleLifecycleNoop("google_workspace", true, {
    deploymentType: "docker",
    isServerEffectivelyEnabled: () => false,
    getServerReadinessStatus: () => ({ readinessPhase: "disabled", healthy: false }),
  });

  assert.equal(result, null);
});
