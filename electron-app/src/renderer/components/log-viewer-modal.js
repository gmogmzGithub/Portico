// Log Viewer Modal Component
// Displays logs for MCP servers in a fancy modal (replaces the old side panel)

const ANSI_ESCAPE_REGEX = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Module state for the modal
let logViewerState = {
  serverId: null,
  serverName: null,
  serverIcon: null,
  serviceName: null, // Docker service name (e.g., mcpo-time, mcpo-core-artifacts)
  logSource: null, // docker, host, inline
  logProvider: null, // Optional function returning log text
  logs: "",
  isLoading: false,
  fetchPromise: null,
  autoRefresh: true,
  refreshInterval: null,
  searchQuery: "",
  logLevel: "all", // all, error, warn, info
};

let logViewerInitialized = false;

function sanitizeLogLine(line) {
  if (!line) return "";
  return String(line)
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "");
}

function normalizeLogText(logs) {
  if (!logs) return "";
  return String(logs)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

function normalizeForSearch(value) {
  return sanitizeLogLine(value).toLowerCase();
}

// Service map for display names (core services)
const serviceDisplayNames = {
  "llm-gateway": "LLM Gateway",
  "portico-open-webui": "Open WebUI",
  mcpo: "MCP Control Plane",
  "mcpo-docker": "MCP Control Plane",
  "mcpo-core": "MCP Control Plane",
  "mcpo-openapi-aggregator": "MCP Control Plane",
  "mcpo-core-openapi-aggregator": "MCP Control Plane",
  "host-mcpo": "Host MCP Runtime",
  "host-mcp-bridge": "Host MCP Bridge",
};

function getDockerServiceCandidates(serviceName) {
  if (serviceName === "llm-gateway") {
    return ["llm-gateway"];
  }
  return [serviceName];
}

/**
 * Get display name for a service
 * @param {string} serviceName - The service/container name
 * @returns {string} - Human-friendly display name
 */
function getServiceDisplayName(serviceName) {
  if (serviceDisplayNames[serviceName]) {
    return serviceDisplayNames[serviceName];
  }

  if (serviceName.startsWith("mcpo-group-")) {
    const groupName = serviceName.replace("mcpo-group-", "").replace(/-/g, " ");
    return groupName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  // Handle per-server MCP runtime containers (format: mcpo-{serverId} or mcpo-core-{serverId})
  if (serviceName.startsWith("mcpo-core-")) {
    const serverName = serviceName.replace("mcpo-core-", "").replace(/-/g, " ");
    return serverName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  if (serviceName.startsWith("mcpo-")) {
    const serverName = serviceName.replace("mcpo-", "").replace(/-/g, " ");
    return serverName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return serviceName;
}

/**
 * Parse and colorize log lines
 * @param {string} logs - Raw log text
 * @returns {string} - HTML with colorized log lines
 */
function parseAndColorLogs(logs) {
  if (!logs) return '<div class="log-empty">No logs available</div>';

  const lines = normalizeLogText(logs).split("\n");
  return lines
    .map((line) => {
      const sanitizedLine = sanitizeLogLine(line);
      if (!sanitizedLine.trim()) return "";

      // Escape HTML
      const escapedLine = sanitizedLine
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Determine log level and apply class
      let levelClass = "log-info";
      if (
        /\berror\b/i.test(sanitizedLine) ||
        /\bERROR\b/.test(sanitizedLine) ||
        /\bfailed\b/i.test(sanitizedLine) ||
        /\bexception\b/i.test(sanitizedLine)
      ) {
        levelClass = "log-error";
      } else if (/\bwarn(ing)?\b/i.test(sanitizedLine) || /\bWARN(ING)?\b/.test(sanitizedLine)) {
        levelClass = "log-warn";
      } else if (/\bdebug\b/i.test(sanitizedLine) || /\bDEBUG\b/.test(sanitizedLine)) {
        levelClass = "log-debug";
      } else if (/\binfo\b/i.test(sanitizedLine) || /\bINFO\b/.test(sanitizedLine)) {
        levelClass = "log-info";
      }

      // Highlight timestamps
      let formattedLine = escapedLine
        .replace(
          /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/g,
          '<span class="log-timestamp">$1</span>',
        )
        // Highlight container names
        .replace(
          /^([a-z0-9-]+\s*\|)/i,
          '<span class="log-container">$1</span>',
        );

      return `<div class="log-line ${levelClass}">${formattedLine}</div>`;
    })
    .filter((line) => line)
    .join("");
}

/**
 * Filter logs based on search query and log level
 * @param {string} logs - Raw log text
 * @returns {string} - Filtered log text
 */
function filterLogs(logs) {
  if (!logs) return "";

  let lines = normalizeLogText(logs).split("\n");

  // Filter by log level
  if (logViewerState.logLevel !== "all") {
    lines = lines.filter((line) => {
      const normalizedLine = normalizeForSearch(line);
      switch (logViewerState.logLevel) {
        case "error":
          return /\berror\b|\bfailed\b|\bexception\b/.test(normalizedLine);
        case "warn":
          return /\bwarn(ing)?\b/.test(normalizedLine);
        case "info":
          return /\binfo\b/.test(normalizedLine);
        default:
          return true;
      }
    });
  }

  // Filter by search query
  if (logViewerState.searchQuery) {
    const query = normalizeForSearch(logViewerState.searchQuery);
    lines = lines.filter((line) => normalizeForSearch(line).includes(query));
  }

  return lines.join("\n");
}

/**
 * Check if log container is scrolled to the bottom
 * @param {HTMLElement} container - Log container element
 * @returns {boolean} - True if near bottom
 */
function isLogViewerScrolledToBottom(container) {
  if (!container) return true;
  const threshold = 4;
  return (
    container.scrollTop + container.clientHeight >=
    container.scrollHeight - threshold
  );
}

/**
 * Open the log viewer modal for a specific server
 * @param {string} serverId - The server ID
 * @param {string} serviceName - The Docker service name
 * @param {object} serverInfo - Optional server info (name, icon)
 */
async function openLogViewerModal(serverId, serviceName, serverInfo = {}) {
  // Find server info if not provided
  const state = window.appState;
  const server =
    serverInfo.server || state?.servers?.find((s) => s.id === serverId);

  const hasInlineLogs = typeof serverInfo.logs === "string";
  const logProvider =
    typeof serverInfo.logProvider === "function" ? serverInfo.logProvider : null;
  const logSource =
    serverInfo.logSource || (logProvider || hasInlineLogs ? "inline" : null);
  // Update state
  logViewerState.serverId = serverId;
  logViewerState.serverName =
    serverInfo.name ||
    server?.display_name ||
    server?.name ||
    (serviceName && serviceName !== "inline"
      ? getServiceDisplayName(serviceName)
      : "Logs");
  logViewerState.serverIcon = serverInfo.icon || server?.icon || null;
  logViewerState.serviceName = serviceName;
  logViewerState.logSource = logSource;
  logViewerState.logProvider = logProvider;
  logViewerState.logs = hasInlineLogs ? serverInfo.logs : "";
  logViewerState.isLoading = true;
  logViewerState.fetchPromise = null;
  logViewerState.searchQuery = "";
  logViewerState.logLevel = "all";
  logViewerState.autoRefresh = true;

  // Reset UI
  const searchInput = document.getElementById("log-viewer-search");
  if (searchInput) searchInput.value = "";

  const filterBtns = document.querySelectorAll(
    "#log-viewer-modal .mcp-filter-tab",
  );
  filterBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === "all");
  });

  const autoRefreshToggle = document.getElementById("log-auto-refresh");
  if (autoRefreshToggle) autoRefreshToggle.checked = true;

  // Render header immediately
  renderLogViewerHeader();
  showLogLoadingState();

  // Show modal
  const modal = document.getElementById("log-viewer-modal");
  if (modal) {
    modal.classList.add("visible");
  }

  // Fetch logs
  await fetchAndDisplayLogs();

  // Start auto-refresh
  startAutoRefresh();
}

/**
 * Render the modal header
 */
function renderLogViewerHeader() {
  const logoEl = document.getElementById("log-viewer-logo");
  if (logoEl) {
    if (logViewerState.serverIcon) {
      logoEl.innerHTML = `<img src="${logViewerState.serverIcon}" alt="${logViewerState.serverName}">`;
    } else {
      logoEl.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
      `;
    }
  }

  const titleEl = document.getElementById("log-viewer-title");
  if (titleEl) {
    const titleBase = logViewerState.serverName || "Logs";
    titleEl.textContent = titleBase.endsWith("Logs")
      ? titleBase
      : `${titleBase} Logs`;
  }
}

/**
 * Show loading state in the log container
 */
function showLogLoadingState() {
  const container = document.getElementById("log-viewer-content");
  if (container) {
    container.innerHTML = `
      <div class="log-loading">
        <div class="log-loading-spinner"></div>
        <span>Loading logs...</span>
      </div>
    `;
  }
}

/**
 * Show error state in the log container
 * @param {string} error - Error message
 */
function showLogErrorState(error) {
  const container = document.getElementById("log-viewer-content");
  if (container) {
    container.innerHTML = `
      <div class="log-error-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <p>Failed to load logs</p>
        <span class="log-error-message">${error}</span>
        <button class="btn btn-secondary" onclick="fetchAndDisplayLogs()">Retry</button>
      </div>
    `;
  }
}

/**
 * Fetch and display logs
 */
async function fetchAndDisplayLogs() {
  if (logViewerState.fetchPromise) {
    return logViewerState.fetchPromise;
  }

  const fetchPromise = fetchAndDisplayLogsUntracked();
  logViewerState.fetchPromise = fetchPromise;
  try {
    return await fetchPromise;
  } finally {
    if (logViewerState.fetchPromise === fetchPromise) {
      logViewerState.fetchPromise = null;
    }
  }
}

async function fetchAndDisplayLogsUntracked() {
  const container = document.getElementById("log-viewer-content");
  if (!container) return;

  try {
    let logs = "";
    const serviceName = logViewerState.serviceName;

    if (logViewerState.logProvider) {
      const providerResult = await logViewerState.logProvider();
      if (typeof providerResult === "string") {
        logs = providerResult;
      } else if (providerResult && typeof providerResult.logs === "string") {
        logs = providerResult.logs;
      } else {
        logs = "";
      }
    } else if (logViewerState.logSource === "inline" || serviceName === "inline") {
      logs = logViewerState.logs || "";
    } else if (serviceName) {
      // Determine if this is a host-mode server or docker
      if (serviceName === "host-mcpo") {
        const result = await window.electronAPI.hostMcpoLogs(500);
        if (result.success) {
          logs = result.logs || "No logs available";
        } else {
          throw new Error(result.error || "Failed to fetch host logs");
        }
      } else if (serviceName === "host-mcp-bridge") {
        const result = await window.electronAPI.hostMcpBridgeLogs(500);
        if (result.success) {
          logs = result.logs || "No logs available";
        } else {
          throw new Error(result.error || "Failed to fetch host bridge logs");
        }
      } else {
        // Docker logs
        let result = null;
        for (const candidate of getDockerServiceCandidates(serviceName)) {
          result = await window.electronAPI.dockerLogs(candidate, 500);
          if (result.success) {
            logs = result.logs || "No logs available";
            break;
          }
        }

        if (!logs) {
          throw new Error(result?.error || "Failed to fetch Docker logs");
        }
      }
    }

    logViewerState.logs = logs;
    logViewerState.isLoading = false;
    renderLogs();
  } catch (error) {
    console.error("[Log Viewer] Error fetching logs:", error);
    logViewerState.isLoading = false;
    showLogErrorState(error.message);
  }
}

/**
 * Render logs to the container
 */
function renderLogs() {
  const container = document.getElementById("log-viewer-content");
  if (!container) return;

  const wasAtBottom = isLogViewerScrolledToBottom(container);
  const previousScrollTop = container.scrollTop;

  const filteredLogs = filterLogs(logViewerState.logs);
  const colorizedLogs = parseAndColorLogs(filteredLogs);

  container.innerHTML =
    colorizedLogs ||
    '<div class="log-empty">No logs match the current filter</div>';

  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    const maxScrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    container.scrollTop = Math.min(previousScrollTop, maxScrollTop);
  }

  // Update line count
  const lineCount = document.getElementById("log-line-count");
  if (lineCount) {
    const lines = normalizeLogText(filteredLogs)
      .split("\n")
      .filter((l) => l.trim()).length;
    const totalLines = normalizeLogText(logViewerState.logs)
      .split("\n")
      .filter((l) => l.trim()).length;
    if (lines === totalLines) {
      lineCount.textContent = `${lines} lines`;
    } else {
      lineCount.textContent = `${lines} / ${totalLines} lines`;
    }
  }
}

/**
 * Start auto-refresh interval
 */
function startAutoRefresh() {
  stopAutoRefresh();

  if (logViewerState.autoRefresh) {
    logViewerState.refreshInterval = setInterval(() => {
      if (
        logViewerState.autoRefresh &&
        document
          .getElementById("log-viewer-modal")
          ?.classList.contains("visible")
      ) {
        fetchAndDisplayLogs();
      }
    }, 2000);
  }
}

/**
 * Stop auto-refresh interval
 */
function stopAutoRefresh() {
  if (logViewerState.refreshInterval) {
    clearInterval(logViewerState.refreshInterval);
    logViewerState.refreshInterval = null;
  }
}

/**
 * Toggle auto-refresh
 */
function toggleAutoRefresh() {
  logViewerState.autoRefresh = true;
  const toggle = document.getElementById("log-auto-refresh");
  if (toggle) toggle.checked = true;
  startAutoRefresh();
}

/**
 * Handle search input
 * @param {string} query - Search query
 */
function handleLogSearch(query) {
  logViewerState.searchQuery = query;
  renderLogs();
}

/**
 * Handle log level filter
 * @param {string} level - Log level (all, error, warn, info)
 */
function handleLogFilter(level) {
  logViewerState.logLevel = level;

  // Update filter button states
  const filterBtns = document.querySelectorAll(
    "#log-viewer-modal .mcp-filter-tab",
  );
  filterBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === level);
  });

  renderLogs();
}

/**
 * Copy logs to clipboard using Electron IPC
 */
async function copyLogViewerLogsToClipboard() {
  const filteredLogs = filterLogs(logViewerState.logs);
  const copyBtn = document.getElementById("log-viewer-copy-btn");

  if (!filteredLogs) {
    console.warn("[Log Viewer] No logs to copy");
    window.showNotification?.("No logs to copy", "warning");
    return;
  }

  try {
    // Use Electron's clipboard API via IPC (has proper permissions)
    if (window.electronAPI && window.electronAPI.copyToClipboard) {
      console.log("[Log Viewer] Using Electron IPC clipboard");
      await window.electronAPI.copyToClipboard(filteredLogs);
    } else {
      // Fallback for non-Electron context
      console.log("[Log Viewer] Using navigator.clipboard fallback");
      await navigator.clipboard.writeText(filteredLogs);
    }

    // Show success feedback on button
    if (copyBtn) {
      const originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.innerHTML = originalHTML;
        copyBtn.classList.remove("copied");
      }, 2000);
    }

    window.showNotification?.("Logs copied to clipboard", "success");
  } catch (error) {
    console.error("[Log Viewer] Failed to copy to clipboard:", error);
    window.showNotification?.("Failed to copy logs", "error");
  }
}

/**
 * Close the log viewer modal
 */
function closeLogViewerModal() {
  const modal = document.getElementById("log-viewer-modal");
  if (modal) {
    modal.classList.remove("visible");
  }

  // Stop auto-refresh
  stopAutoRefresh();

  // Reset state
  logViewerState.serverId = null;
  logViewerState.serverName = null;
  logViewerState.serverIcon = null;
  logViewerState.serviceName = null;
  logViewerState.logSource = null;
  logViewerState.logProvider = null;
  logViewerState.logs = "";
  logViewerState.isLoading = false;
  logViewerState.fetchPromise = null;
  logViewerState.searchQuery = "";
  logViewerState.logLevel = "all";
  logViewerState.autoRefresh = true;
}

/**
 * Initialize the log viewer modal event listeners
 */
function initLogViewerModal() {
  if (logViewerInitialized) return;
  logViewerInitialized = true;

  const modal = document.getElementById("log-viewer-modal");
  const closeBtn = document.getElementById("log-viewer-close-btn");
  const refreshBtn = document.getElementById("log-viewer-refresh-btn");
  const copyBtn = document.getElementById("log-viewer-copy-btn");
  const searchInput = document.getElementById("log-viewer-search");
  const autoRefreshToggle = document.getElementById("log-auto-refresh");
  const filterBtns = document.querySelectorAll(
    "#log-viewer-modal .mcp-filter-tab",
  );

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener("click", closeLogViewerModal);
  }

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener("click", fetchAndDisplayLogs);
  }

  // Copy button
  if (copyBtn) {
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await copyLogViewerLogsToClipboard();
    });
  }

  // Search input
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      handleLogSearch(e.target.value);
    });
    searchInput.addEventListener("search", (e) => {
      handleLogSearch(e.target.value);
    });
  }

  // Auto-refresh toggle
  if (autoRefreshToggle) {
    autoRefreshToggle.addEventListener("change", toggleAutoRefresh);
  }

  // Filter buttons
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      handleLogFilter(btn.dataset.filter);
    });
  });

  // Close on backdrop click
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeLogViewerModal();
      }
    });
  }

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("visible")) {
      closeLogViewerModal();
    }
  });
}

// Initialize when DOM is loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLogViewerModal);
} else {
  initLogViewerModal();
}

// Export functions to window
window.openLogViewerModal = openLogViewerModal;
window.closeLogViewerModal = closeLogViewerModal;
window.initLogViewerModal = initLogViewerModal;
window.fetchAndDisplayLogs = fetchAndDisplayLogs;
