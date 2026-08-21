const test = require("node:test");
const assert = require("node:assert/strict");

const {
  serverLifecycle,
  serverLifecycleEmitter,
  updateServerPhase,
} = require("./shared-state");

test("server lifecycle rejects stale operation revisions and sequences", () => {
  const serverId = `revision-owned-${Date.now()}`;
  const events = [];
  const listener = (event) => {
    if (event.serverId === serverId) events.push(event);
  };
  serverLifecycleEmitter.on("transition", listener);

  updateServerPhase(serverId, "starting", {
    operationId: "operation-new",
    desiredRevision: 4,
    transitionSequence: 2,
    operationStatus: "running",
  });
  updateServerPhase(serverId, "tool_ready", {
    healthy: true,
    operationId: "operation-old",
    desiredRevision: 3,
    transitionSequence: 99,
    operationStatus: "succeeded",
  });
  updateServerPhase(serverId, "tool_ready", {
    healthy: true,
    operationId: "operation-new",
    desiredRevision: 4,
    transitionSequence: 1,
    operationStatus: "succeeded",
  });

  assert.equal(serverLifecycle.get(serverId).phase, "starting");
  assert.equal(serverLifecycle.get(serverId).desiredRevision, 4);
  assert.equal(events.length, 1);

  serverLifecycleEmitter.off("transition", listener);
  serverLifecycle.delete(serverId);
});

test("unscoped health samples cannot overwrite an active operation owner", () => {
  const serverId = `unscoped-owned-${Date.now()}`;
  updateServerPhase(serverId, "starting", {
    operationId: "operation-active",
    desiredRevision: 8,
    transitionSequence: 1,
    operationStatus: "running",
  });
  updateServerPhase(serverId, "disabled", { healthy: false });

  assert.equal(serverLifecycle.get(serverId).phase, "starting");

  updateServerPhase(serverId, "tool_ready", {
    healthy: true,
    operationId: "operation-active",
    desiredRevision: 8,
    transitionSequence: 2,
    operationStatus: "succeeded",
  });
  updateServerPhase(serverId, "needs_oauth", { healthy: false });
  assert.equal(serverLifecycle.get(serverId).phase, "needs_oauth");

  serverLifecycle.delete(serverId);
});
