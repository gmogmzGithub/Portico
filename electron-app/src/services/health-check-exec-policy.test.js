const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getHealthCheckExecTimeoutMs,
  isHealthCheckExecTimeout,
  normalizeHealthCheckMode,
} = require("./health-check-exec-policy");

test("normalizeHealthCheckMode keeps supported modes and falls back to light", () => {
  assert.equal(normalizeHealthCheckMode("full"), "full");
  assert.equal(normalizeHealthCheckMode("startup-core"), "startup-core");
  assert.equal(normalizeHealthCheckMode("wat"), "light");
  assert.equal(normalizeHealthCheckMode(null), "light");
});

test("getHealthCheckExecTimeoutMs returns mode-specific ceilings", () => {
  assert.equal(getHealthCheckExecTimeoutMs("light"), 30000);
  assert.equal(getHealthCheckExecTimeoutMs("startup-core"), 120000);
  assert.equal(getHealthCheckExecTimeoutMs("full"), 180000);
  assert.equal(getHealthCheckExecTimeoutMs("unknown"), 30000);
});

test("isHealthCheckExecTimeout recognizes exec timeout signatures", () => {
  assert.equal(
    isHealthCheckExecTimeout({ timedOut: true }),
    true,
  );
  assert.equal(
    isHealthCheckExecTimeout({ message: "Command failed: timed out after 30000 milliseconds" }),
    true,
  );
  assert.equal(
    isHealthCheckExecTimeout({ killed: true }),
    true,
  );
  assert.equal(
    isHealthCheckExecTimeout({ signal: "SIGTERM" }),
    true,
  );
  assert.equal(
    isHealthCheckExecTimeout({ message: "connection refused" }),
    false,
  );
});
