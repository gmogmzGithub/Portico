const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalizeReadinessPhase,
  defaultReadinessPhaseForStatus,
} = require("./readiness-phase");

test("canonicalizeReadinessPhase rewrites explicit healthy to tool_ready", () => {
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: true,
      readiness_phase: "healthy",
      status: "healthy",
    }),
    "tool_ready",
  );
});

test("canonicalizeReadinessPhase promotes healthy servers without an explicit phase", () => {
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: true,
      status: "healthy",
    }),
    "tool_ready",
  );
});

test("canonicalizeReadinessPhase preserves explicit OAuth and startup phases", () => {
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      readinessPhase: "needs_oauth",
      status: "healthy",
    }),
    "needs_oauth",
  );
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      readinessPhase: "waiting_callback",
      status: "healthy",
    }),
    "waiting_callback",
  );
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      readinessPhase: "checking_tokens",
      status: "healthy",
    }),
    "checking_tokens",
  );
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      readinessPhase: "starting",
      status: "healthy",
    }),
    "starting",
  );
});

test("canonicalizeReadinessPhase preserves meaningful non-ready status values when phase is missing", () => {
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      status: "needs_oauth",
    }),
    "needs_oauth",
  );
  assert.equal(
    canonicalizeReadinessPhase({
      healthy: false,
      status: "not_configured",
    }),
    "not_configured",
  );
});

test("defaultReadinessPhaseForStatus falls back to starting for unknown statuses", () => {
  assert.equal(defaultReadinessPhaseForStatus("healthy"), "tool_ready");
  assert.equal(defaultReadinessPhaseForStatus("wat"), "starting");
});
