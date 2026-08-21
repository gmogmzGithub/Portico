// Logs panel component
// Handles initialization of service log buttons in the compact sidebar

// Display name mapping for services
const logsPanelServiceNames = {
  "llm-gateway": "LLM Gateway",
  "mcpo-core": "MCP Control Plane",
  "mcpo-openapi-aggregator": "MCP Control Plane",
  "mcpo-core-openapi-aggregator": "MCP Control Plane",
  mcpo: "MCP Control Plane",
  "host-mcpo": "Host MCP Runtime",
  "host-mcp-bridge": "Host MCP Bridge",
  "portico-open-webui": "Open WebUI",
  "open-webui-health-check": "Health Check",
};

function initLogsPanel() {
  // Wire up compact service log buttons to use the new log viewer modal
  const serviceLogButtons = document.querySelectorAll(
    ".service-logs-btn-compact",
  );

  serviceLogButtons.forEach((btn) => {
    // Remove any existing listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const service = e.currentTarget.dataset.service;

      // Use the new log viewer modal
      if (window.openLogViewerModal) {
        const displayName = logsPanelServiceNames[service] || service;
        window.openLogViewerModal(null, service, {
          name: displayName,
          icon: null,
        });
      }
    });
  });
}

// Call init after a short delay to ensure DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initLogsPanel, 100);
});

window.initLogsPanel = initLogsPanel;
