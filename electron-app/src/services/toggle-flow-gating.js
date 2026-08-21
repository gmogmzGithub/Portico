const { waitForSameServerFlow } = require("./oauth-flow-lifecycle");

async function waitForToggleFlowGate(
  serverId,
  activeSetupFlows,
  options = {},
) {
  if (!activeSetupFlows?.has(serverId)) {
    return null;
  }

  const waitForSameServerFlowImpl =
    options.waitForSameServerFlowImpl || waitForSameServerFlow;
  const conflicting = await waitForSameServerFlowImpl(
    serverId,
    activeSetupFlows,
    {
      maxWaitMs: options.maxWaitMs,
    },
  );

  if (!conflicting) {
    return null;
  }

  return {
    success: false,
    error: `A setup flow is already in progress for this server (${conflicting}). Wait for it to complete.`,
    errorCode: "FLOW_IN_PROGRESS",
    server_id: serverId,
  };
}

module.exports = {
  waitForToggleFlowGate,
};
