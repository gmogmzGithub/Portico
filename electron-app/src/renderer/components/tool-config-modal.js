// Tool Configuration Modal Component
// Allows users to enable/disable individual tools for MCP servers
// Includes tool testing functionality

// Module state for the modal
let toolConfigState = {
  serverId: null,
  serverName: null,
  serverIcon: null, // Server icon for display
  tools: [],
  originalDisabled: [],
  modified: false,
  searchQuery: "",
  activeFilter: "all",
  showDescriptions: false,
  mcpoPort: null, // Port used by MCPO for this server
  isCoreServer: false, // Core servers cannot have tools disabled
};

// Words that should be displayed in full caps
const FULL_CAPS_WORDS = [
  "vm",
  "lm",
  "mcp",
  "pdf",
  "pptx",
  "xlsx",
  "api",
  "url",
  "id",
  "json",
  "xml",
  "html",
  "css",
  "sql",
  "http",
  "https",
  "oauth",
  "jwt",
  "ui",
  "ux",
  "ai",
  "suid",
  "jira",
  "jql",
  "cql",
];

/**
 * Format a tool name for display by:
 * 1. Removing the server ID prefix (e.g., "agent_vm_create_agent_vm" → "create_agent_vm")
 * 2. Converting snake_case to Title Case with spaces
 * 3. Capitalizing special words (VM, MCP, PDF, etc.)
 *
 * @param {string} toolName - The original tool name (potentially prefixed)
 * @param {string} serverId - The server ID to strip as prefix
 * @returns {string} The formatted display name
 */
