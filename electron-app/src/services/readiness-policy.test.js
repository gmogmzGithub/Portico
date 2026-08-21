const test = require("node:test");
const assert = require("node:assert/strict");

const {
  disabledReadinessSeed,
  isServerEffectivelyEnabled,
} = require("./readiness-policy");

test("isServerEffectivelyEnabled keeps core servers enabled regardless of toggle state", () => {
  const dockerMcpImpl = {
    isCoreServer(serverId) {
      return serverId === "skills";
    },
    getMcpTogglesSync() {
      return { skills: false };
    },
    computeEffectiveMcpToggles(rawToggles) {
      return rawToggles;
    },
  };

  assert.equal(isServerEffectivelyEnabled("skills", dockerMcpImpl), true);
});

test("isServerEffectivelyEnabled respects effective toggle policy for non-core servers", () => {
  const dockerMcpImpl = {
    isCoreServer() {
      return false;
    },
    getMcpTogglesSync() {
      return { time: false, slack: true };
    },
    computeEffectiveMcpToggles(rawToggles) {
      return rawToggles;
    },
  };

  assert.equal(isServerEffectivelyEnabled("time", dockerMcpImpl), false);
  assert.equal(isServerEffectivelyEnabled("slack", dockerMcpImpl), true);
});

test("isServerEffectivelyEnabled recovers from toggle read errors by using empty toggle state", () => {
  const calls = [];
  const dockerMcpImpl = {
    isCoreServer() {
      return false;
    },
    getMcpTogglesSync() {
      throw new Error("broken toggles");
    },
    computeEffectiveMcpToggles(rawToggles) {
      calls.push(rawToggles);
      return { time: false, slack: true };
    },
  };

  assert.equal(isServerEffectivelyEnabled("time", dockerMcpImpl), false);
  assert.equal(isServerEffectivelyEnabled("slack", dockerMcpImpl), true);
  assert.deepEqual(calls, [{}, {}]);
});

test("disabledReadinessSeed produces disabled rather than starting", () => {
  assert.deepEqual(disabledReadinessSeed(), {
    healthy: false,
    readiness_phase: "disabled",
    status: "disabled",
    error: null,
  });
});
