function getServerDeploymentType(server) {
  return server?.deploymentType || server?.deployment_type || "docker";
}

function ensureGuidedSetupToggleState(setupState = {}) {
  if (!setupState.mcpToggleState || typeof setupState.mcpToggleState !== "object") {
    setupState.mcpToggleState = {};
  }
  const toggleState = setupState.mcpToggleState;
  if (!toggleState.baseline || typeof toggleState.baseline !== "object") {
    toggleState.baseline = {
      loaded: false,
      exists: false,
      contentHash: null,
      parseError: null,
      toggles: {},
    };
  }
  if (
    !toggleState.baseline.toggles ||
    typeof toggleState.baseline.toggles !== "object" ||
    Array.isArray(toggleState.baseline.toggles)
  ) {
    toggleState.baseline.toggles = {};
  }
  if (
    !toggleState.changes ||
    typeof toggleState.changes !== "object" ||
    Array.isArray(toggleState.changes)
  ) {
    toggleState.changes = {};
  }
  if (toggleState.writeMode !== "apply") {
    toggleState.writeMode = "preserve";
  }
  return toggleState;
}

function setGuidedSetupToggleBaseline(setupState, toggles = {}, options = {}) {
  const toggleState = ensureGuidedSetupToggleState(setupState);
  toggleState.baseline = {
    loaded: true,
    exists: options.exists === true,
    contentHash:
      typeof options.contentHash === "string" ? options.contentHash : null,
    parseError: options.parseError || null,
    toggles:
      toggles && typeof toggles === "object" && !Array.isArray(toggles)
        ? { ...toggles }
        : {},
  };
  toggleState.changes = {};
  toggleState.writeMode = "preserve";
  return toggleState;
}

function recordGuidedSetupToggleChange(setupState, serverId, enabled) {
  if (typeof serverId !== "string" || !serverId || typeof enabled !== "boolean") {
    return false;
  }
  const toggleState = ensureGuidedSetupToggleState(setupState);
  if (toggleState.baseline.toggles[serverId] === enabled) {
    delete toggleState.changes[serverId];
  } else {
    toggleState.changes[serverId] = enabled;
  }
  toggleState.writeMode =
    Object.keys(toggleState.changes).length > 0 ? "apply" : "preserve";
  return true;
}

function preserveGuidedSetupToggleState(setupState) {
  const toggleState = ensureGuidedSetupToggleState(setupState);
  toggleState.changes = {};
  toggleState.writeMode = "preserve";
  return toggleState;
}

function normalizeGuidedSetupDisabledServerIds(values = []) {
  const ids = new Set();

  const iterable = values instanceof Set
    ? Array.from(values)
    : Array.isArray(values)
      ? values
      : [];

  iterable.forEach((value) => {
    if (typeof value === "string" && value.length > 0) {
      ids.add(value);
    }
  });

  return ids;
}

function isGuidedSetupDisabledServer(server, options = {}) {
  if (!server?.id) {
    return false;
  }

  const disabledServerIds = normalizeGuidedSetupDisabledServerIds(
    options.guidedSetupDisabledServerIds,
  );
  return disabledServerIds.has(server.id);
}

function getGuidedSetupDisabledTooltip(server, options = {}) {
  if (!server?.id) {
    return null;
  }

  const tooltips =
    options.guidedSetupDisabledTooltips &&
    typeof options.guidedSetupDisabledTooltips === "object" &&
    !Array.isArray(options.guidedSetupDisabledTooltips)
      ? options.guidedSetupDisabledTooltips
      : {};
  const tooltip = tooltips[server.id];
  return typeof tooltip === "string" && tooltip.trim().length > 0
    ? tooltip.trim()
    : null;
}

function isGuidedSetupVisibleServer(server, options = {}) {
  const { hostModeSupported = true } = options;

  if (!server || !server.id) {
    return false;
  }
  if (server.isCore === true || server.userInstalled === true) {
    return false;
  }

  return !(getServerDeploymentType(server) === "host" && !hostModeSupported);
}

function isGuidedSetupSelectableServer(server, options = {}) {
  return (
    isGuidedSetupVisibleServer(server, options) &&
    !isGuidedSetupDisabledServer(server, options)
  );
}

function getSelectedServerIdsFromIndices(servers = [], selectedIndices = []) {
  const selectedIds = [];
  const seen = new Set();

  for (const index of Array.isArray(selectedIndices) ? selectedIndices : []) {
    const serverId = servers?.[index]?.id;
    if (typeof serverId !== "string" || !serverId || seen.has(serverId)) {
      continue;
    }
    seen.add(serverId);
    selectedIds.push(serverId);
  }

  return selectedIds;
}

