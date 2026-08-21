const LOCAL_SERVICE_PORTS = Object.freeze({
  setupAuthCallback: 8877,
  gitlabMarketplaceAuthCallback: 8878,
  llmDebugMonitor: 8879,
});

function assertUniqueLocalServicePorts(ports = LOCAL_SERVICE_PORTS) {
  const ownersByPort = new Map();

  for (const [owner, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid local service port for ${owner}: ${port}`);
    }

    const existingOwner = ownersByPort.get(port);
    if (existingOwner) {
      throw new Error(
        `Local service port ${port} is assigned to both ${existingOwner} and ${owner}`,
      );
    }
    ownersByPort.set(port, owner);
  }

  return true;
}

function getLlmDebugMonitorBaseUrl(host = "localhost") {
  return `http://${host}:${LOCAL_SERVICE_PORTS.llmDebugMonitor}`;
}

assertUniqueLocalServicePorts();

module.exports = {
  LOCAL_SERVICE_PORTS,
  assertUniqueLocalServicePorts,
  getLlmDebugMonitorBaseUrl,
};
