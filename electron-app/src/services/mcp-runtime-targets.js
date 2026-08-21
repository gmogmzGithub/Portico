function normalizeServerIds(serverIds) {
  return Array.from(
    new Set(
      (Array.isArray(serverIds) ? serverIds : [])
        .filter((serverId) => typeof serverId === "string" && serverId.trim())
        .map((serverId) => serverId.trim()),
    ),
  );
}

function groupDockerRuntimeTargets(serverIds, getConfiguredMcpoRuntimeTarget) {
  if (typeof getConfiguredMcpoRuntimeTarget !== "function") {
    throw new TypeError(
      "getConfiguredMcpoRuntimeTarget (function) is required",
    );
  }

  const groupedTargets = new Map();

  for (const serverId of normalizeServerIds(serverIds)) {
    const runtimeTarget = getConfiguredMcpoRuntimeTarget(serverId) || {};
    const composeService =
      runtimeTarget.composeService ||
      runtimeTarget.containerName ||
      `mcpo-${serverId}`;
    const containerName =
      runtimeTarget.containerName ||
      runtimeTarget.composeService ||
      `mcpo-${serverId}`;
    const deploymentScope = runtimeTarget.deploymentScope || "docker";
    const key = `${composeService}:::${containerName}`;

    if (!groupedTargets.has(key)) {
      groupedTargets.set(key, {
        composeService,
        containerName,
        deploymentScope,
        groupId: runtimeTarget.groupId || null,
        grouped: Boolean(runtimeTarget.grouped || runtimeTarget.groupId),
        serverIds: [],
      });
    }

    groupedTargets.get(key).serverIds.push(serverId);
  }

  return Array.from(groupedTargets.values());
}

function buildAggregatorInvalidationScope(targets) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  let includeRegular = false;
  let includeCore = false;

  for (const target of normalizedTargets) {
    if (!target || typeof target !== "object") {
      continue;
    }

    if (target.deploymentScope === "core") {
      includeCore = true;
    } else {
      includeRegular = true;
    }
  }

  return {
    includeRegular,
    includeCore,
  };
}

module.exports = {
  normalizeServerIds,
  groupDockerRuntimeTargets,
  buildAggregatorInvalidationScope,
};