function formatToolDisplayName(toolName, serverId) {
  if (!toolName) return "";

  // Normalize server ID: hyphens → underscores to match MCPO prefixing
  const normalizedServerId = serverId ? serverId.replace(/-/g, "_") : "";
  let displayName = toolName;

  // Remove server prefix if present
  if (normalizedServerId && toolName.startsWith(`${normalizedServerId}_`)) {
    displayName = toolName.substring(normalizedServerId.length + 1);
  }

  // Convert snake_case to Title Case with spaces
  return displayName
    .split("_")
    .map((word) => {
      if (!word) return "";
      if (word.length > 1 && word === word.toUpperCase()) {
        return word;
      }
      const lowerWord = word.toLowerCase();
      if (FULL_CAPS_WORDS.includes(lowerWord)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

// Testing pane state
let testingState = {
  toolName: null,
  toolFullName: null,
  inputSchema: null,
  inputs: {},
  result: null,
  isRunning: false,
};

/**
 * Render simple markdown to HTML
 * Supports: **bold**, *italic*, `code`, [links](url), and line breaks
 * @param {string} text - The markdown text
 * @returns {string} - HTML string
 */
function renderMarkdown(text) {
  if (!text) return "";
  return (
    text
      // Escape HTML first to prevent XSS
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Then apply markdown formatting
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(
        /\[(.+?)\]\((.+?)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      .replace(/\n/g, "<br>")
  );
}

/**
 * Render JSON with syntax highlighting
 * @param {any} obj - The object to render
 * @param {number} indent - Current indentation level
 * @returns {string} - HTML string with syntax highlighting
 */
function renderJsonWithHighlighting(obj, indent = 0) {
  const spaces = "  ".repeat(indent);
  const nextSpaces = "  ".repeat(indent + 1);

  if (obj === null) {
    return '<span class="json-null">null</span>';
  }

  if (typeof obj === "boolean") {
    return `<span class="json-boolean">${obj}</span>`;
  }

  if (typeof obj === "number") {
    return `<span class="json-number">${obj}</span>`;
  }

  if (typeof obj === "string") {
    // Escape HTML in strings
    const escaped = obj
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<span class="json-string">"${escaped}"</span>`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return '<span class="json-bracket">[]</span>';
    }
    const items = obj
      .map((item) => nextSpaces + renderJsonWithHighlighting(item, indent + 1))
      .join('<span class="json-comma">,</span>\n');
    return `<span class="json-bracket">[</span>\n${items}\n${spaces}<span class="json-bracket">]</span>`;
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return '<span class="json-bracket">{}</span>';
    }
    const entries = keys
      .map((key) => {
        const escapedKey = key.replace(/"/g, '\\"');
        return `${nextSpaces}<span class="json-key">"${escapedKey}"</span><span class="json-colon">:</span> ${renderJsonWithHighlighting(obj[key], indent + 1)}`;
      })
      .join('<span class="json-comma">,</span>\n');
    return `<span class="json-bracket">{</span>\n${entries}\n${spaces}<span class="json-bracket">}</span>`;
  }

  return String(obj);
}

/**
 * Check if the current server is healthy
 * @returns {boolean}
 */
function isServerHealthy() {
  const healthInfo =
    window.appState?.healthStatus?.servers?.[toolConfigState.serverId];
  return healthInfo?.status === "healthy";
}

/**
 * Open the tool configuration modal for a specific server
 * @param {string} serverId - The server ID (e.g., 'time', 'slack')
 * @param {Event} event - The click event
 */
async function openToolsModal(serverId, event) {
  event?.stopPropagation();

  // Find server info for display name
  const state = window.appState;
  const server = state.servers?.find((s) => s.id === serverId);
  const serverName = server?.display_name || server?.name || serverId;

  // Store initial state for display while loading
  toolConfigState.serverId = serverId;
  toolConfigState.serverName = serverName;
  toolConfigState.serverIcon = server?.icon || null;
  toolConfigState.tools = [];
  toolConfigState.originalDisabled = [];
  toolConfigState.modified = false;
  toolConfigState.searchQuery = "";
  toolConfigState.activeFilter = "all";
  toolConfigState.mcpoPort = null;
  toolConfigState.isCoreServer = false;

  // Reset UI state
  const searchInput = document.getElementById("tool-search-input");
  if (searchInput) searchInput.value = "";

  const filterBtns = document.querySelectorAll(".tool-filter-btn");
  filterBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === "all");
  });

  // Close testing pane if open
  closeTestingPane();

  // Render modal header/title immediately, show loading state for tools list
  renderToolsModalHeader();
  showToolsLoadingState();

  // Show modal immediately (same pattern as skill details modal)
  const modal = document.getElementById("tool-config-modal");
  if (modal) {
    window.suppressMcpBadgeTooltip?.();
    window.setNativeOverlayInteractionSuppressed?.("tool-config-modal", true);
    modal.classList.add("visible");
    // Start expanded by default
    const modalContent = modal.querySelector(".tool-config-modal");
    if (modalContent) {
      modalContent.classList.add("maximized");
    }
  }

  // Now load data asynchronously
  try {
    const result = await window.electronAPI.getServerTools(serverId);

    if (!result.success) {
      showToolsErrorState(result.error);
      return;
    }

    // Update state with loaded data
    toolConfigState.tools = result.tools;
    toolConfigState.originalDisabled = result.tools
      .filter((t) => !t.enabled)
      .map((t) => t.originalName || t.name);
    toolConfigState.mcpoPort = result.port;
    toolConfigState.isCoreServer = result.isCoreServer || false;

    // Render the full modal content
    renderToolsModal();
  } catch (error) {
    showToolsErrorState(error.message);
    console.error("[Tools Modal] Error:", error);
  }
}

/**
 * Render just the modal header (for immediate display while loading)
 */
function renderToolsModalHeader() {
  // Update server logo
  const logoEl = document.getElementById("tool-config-logo");
  if (logoEl) {
    if (toolConfigState.serverIcon) {
      logoEl.innerHTML = `<img src="${toolConfigState.serverIcon}" alt="${toolConfigState.serverName}">`;
    } else {
      logoEl.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
      `;
    }
    logoEl.style.display = "";
  }

  // Update title
  const titleEl = document.getElementById("tool-config-title");
  if (titleEl) {
    titleEl.textContent = `Configure Tools - ${toolConfigState.serverName}`;
  }

  // Update tools count to loading state
  const countEl = document.getElementById("tools-count-display");
  if (countEl) {
    countEl.textContent = "Loading tools...";
  }
}

/**
 * Show loading state in the tools list
 */
function showToolsLoadingState() {
  const container = document.getElementById("tool-config-list");
  if (container) {
    container.innerHTML = `
      <div class="tool-config-loading">
        <div class="tool-config-loading-spinner"></div>
        <span>Loading tools...</span>
      </div>
    `;
  }
}

/**
 * Show error state in the tools list
 */
function showToolsErrorState(errorMessage) {
  const container = document.getElementById("tool-config-list");
  if (container) {
    container.innerHTML = `
      <div class="tool-config-empty tool-config-error">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span>Failed to load tools: ${errorMessage}</span>
      </div>
    `;
  }

  // Update count display
  const countEl = document.getElementById("tools-count-display");
  if (countEl) {
    countEl.textContent = "Error loading tools";
  }
}

/**
 * Render the tool configuration modal content
 */
function renderToolsModal() {
  // Update server logo
  const logoEl = document.getElementById("tool-config-logo");
  if (logoEl) {
    if (toolConfigState.serverIcon) {
      logoEl.innerHTML = `<img src="${toolConfigState.serverIcon}" alt="${toolConfigState.serverName}">`;
    } else {
      // Fallback to server icon placeholder
      logoEl.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
      `;
    }
    logoEl.style.display = "";
  }

  // Update title
  const titleEl = document.getElementById("tool-config-title");
  if (titleEl) {
    titleEl.textContent = `Configure Tools - ${toolConfigState.serverName}`;
  }

  // Update tools count display
  updateToolsCount();

  // Update description toggle button state
  const descToggleBtn = document.getElementById("tool-show-descriptions-btn");
  if (descToggleBtn) {
    descToggleBtn.classList.toggle("active", toolConfigState.showDescriptions);
  }

  // Update tool list class for descriptions visibility
  const listContainer = document.getElementById("tool-config-list");
  if (listContainer) {
    listContainer.classList.toggle(
      "show-descriptions",
      toolConfigState.showDescriptions,
    );
  }

  // Hide enable/disable all buttons, save button, separator, and show info for core servers
  const enableAllBtn = document.getElementById("tool-enable-all-btn");
  const disableAllBtn = document.getElementById("tool-disable-all-btn");
  const saveBtn = document.getElementById("tool-config-save-btn");
  const filterSeparator = document.getElementById("tool-filter-separator");
  const coreServerInfo = document.getElementById("core-server-info");
  const filterBtns = document.querySelectorAll(
    '.tool-filter-btn[data-filter="enabled"], .tool-filter-btn[data-filter="disabled"]',
  );

  if (toolConfigState.isCoreServer) {
    if (enableAllBtn) enableAllBtn.style.display = "none";
    if (disableAllBtn) disableAllBtn.style.display = "none";
    if (saveBtn) saveBtn.style.display = "none";
    if (filterSeparator) filterSeparator.style.display = "none";
    if (coreServerInfo) coreServerInfo.style.display = "flex";
    filterBtns.forEach((btn) => (btn.style.display = "none"));
  } else {
    if (enableAllBtn) enableAllBtn.style.display = "";
    if (disableAllBtn) disableAllBtn.style.display = "";
    if (saveBtn) saveBtn.style.display = "";
    if (filterSeparator) filterSeparator.style.display = "";
    if (coreServerInfo) coreServerInfo.style.display = "none";
    filterBtns.forEach((btn) => (btn.style.display = ""));
  }

  // Render tool list
  renderToolList();
}

/**
 * Render the tool list with current filters applied
 */
function renderToolList() {
  const container = document.getElementById("tool-config-list");
  if (!container) return;

  if (toolConfigState.tools.length === 0) {
    container.innerHTML =
      '<div class="tool-config-empty">No tools available for this server.</div>';
    return;
  }

  // Filter tools based on search and filter state
  const filteredTools = toolConfigState.tools.filter((tool) => {
    // Search filter
    if (toolConfigState.searchQuery) {
      const query = toolConfigState.searchQuery.toLowerCase();
      const displayMatch = (tool.displayName || "").toLowerCase().includes(query);
      const nameMatch = tool.name.toLowerCase().includes(query) || displayMatch;
      const descMatch = tool.description?.toLowerCase().includes(query);
      if (!nameMatch && !descMatch) return false;
    }

    // Enabled/disabled filter
    if (toolConfigState.activeFilter === "enabled" && !tool.enabled)
      return false;
    if (toolConfigState.activeFilter === "disabled" && tool.enabled)
      return false;

    return true;
  });

  if (filteredTools.length === 0) {
    container.innerHTML = `
      <div class="tool-config-empty">
        No tools match your ${toolConfigState.searchQuery ? "search" : "filter"}.
        <br><br>
        <button class="btn-link" id="clear-filters-btn">Clear filters</button>
      </div>
    `;

    // Add event listener for clear filters button
    const clearBtn = document.getElementById("clear-filters-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        toolConfigState.searchQuery = "";
        toolConfigState.activeFilter = "all";
        const searchInput = document.getElementById("tool-search-input");
        if (searchInput) searchInput.value = "";
        document.querySelectorAll(".tool-filter-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.filter === "all");
        });
        renderToolList();
      });
    }
    return;
  }

  // Update class for descriptions visibility
  container.classList.toggle(
    "show-descriptions",
    toolConfigState.showDescriptions,
  );

  // Check if server is healthy for showing test buttons
  const serverHealthy = isServerHealthy();

  container.innerHTML = filteredTools
    .map((tool) => {
      // Only show test button if server is healthy and tool is enabled
      const showTestBtn = serverHealthy && tool.enabled;

      // Core servers have all tools enabled and cannot be toggled
      const isCoreServer = toolConfigState.isCoreServer;

      // Format tool name for display:
      // 1. Remove server prefix (e.g., "agent_vm_create_agent_vm" → "create_agent_vm")
      // 2. Convert to Title Case with spaces (e.g., "Create Agent VM")
      const rawToolName = tool.fullName || tool.name;
      const displayName =
        tool.displayName ||
        formatToolDisplayName(rawToolName, toolConfigState.serverId);

      return `
      <div class="tool-config-item${showTestBtn ? " tool-config-item-clickable" : ""}" data-tool-name="${tool.name}">
        <div class="tool-item-header">
          ${
            isCoreServer
              ? `
            <div class="tool-core-indicator">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              <span class="tool-name">${displayName}</span>
            </div>
          `
              : `
            <label class="tool-toggle">
              <input type="checkbox"
                     data-tool="${tool.name}"
                     ${tool.enabled ? "checked" : ""}>
              <span class="tool-checkbox-custom"></span>
              <span class="tool-name">${displayName}</span>
            </label>
          `
          }
          ${
            showTestBtn
              ? `
            <button class="tool-test-btn" data-tool="${tool.name}" title="Test this tool">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
          `
              : ""
          }
        </div>
        ${tool.description ? `<span class="tool-description">${renderMarkdown(tool.description)}</span>` : ""}
      </div>
    `;
    })
    .join("");

  // Add event listeners to checkboxes
  container
    .querySelectorAll('input[type="checkbox"][data-tool]')
    .forEach((checkbox) => {
      checkbox.addEventListener("change", (e) => {
        onToolToggle(e.target.dataset.tool, e.target.checked);
      });
    });

  // Add event listeners to test buttons
  container.querySelectorAll(".tool-test-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTestingPane(btn.dataset.tool);
    });
  });

  // Clicking the row should behave like clicking the test button.
  container.querySelectorAll(".tool-config-item-clickable").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (
        e.target.closest(".tool-test-btn") ||
        e.target.closest(".tool-toggle") ||
        e.target.closest('input[type="checkbox"]')
      ) {
        return;
      }

      openTestingPane(item.dataset.toolName);
    });
  });
}

/**
 * Handle tool checkbox toggle
 * @param {string} toolName - The tool name
 * @param {boolean} enabled - Whether the tool is enabled
 */
function onToolToggle(toolName, enabled) {
  const tool = toolConfigState.tools.find((t) => t.name === toolName);
  if (tool) {
    tool.enabled = enabled;
    toolConfigState.modified = true;
    updateToolsCount();
    updateSaveButtonState();
    // Re-render to update test button visibility
    renderToolList();
  }
}

/**
 * Update the tools count display
 */
function updateToolsCount() {
  const countEl = document.getElementById("tools-count-display");
  if (!countEl) return;

  const enabled = toolConfigState.tools.filter((t) => t.enabled).length;
  const total = toolConfigState.tools.length;
  countEl.textContent = `${enabled}/${total} tools enabled`;
}

/**
 * Update save button state based on modifications
 */
function updateSaveButtonState() {
  const saveBtn = document.getElementById("tool-config-save-btn");
  if (!saveBtn) return;

  // Check if current state differs from original
  const currentDisabled = toolConfigState.tools
    .filter((t) => !t.enabled)
    .map((t) => t.originalName || t.name)
    .sort();
  const originalDisabled = [...toolConfigState.originalDisabled].sort();

  const hasChanges =
    JSON.stringify(currentDisabled) !== JSON.stringify(originalDisabled);

  if (hasChanges) {
    saveBtn.classList.add("has-changes");
    saveBtn.disabled = false;
  } else {
    saveBtn.classList.remove("has-changes");
    saveBtn.disabled = false; // Still allow saving even without changes
  }
}

/**
 * Save the tool configuration and restart the server
 */
async function saveToolsConfig() {
  // Capture state before closing modal (modal resets state on close)
  const serverIdToRefresh = toolConfigState.serverId;
  const serverName =
    toolConfigState.serverName || toolConfigState.serverId || "server";
  const enabledCount = toolConfigState.tools.filter((t) => t.enabled).length;
  const totalCount = toolConfigState.tools.length;
  const disabledTools = toolConfigState.tools
    .filter((t) => !t.enabled)
    .map((t) => t.originalName || t.name);

  // Close modal FIRST to avoid z-index issues with loading overlay
  closeToolsModal();

  // Now show loading overlay (modal is gone, so it will be visible)
  window.showLoading(`Saving ${serverName} tool configuration...`);

  try {
    const result = await window.electronAPI.saveServerTools(
      serverIdToRefresh,
      disabledTools,
    );

    if (result.success) {
      // Update the cache immediately with local state
      const state = window.appState;
      if (!state.serverToolsCache) {
        state.serverToolsCache = {};
      }
      state.serverToolsCache[serverIdToRefresh] = {
        enabledCount,
        totalCount,
      };

      // Continue showing loading while we verify health
      window.showLoading(`Restarting ${serverName}...`);

      // Refresh the server's health and tools
      if (window.refreshServerAfterOperation) {
        await window.refreshServerAfterOperation(serverIdToRefresh);
      }

      window.hideLoading();
      window.showNotification(
        `${serverName} tools updated (${enabledCount}/${totalCount} enabled)`,
        "success",
      );
    } else {
      window.hideLoading();
      window.showNotification(`Failed to save: ${result.error}`, "error");
    }
  } catch (error) {
    window.hideLoading();
    window.showNotification(
      `Error saving configuration: ${error.message}`,
      "error",
    );
    console.error("[Tools Modal] Save error:", error);
  }
}

/**
 * Close the tool configuration modal
 */
function closeToolsModal() {
  const modal = document.getElementById("tool-config-modal");
  if (modal) {
    // Hide modal first to avoid visual "shrinking" effect
    window.suppressMcpBadgeTooltip?.({ untilPointerMove: true });
    modal.classList.remove("visible");
    window.setNativeOverlayInteractionSuppressed?.("tool-config-modal", false);

    // Reset classes after modal is hidden (use setTimeout to ensure it's after the fade-out)
    setTimeout(() => {
      const modalContent = modal.querySelector(".tool-config-modal");
      if (modalContent) {
        modalContent.classList.remove("testing-expanded");
        modalContent.classList.remove("maximized");
      }
    }, 200);
  }

  // Close testing pane
  closeTestingPane();

  // Reset state (but keep showDescriptions preference)
  const showDescriptions = toolConfigState.showDescriptions;
  toolConfigState = {
    serverId: null,
    serverName: null,
    tools: [],
    originalDisabled: [],
    modified: false,
    searchQuery: "",
    activeFilter: "all",
    showDescriptions: showDescriptions,
    mcpoPort: null,
    isCoreServer: false,
  };
}

/**
 * Toggle modal maximized state
 */
function toggleModalMaximize() {
  const modalContent = document.querySelector(".tool-config-modal");
  const maximizeBtn = document.getElementById("tool-config-maximize-btn");

  if (modalContent) {
    const isMaximized = modalContent.classList.toggle("maximized");

    // Update button title
    if (maximizeBtn) {
      maximizeBtn.title = isMaximized ? "Restore" : "Maximize";
    }

    if (modalContent.classList.contains("testing-expanded")) {
      window.requestAnimationFrame(() => {
        applyToolConfigMainWidth(
          modalContent,
          clampToolConfigMainWidth(
            dividerDragState.appliedWidth ?? TOOL_CONFIG_DEFAULT_MAIN_WIDTH,
            modalContent.getBoundingClientRect().width,
          ),
        );
      });
    }
  }
}

/**
 * Toggle all tools on or off
 * @param {boolean} enable - Whether to enable all tools
 */
function toggleAllTools(enable) {
  toolConfigState.tools.forEach((tool) => {
    tool.enabled = enable;
  });
  toolConfigState.modified = true;
  renderToolList();
  updateToolsCount();
  updateSaveButtonState();
}

/**
 * Handle search input
 * @param {string} query - The search query
 */
function handleToolSearch(query) {
  toolConfigState.searchQuery = query;
  renderToolList();
}

/**
 * Handle filter button click
 * @param {string} filter - The filter type ('all', 'enabled', 'disabled')
 */
function handleToolFilter(filter) {
  toolConfigState.activeFilter = filter;

  // Update button states
  document.querySelectorAll(".tool-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });

  renderToolList();
}

/**
 * Toggle description visibility
 */
function handleDescriptionToggle() {
  toolConfigState.showDescriptions = !toolConfigState.showDescriptions;

  // Update button state
  const descToggleBtn = document.getElementById("tool-show-descriptions-btn");
  if (descToggleBtn) {
    descToggleBtn.classList.toggle("active", toolConfigState.showDescriptions);
  }

  // Update list visibility
  const listContainer = document.getElementById("tool-config-list");
  if (listContainer) {
    listContainer.classList.toggle(
      "show-descriptions",
      toolConfigState.showDescriptions,
    );
  }
}

// ============================================================================
// TESTING PANE FUNCTIONS
// ============================================================================

/**
 * Open the testing pane for a specific tool
 * @param {string} toolName - The tool name
 */
function openTestingPane(toolName) {
  const tool = toolConfigState.tools.find((t) => t.name === toolName);
  if (!tool) return;

  // Set testing state
  testingState.toolName = toolName;
  testingState.toolFullName = tool.fullName;
  testingState.inputSchema = tool.inputSchema;
  testingState.inputs = {};
  testingState.result = null;
  testingState.isRunning = false;

  // Update testing pane header
  const toolNameEl = document.getElementById("testing-tool-name");
  if (toolNameEl) {
    toolNameEl.textContent = toolName;
  }

  // Render input fields
  renderTestingInputs();

  // Clear output areas and validation errors
  const inputJson = document.getElementById("testing-input-json");
  const outputJson = document.getElementById("testing-output-json");
  if (inputJson) inputJson.innerHTML = "";
  if (outputJson) outputJson.innerHTML = "";
  showValidationError([]);

  // Expand modal and maximize for testing
  const modalContent = document.querySelector(".tool-config-modal");
  if (modalContent) {
    modalContent.classList.add("testing-expanded");
    modalContent.classList.add("maximized");
    applyToolConfigMainWidth(
      modalContent,
      clampToolConfigMainWidth(
        TOOL_CONFIG_DEFAULT_MAIN_WIDTH,
        modalContent.getBoundingClientRect().width,
      ),
    );

    // Update maximize button title
    const maximizeBtn = document.getElementById("tool-config-maximize-btn");
    if (maximizeBtn) {
      maximizeBtn.title = "Restore";
    }
  }

  // Update run button state
  updateRunButton();
}

/**
 * Close the testing pane
 */
function closeTestingPane() {
  stopDividerDrag();

  // Collapse modal
  const modalContent = document.querySelector(".tool-config-modal");
  if (modalContent) {
    modalContent.classList.remove("testing-expanded");
    modalContent.classList.remove("dragging-divider");
    resetToolConfigMainWidth(modalContent);
  }

  // Reset testing state
  testingState = {
    toolName: null,
    toolFullName: null,
    inputSchema: null,
    inputs: {},
    result: null,
    isRunning: false,
  };
}

// ============================================================================
// DIVIDER DRAG FUNCTIONALITY
// ============================================================================

const TOOL_CONFIG_DEFAULT_MAIN_WIDTH = 420;
const TOOL_CONFIG_MIN_MAIN_WIDTH = 320;
const TOOL_CONFIG_MIN_TESTING_WIDTH = 500;
const TOOL_CONFIG_DIVIDER_WIDTH = 6;

let dividerDragState = {
  isDragging: false,
  startX: 0,
  startWidth: 0,
  modalWidth: 0,
  modalContent: null,
  pendingWidth: null,
  appliedWidth: null,
  rafId: null,
};

function clampToolConfigMainWidth(width, modalWidth) {
  const maxWidth = Math.max(
    TOOL_CONFIG_MIN_MAIN_WIDTH,
    Math.floor(modalWidth) -
      TOOL_CONFIG_MIN_TESTING_WIDTH -
      TOOL_CONFIG_DIVIDER_WIDTH,
  );

  return Math.max(
    TOOL_CONFIG_MIN_MAIN_WIDTH,
    Math.min(Math.floor(width), maxWidth),
  );
}

function applyToolConfigMainWidth(modalContent, width) {
  if (!modalContent || !Number.isFinite(width)) return;

  modalContent.style.setProperty("--tool-config-main-width", `${width}px`);
  dividerDragState.appliedWidth = width;
}

function flushToolConfigDividerWidth() {
  if (
    !dividerDragState.modalContent ||
    !Number.isFinite(dividerDragState.pendingWidth)
  ) {
    return;
  }

  applyToolConfigMainWidth(
    dividerDragState.modalContent,
    dividerDragState.pendingWidth,
  );
}

function scheduleToolConfigDividerWidth(width) {
  dividerDragState.pendingWidth = width;

  if (dividerDragState.rafId !== null) {
    return;
  }

  dividerDragState.rafId = window.requestAnimationFrame(() => {
    dividerDragState.rafId = null;
    flushToolConfigDividerWidth();
  });
}

function resetToolConfigMainWidth(modalContent) {
  if (!modalContent) return;

  modalContent.style.removeProperty("--tool-config-main-width");
}

/**
 * Initialize divider drag functionality
 */
function initDividerDrag() {
  const divider = document.getElementById("tool-config-divider");
  if (!divider) return;

  divider.addEventListener("mousedown", startDividerDrag);
  document.addEventListener("mousemove", onDividerDrag);
  document.addEventListener("mouseup", stopDividerDrag);
  document.addEventListener("pointercancel", stopDividerDrag);
  window.addEventListener("blur", stopDividerDrag);
}

function startDividerDrag(e) {
  const modalContent = document.querySelector(".tool-config-modal");
  const mainPanel = document.querySelector(".tool-config-main");
  if (
    !modalContent ||
    !mainPanel ||
    !modalContent.classList.contains("testing-expanded")
  )
    return;

  dividerDragState.isDragging = true;
  dividerDragState.startX = e.clientX;
  dividerDragState.startWidth = mainPanel.getBoundingClientRect().width;
  dividerDragState.modalWidth = modalContent.getBoundingClientRect().width;
  dividerDragState.modalContent = modalContent;
  dividerDragState.pendingWidth = dividerDragState.startWidth;
  dividerDragState.appliedWidth = dividerDragState.startWidth;

  document.getElementById("tool-config-divider")?.classList.add("dragging");
  modalContent.classList.add("dragging-divider");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
}

function onDividerDrag(e) {
  if (!dividerDragState.isDragging) return;

  const delta = e.clientX - dividerDragState.startX;
  const newWidth = clampToolConfigMainWidth(
    dividerDragState.startWidth + delta,
    dividerDragState.modalWidth,
  );
  scheduleToolConfigDividerWidth(newWidth);
}

function stopDividerDrag() {
  if (!dividerDragState.isDragging) return;

  if (dividerDragState.rafId !== null) {
    window.cancelAnimationFrame(dividerDragState.rafId);
    dividerDragState.rafId = null;
  }
  flushToolConfigDividerWidth();

  dividerDragState.isDragging = false;
  dividerDragState.modalWidth = 0;
  dividerDragState.modalContent?.classList.remove("dragging-divider");
  dividerDragState.modalContent = null;
  dividerDragState.pendingWidth = null;
  dividerDragState.appliedWidth = null;
  document.getElementById("tool-config-divider")?.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

// ============================================================================
// COPY TO CLIPBOARD FUNCTIONALITY
// ============================================================================

/**
 * Copy text to clipboard using fallback method for Electron compatibility
 * @param {string} text - The text to copy
 * @returns {boolean} - Whether the copy succeeded
 */
function copyToClipboardFallback(text) {
  // Create a temporary textarea element
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const success = document.execCommand("copy");
    return success;
  } catch (error) {
    console.error("[Tools Testing] execCommand copy failed:", error);
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * Copy JSON content to clipboard
 * @param {string} type - 'request' or 'response'
 */
async function copyJsonToClipboard(type) {
  const preElement =
    type === "request"
      ? document.getElementById("testing-input-json")
      : document.getElementById("testing-output-json");
  const button =
    type === "request"
      ? document.getElementById("copy-request-btn")
      : document.getElementById("copy-response-btn");

  if (!preElement || !button) return;

  // Get the raw text content (without HTML tags)
  const text = preElement.textContent;
  if (!text) return;

  let success = false;

  // Try navigator.clipboard first, then fallback
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      success = true;
    }
  } catch (error) {
    console.log("[Tools Testing] navigator.clipboard failed, using fallback");
  }

  // Fallback to execCommand
  if (!success) {
    success = copyToClipboardFallback(text);
  }

  if (success) {
    // Show copied feedback
    button.classList.add("copied");
    const originalHTML = button.innerHTML;
    button.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied!
    `;

    // Reset after 2 seconds
    setTimeout(() => {
      button.classList.remove("copied");
      button.innerHTML = originalHTML;
    }, 2000);
  } else {
    console.error("[Tools Testing] All copy methods failed");
    // Show error feedback briefly
    button.classList.add("error");
    const originalHTML = button.innerHTML;
    button.innerHTML = "Failed";
    setTimeout(() => {
      button.classList.remove("error");
      button.innerHTML = originalHTML;
    }, 2000);
  }
}

/**
 * Determine input type from JSON schema property
 * @param {object} prop - The JSON schema property
 * @returns {string} - HTML input type
 */
function getInputType(prop) {
  if (!prop) return "text";

  const type = prop.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "checkbox";
  if (prop.format === "date") return "date";
  if (prop.format === "date-time") return "datetime-local";
  if (prop.format === "email") return "email";
  if (prop.format === "uri" || prop.format === "url") return "url";

  return "text";
}

/**
 * Render input fields based on the tool's inputSchema
 */
function renderTestingInputs() {
  const container = document.getElementById("testing-inputs");
  if (!container) return;

  const schema = testingState.inputSchema;

  if (
    !schema ||
    !schema.properties ||
    Object.keys(schema.properties).length === 0
  ) {
    container.innerHTML = `
      <div class="testing-no-inputs">
        <p>This tool has no input parameters.</p>
      </div>
    `;
    return;
  }

  const properties = schema.properties || {};
  const required = schema.required || [];

  container.innerHTML = Object.entries(properties)
    .map(([name, prop]) => {
      const isRequired = required.includes(name);
      const inputType = getInputType(prop);
      const isCheckbox = inputType === "checkbox";
      const defaultValue = prop.default !== undefined ? prop.default : "";
      const dataType = prop.type || (prop.items ? "array" : "string");
      const itemsType = dataType === "array" ? prop.items?.type || "" : "";
      const dataAttrs = `data-param="${name}" data-type="${dataType}"${itemsType ? ` data-items-type="${itemsType}"` : ""}`;

      return `
      <div class="testing-input-field">
        <label for="testing-input-${name}">
          ${name}${isRequired ? ' <span class="required">*</span>' : ""}
        </label>
        ${
          isCheckbox
            ? `
          <input type="checkbox"
                 id="testing-input-${name}"
                 ${dataAttrs}
                 ${defaultValue ? "checked" : ""}>
        `
            : `
          <input type="${inputType}"
                 id="testing-input-${name}"
                 ${dataAttrs}
                 placeholder="${prop.description || name}"
                 value="${defaultValue}">
        `
        }
        ${prop.description ? `<span class="input-hint">${prop.description}</span>` : ""}
      </div>
    `;
    })
    .join("");
}

/**
 * Parse a single array item based on expected schema type.
 * @param {string} rawValue - The raw item value
 * @param {string|null} itemType - The expected item type
 * @returns {any} - Parsed item value
 */
function parseArrayItemValue(rawValue, itemType) {
  if (!itemType || itemType === "string") return rawValue;

  if (itemType === "integer") {
    const parsed = parseInt(rawValue, 10);
    return Number.isNaN(parsed) ? rawValue : parsed;
  }

  if (itemType === "number") {
    const parsed = parseFloat(rawValue);
    return Number.isNaN(parsed) ? rawValue : parsed;
  }

  if (itemType === "boolean") {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return rawValue;
  }

  return rawValue;
}

/**
 * Parse array input from comma/newline separated or JSON array values.
 * @param {string} rawValue - Raw input value
 * @param {string|null} itemType - The expected item type
 * @returns {any[]|undefined} - Parsed array or undefined if empty
 */
function parseArrayInput(rawValue, itemType) {
  if (rawValue === undefined || rawValue === null) return undefined;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Fall through to comma/newline parsing
    }
  }

  const normalized =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  const parts = normalized
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return undefined;
  return parts.map((part) => parseArrayItemValue(part, itemType));
}

/**
 * Collect input values from the testing inputs
 * @returns {object} - Input values
 */
function collectTestingInputs() {
  const inputs = {};
  const inputFields = document.querySelectorAll(
    "#testing-inputs input[data-param]",
  );

  inputFields.forEach((input) => {
    const name = input.dataset.param;
    const type = input.dataset.type;
    const itemType = input.dataset.itemsType;
    let value;

    if (input.type === "checkbox") {
      value = input.checked;
    } else if (type === "array") {
      value = parseArrayInput(input.value, itemType);
    } else if (type === "integer") {
      value = input.value ? parseInt(input.value, 10) : undefined;
    } else if (type === "number") {
      value = input.value ? parseFloat(input.value) : undefined;
    } else if (type === "boolean") {
      value = input.value === "true";
    } else {
      value = input.value || undefined;
    }

    if (value !== undefined && value !== "") {
      inputs[name] = value;
    }
  });

  return inputs;
}

/**
 * Update the run button state
 */
function updateRunButton() {
  const runBtn = document.getElementById("run-tool-btn");
  if (!runBtn) return;

  if (testingState.isRunning) {
    runBtn.disabled = true;
    runBtn.innerHTML = `
      <span class="btn-spinner"></span>
      Running...
    `;
  } else {
    runBtn.disabled = false;
    runBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
      Run Tool
    `;
  }
}

/**
 * Validate required fields before running tool
 * @returns {{ valid: boolean, missingFields: string[] }}
 */
function validateTestingInputs() {
  const schema = testingState.inputSchema;
  if (!schema || !schema.properties) {
    return { valid: true, missingFields: [] };
  }

  const required = schema.required || [];
  const missingFields = [];

  // Clear previous error states
  document
    .querySelectorAll(".testing-input-field.has-error")
    .forEach((field) => {
      field.classList.remove("has-error");
    });

  for (const fieldName of required) {
    const input = document.querySelector(
      `#testing-inputs input[data-param="${fieldName}"]`,
    );
    if (input) {
      const value =
        input.type === "checkbox" ? input.checked : input.value.trim();
      if (!value && value !== false && value !== 0) {
        missingFields.push(fieldName);
        // Mark field as error
        input.closest(".testing-input-field")?.classList.add("has-error");
      }
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Show or hide validation error
 * @param {string[]} missingFields - List of missing field names
 */
function showValidationError(missingFields) {
  const errorEl = document.getElementById("testing-validation-error");
  if (!errorEl) return;

  if (missingFields.length === 0) {
    errorEl.classList.remove("visible");
    errorEl.textContent = "";
  } else {
    const fieldList = missingFields.map((f) => `"${f}"`).join(", ");
    errorEl.textContent = `Required fields missing: ${fieldList}`;
    errorEl.classList.add("visible");
  }
}

/**
 * Run the tool with current inputs
 */
async function runTool() {
  if (testingState.isRunning || !testingState.toolName) return;

  // Validate required fields first
  const validation = validateTestingInputs();
  if (!validation.valid) {
    showValidationError(validation.missingFields);
    return;
  }

  // Clear any previous validation errors
  showValidationError([]);

  testingState.isRunning = true;
  updateRunButton();

  // Collect inputs
  const inputs = collectTestingInputs();

  // Display input JSON with syntax highlighting
  const inputJson = document.getElementById("testing-input-json");
  if (inputJson) {
    inputJson.innerHTML = renderJsonWithHighlighting(inputs);
  }

  // Clear previous output
  const outputJson = document.getElementById("testing-output-json");
  if (outputJson) {
    outputJson.textContent = "Running...";
    outputJson.classList.remove("error", "success");
  }

  try {
    console.log(
      `[Tools Testing] Invoking ${toolConfigState.serverId}/${testingState.toolFullName} on port ${toolConfigState.mcpoPort}`,
      inputs,
    );

    const result = await window.electronAPI.invokeMcpTool(
      toolConfigState.serverId,
      testingState.toolFullName, // Use full name directly (already correct from OpenAPI)
      inputs,
      toolConfigState.mcpoPort,
    );

    testingState.result = result;

    if (outputJson) {
      if (result.success) {
        outputJson.classList.add("success");
        outputJson.classList.remove("error");
        outputJson.innerHTML = renderJsonWithHighlighting(result.data);
      } else {
        outputJson.classList.add("error");
        outputJson.classList.remove("success");
        outputJson.innerHTML = renderJsonWithHighlighting({
          error: result.error || `HTTP ${result.status}: ${result.statusText}`,
          status: result.status,
          data: result.data,
        });
      }
    }
  } catch (error) {
    console.error("[Tools Testing] Error:", error);

    if (outputJson) {
      outputJson.classList.add("error");
      outputJson.classList.remove("success");
      outputJson.innerHTML = renderJsonWithHighlighting({
        error: error.message,
      });
    }
  }

  testingState.isRunning = false;
  updateRunButton();
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Initialize event listeners when DOM is ready
function initToolConfigModal() {
  // Close button (X)
  const closeBtn = document.getElementById("tool-config-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeToolsModal);
  }

  // Maximize button
  const maximizeBtn = document.getElementById("tool-config-maximize-btn");
  if (maximizeBtn) {
    maximizeBtn.addEventListener("click", toggleModalMaximize);
  }

  // Cancel button
  const cancelBtn = document.getElementById("tool-config-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeToolsModal);
  }

  // Save button
  const saveBtn = document.getElementById("tool-config-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveToolsConfig);
  }

  // Enable All button
  const enableAllBtn = document.getElementById("tool-enable-all-btn");
  if (enableAllBtn) {
    enableAllBtn.addEventListener("click", () => toggleAllTools(true));
  }

  // Disable All button
  const disableAllBtn = document.getElementById("tool-disable-all-btn");
  if (disableAllBtn) {
    disableAllBtn.addEventListener("click", () => toggleAllTools(false));
  }

  // Search input
  const searchInput = document.getElementById("tool-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) =>
      handleToolSearch(e.target.value),
    );
  }

  // Filter buttons
  document.querySelectorAll(".tool-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleToolFilter(btn.dataset.filter));
  });

  // Description toggle button (new toggle button instead of checkbox)
  const descToggleBtn = document.getElementById("tool-show-descriptions-btn");
  if (descToggleBtn) {
    descToggleBtn.addEventListener("click", handleDescriptionToggle);
  }

  // Testing pane close button
  const closeTestingBtn = document.getElementById("close-testing-pane");
  if (closeTestingBtn) {
    closeTestingBtn.addEventListener("click", closeTestingPane);
  }

  // Run tool button
  const runBtn = document.getElementById("run-tool-btn");
  if (runBtn) {
    runBtn.addEventListener("click", runTool);
  }

  // Copy buttons
  const copyRequestBtn = document.getElementById("copy-request-btn");
  if (copyRequestBtn) {
    copyRequestBtn.addEventListener("click", () =>
      copyJsonToClipboard("request"),
    );
  }

  const copyResponseBtn = document.getElementById("copy-response-btn");
  if (copyResponseBtn) {
    copyResponseBtn.addEventListener("click", () =>
      copyJsonToClipboard("response"),
    );
  }

  // Initialize divider drag functionality
  initDividerDrag();

  // Handle Escape key to close modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("tool-config-modal");
      if (modal && modal.classList.contains("visible")) {
        // If testing pane is open, close it first
        const modalContent = modal.querySelector(".tool-config-modal");
        if (modalContent?.classList.contains("testing-expanded")) {
          closeTestingPane();
        } else {
          closeToolsModal();
        }
      }
    }
  });

  // Click outside modal to close
  const modalOverlay = document.getElementById("tool-config-modal");
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) {
        closeToolsModal();
      }
    });
  }
}

// Initialize when DOM is loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initToolConfigModal);
} else {
  initToolConfigModal();
}

// Export functions
window.openToolsModal = openToolsModal;
window.saveToolsConfig = saveToolsConfig;
window.closeToolsModal = closeToolsModal;
window.onToolToggle = onToolToggle;
window.toggleAllTools = toggleAllTools;
window.toggleModalMaximize = toggleModalMaximize;
window.openTestingPane = openTestingPane;
window.closeTestingPane = closeTestingPane;
window.runTool = runTool;
window.copyJsonToClipboard = copyJsonToClipboard;