function getSelectedServerIndicesFromIds(servers = [], selectedServerIds = []) {
  const selectedIds = new Set(
    (Array.isArray(selectedServerIds) ? selectedServerIds : []).filter(
      (serverId) => typeof serverId === "string" && serverId.length > 0,
    ),
  );

  return (Array.isArray(servers) ? servers : [])
    .map((server, index) => (selectedIds.has(server?.id) ? index : null))
    .filter((index) => index !== null);
}

function getHealthInfoForServer(server, healthStatus) {
  if (!server?.id) {
    return null;
  }

  return healthStatus?.servers?.[server.id] || null;
}

function isGuidedSetupConfiguredServer(server, healthStatus = null) {
  if (!server) {
    return false;
  }

  const healthInfo = getHealthInfoForServer(server, healthStatus);
  const healthStatusValue = String(healthInfo?.status || "").trim().toLowerCase();
  if (healthStatusValue === "not_configured") {
    return false;
  }
  if (
    healthStatusValue &&
    healthStatusValue !== "unknown" &&
    healthStatusValue !== "failed" &&
    healthStatusValue !== "timeout" &&
    healthStatusValue !== "not_running" &&
    healthStatusValue !== "disabled"
  ) {
    return true;
  }
  if (typeof healthInfo?.configured === "boolean") {
    return healthInfo.configured;
  }

  return Boolean(server.isConfigured);
}

function isGuidedSetupEffectivelyEnabledServer(server, options = {}) {
  const {
    toggles = {},
    hostModeSupported = true,
    guidedSetupDisabledServerIds = [],
  } = options;

  if (!isGuidedSetupSelectableServer(server, {
    hostModeSupported,
    guidedSetupDisabledServerIds,
  })) {
    return false;
  }

  return toggles?.[server.id] === true;
}

function getHydratedGuidedSetupSelectionIndices(options = {}) {
  const {
    servers = [],
    selectedIndices = [],
    toggles = {},
    healthStatus = null,
    hostModeSupported = true,
    guidedSetupDisabledServerIds = [],
  } = options;

  const selectedServerIds = new Set(
    getSelectedServerIdsFromIndices(servers, selectedIndices),
  );
  const normalizedToggles =
    toggles && typeof toggles === "object" && !Array.isArray(toggles)
      ? toggles
      : {};

  for (const server of Array.isArray(servers) ? servers : []) {
    if (isGuidedSetupEffectivelyEnabledServer(server, {
      toggles: normalizedToggles,
      healthStatus,
      hostModeSupported,
      guidedSetupDisabledServerIds,
    })) {
      selectedServerIds.add(server.id);
    }
  }

  return getSelectedServerIndicesFromIds(servers, [...selectedServerIds]);
}

function applyGuidedSetupSelectionToToggles(options = {}) {
  const {
    servers = [],
    selectedIndices = [],
    existingToggles = {},
    hostModeSupported = true,
    guidedSetupDisabledServerIds = [],
  } = options;

  const toggles =
    existingToggles &&
    typeof existingToggles === "object" &&
    !Array.isArray(existingToggles)
      ? { ...existingToggles }
      : {};
  const selectedServerIds = new Set(
    getSelectedServerIdsFromIndices(servers, selectedIndices),
  );

  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server?.id || server.userInstalled === true) {
      continue;
    }

    if (server.isCore === true) {
      toggles[server.id] = true;
      continue;
    }

    if (isGuidedSetupDisabledServer(server, { guidedSetupDisabledServerIds })) {
      toggles[server.id] = false;
      continue;
    }

    if (!isGuidedSetupSelectableServer(server, { hostModeSupported })) {
      continue;
    }

    toggles[server.id] = selectedServerIds.has(server.id);
  }

  return toggles;
}

module.exports = {
  applyGuidedSetupSelectionToToggles,
  ensureGuidedSetupToggleState,
  getGuidedSetupDisabledTooltip,
  getHydratedGuidedSetupSelectionIndices,
  isGuidedSetupConfiguredServer,
  isGuidedSetupDisabledServer,
  isGuidedSetupEffectivelyEnabledServer,
  isGuidedSetupVisibleServer,
  getSelectedServerIdsFromIndices,
  getSelectedServerIndicesFromIds,
  getServerDeploymentType,
  isGuidedSetupSelectableServer,
  normalizeGuidedSetupDisabledServerIds,
  preserveGuidedSetupToggleState,
  recordGuidedSetupToggleChange,
  setGuidedSetupToggleBaseline,
};
