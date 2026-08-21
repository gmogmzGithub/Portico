const test = require("node:test");
const assert = require("node:assert/strict");

const { waitForToggleFlowGate } = require("./toggle-flow-gating");

test("waitForToggleFlowGate returns null when there is no active flow", async () => {
  let waited = false;
  const result = await waitForToggleFlowGate("google_workspace", new Map(), {
    waitForSameServerFlowImpl: async () => {
      waited = true;
      return null;
    },
  });

  assert.equal(result, null);
  assert.equal(waited, false);
});

test("waitForToggleFlowGate allows the toggle when the same-server flow clears", async () => {
  const activeSetupFlows = new Map([["google_workspace", "toggle"]]);
  let calls = 0;
  const result = await waitForToggleFlowGate("google_workspace", activeSetupFlows, {
    waitForSameServerFlowImpl: async (serverId, flows) => {
      calls += 1;
      assert.equal(serverId, "google_workspace");
      assert.equal(flows, activeSetupFlows);
      flows.delete(serverId);
      return null;
    },
  });

  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("waitForToggleFlowGate returns FLOW_IN_PROGRESS when the wait times out", async () => {
  const activeSetupFlows = new Map([["google_workspace", "toggle"]]);
  const result = await waitForToggleFlowGate("google_workspace", activeSetupFlows, {
    waitForSameServerFlowImpl: async () => "google_workspace(toggle)",
  });

  assert.deepEqual(result, {
    success: false,
    error: "A setup flow is already in progress for this server (google_workspace(toggle)). Wait for it to complete.",
    errorCode: "FLOW_IN_PROGRESS",
    server_id: "google_workspace",
  });
});
