function isServerEffectivelyEnabled(serverId, dockerMcpImpl) {
  if (!serverId || typeof serverId !== "string") {
    throw new TypeError("serverId (string) is required");
  }

  if (typeof dockerMcpImpl?.isCoreServer === "function" && dockerMcpImpl.isCoreServer(serverId)) {
    return true;
  }

  if (
    typeof dockerMcpImpl?.getMcpTogglesSync !== "function" ||
    typeof dockerMcpImpl?.computeEffectiveMcpToggles !== "function"
  ) {
    return true;
  }

  let rawToggles = {};
  try {
    rawToggles = dockerMcpImpl.getMcpTogglesSync();
  } catch (_error) {
    rawToggles = {};
  }
  const effectiveToggles = dockerMcpImpl.computeEffectiveMcpToggles(rawToggles);
  return effectiveToggles[serverId] !== false;
}

function disabledReadinessSeed() {
  return {
    healthy: false,
    readiness_phase: "disabled",
    status: "disabled",
    error: null,
  };
}

module.exports = {
  disabledReadinessSeed,
  isServerEffectivelyEnabled,
};
