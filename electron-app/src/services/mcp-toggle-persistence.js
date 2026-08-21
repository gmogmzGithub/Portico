async function persistMcpToggleState(serverId, enabled, options = {}) {
  const {
    mutateToggles,
    reasonPrefix = 'persist-mcp-toggle',
  } = options;

  if (!serverId || typeof serverId !== 'string') {
    throw new Error('server_id (string) is required');
  }

  if (typeof enabled !== 'boolean') {
    throw new Error('enabled (boolean) is required');
  }

  if (typeof mutateToggles !== 'function') {
    throw new Error('mutateToggles must be a function');
  }

  await mutateToggles(
    (toggles) => {
      toggles[serverId] = enabled;
    },
    {
      reason: `${reasonPrefix}:${serverId}:${enabled ? 'enable' : 'disable'}`,
    },
  );

  return {
    server_id: serverId,
    enabled,
  };
}

module.exports = {
  persistMcpToggleState,
};
