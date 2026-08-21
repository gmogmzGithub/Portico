// MCP servers component - Control Plane V2
// Refactored for card-based UI with search/filter

// Track hover state for tooltip - use unique name to avoid conflict with chat-tab.js
let mcpBadgeHoverState = false;
let mcpClickListenerAdded = false;
let mcpBadgeHoverBound = false;
let mcpBadgeTooltipVisible = false;
let mcpBadgeHoverDelayTimeout = null;
let mcpBadgeTooltipRequestId = 0;
let mcpTooltipVisibilityListenersAdded = false;
let mcpBadgeTooltipSuppressedUntilPointerMove = false;
let mcpBadgeTooltipSuppressionReleaseHandler = null;
let mcpBadgePointerTrackingBound = false;
let mcpBadgeLastPointerPosition = null;
let mcpBadgeTooltipSuppressionStartPoint = null;

// Search and filter state for MCP servers
let mcpSearchQuery = "";
let mcpActiveFilter = "all";
let openDropdownId = null;
const selectedServerIds = new Set();
let bulkSelectionButtonsInitialized = false;

// Track if search/filter listeners are already bound
let mcpSearchFilterInitialized = false;
let mcpServerListRefreshQueued = false;
let readinessBulkReconcileInProgress = false;
let readinessBulkReconcileLastAt = 0;
let readinessBulkReconcileLastSignature = "";

// Delete confirmation modal state
let pendingDeleteServerId = null;
let pendingDeleteServerName = null;

// Restart confirmation modal state
let pendingRestartServerId = null;
let pendingRestartServerName = null;
let pendingRestartIsAll = false;

// Re-auth confirmation modal state
let pendingReauthServerId = null;
let pendingReauthServerName = null;

// Data re-sync confirmation modal state
let pendingResyncServerId = null;
let pendingResyncServerName = null;

// Human-readable elapsed for warmup states: 45s, 1m, 12m, 1h 5m.
function formatWarmupElapsed(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

// Shared warmup narration: elapsed plus percent when a denominator is
// known, else the raw item count so the detail is never a bare number
// void. Feeds both the starting and running-while-syncing labels.
function formatWarmupDetailParts(warmup) {
  const parts = [formatWarmupElapsed(warmup.elapsed_seconds)];
  const percent = Number(warmup.progress_percent);
  const itemsFetched = Number(warmup.items_fetched);
  if (Number.isFinite(percent) && percent > 0) {
    parts.push(`${Math.min(99, Math.round(percent))}%`);
  } else if (Number.isFinite(itemsFetched) && itemsFetched > 0) {
    // First-ever sync has no denominator yet (percent needs a completed
    // run); show the raw count so the card is never a bare spinner.
    parts.push(`${itemsFetched.toLocaleString("en-US")} ${warmup.phase === "channels" ? "channels" : "users"}`);
  }
  return parts;
}

// "Starting..." plus live warmup detail when the provider reports it:
// "Starting... (3m)" or "Starting... (3m · 42%)". Data rides the existing
// health payload (provider_warmup from the Slack MCP /health contract) —
// no extra polling.
function formatStartingLabel(healthInfo) {
  const warmup = healthInfo?.provider_warmup;
  const elapsedSeconds = warmup?.elapsed_seconds;
  if (!warmup || !Number.isFinite(Number(elapsedSeconds))) {
    return "Starting...";
  }
  return `Starting... (${formatWarmupDetailParts(warmup).join(" · ")})`;
}

// "Running" plus background-sync narration for never-block servers
// (Slack r8+): tools are live immediately and the directory sync rides
// the same provider_warmup payload with syncing:true — the card says so
// instead of pretending the sync is a lockout ("Starting...") or
// invisible ("Running").
function formatRunningLabel(healthInfo) {
  const warmup = healthInfo?.provider_warmup;
  if (!warmup || warmup.syncing !== true) {
    return "Running";
  }
  if (!Number.isFinite(Number(warmup.elapsed_seconds))) {
    return "Running — syncing";
  }
  return `Running — syncing (${formatWarmupDetailParts(warmup).join(" · ")})`;
}

// Servers with a persisted data volume the user can deliberately purge.
// Keep in sync with RESYNCABLE_SERVER_DATA in services/mcp-data-resync.js.
const RESYNCABLE_DATA_SERVERS = {
  slack: {
    menuLabel: "Re-sync Slack data",
    modalText:
      "This deletes the locally cached Slack user and channel directory and rebuilds it from Slack. Rebuilding takes 10–20 minutes; Slack tools that look up people or channels by name stay unavailable until it finishes. Your Slack sign-in is not affected.",
  },
};

// Track escape key handlers to prevent duplicates
let deleteEscapeHandler = null;
let toggleEscapeHandler = null;
let restartEscapeHandler = null;
let reauthEscapeHandler = null;
let resyncEscapeHandler = null;
const TOOLS_REFRESH_MIN_INTERVAL_MS = 15000;
const TOOLS_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 60000;
const MCP_TOOLTIP_SHOW_DELAY_MS = 24;
const LOCAL_API_BASE_URL = "http://localhost:9876";
const POST_OPERATION_READINESS_TIMEOUT_MS = 3000;
const BULK_READINESS_RECONCILE_TIMEOUT_MS = 5000;
const BULK_READINESS_RECONCILE_MIN_INTERVAL_MS = 10000;
const POST_OPERATION_MAX_WAIT_MS = 30000;
const POST_OPERATION_POLL_INTERVAL_MS = 1000;
const POST_OPERATION_STABLE_READINESS_PHASES = new Set([
  "needs_oauth",
  "waiting_callback",
  "disabled",
]);
const POST_OPERATION_NON_PROBE_READINESS_PHASES = new Set([
  ...POST_OPERATION_STABLE_READINESS_PHASES,
  "failed",
  "timeout",
  "not_running",
  "not_configured",
]);
const POST_OPERATION_BACKGROUND_CONTINUE_DETAIL =
  "Still starting in background...";
const MCP_PROGRESS_HIDE_DELAY_MS = 400;
const MCP_TOOLTIP_SUPPRESSION_RELEASE_DISTANCE_PX = 10;
const mcpServerCardOrder = window.mcpServerCardOrder || {};
const partitionMcpServerGridEntries =
  typeof mcpServerCardOrder.partitionMcpServerGridEntries === "function"
    ? mcpServerCardOrder.partitionMcpServerGridEntries
    : (entries) => {
        const configuredEnabled = [];
        const configuredDisabled = [];
        const configuredMissingSetup = [];
        const unconfigured = [];

        for (const entry of Array.isArray(entries) ? entries : []) {
          if (!entry?.configured) {
            unconfigured.push(entry);
          } else if (entry.missingSetup) {
            configuredMissingSetup.push(entry);
          } else if (entry.enabled) {
            configuredEnabled.push(entry);
          } else {
            configuredDisabled.push(entry);
          }
        }

        const compareNames = (a, b) =>
          (a?.server?.display_name || a?.server?.name || "").localeCompare(
            b?.server?.display_name || b?.server?.name || "",
          );
        const statusPriority = {
          starting: 0,
          checking: 1,
          failed: 2,
          timeout: 3,
          not_running: 4,
          needs_oauth: 5,
          healthy: 6,
          disabled: 7,
          unknown: 8,
        };

        configuredEnabled.sort((a, b) => {
          const priorityA = statusPriority[a?.healthStatus] ?? statusPriority.unknown;
          const priorityB = statusPriority[b?.healthStatus] ?? statusPriority.unknown;
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }

          const isCoreA = Boolean(a?.server?.isCore);
          const isCoreB = Boolean(b?.server?.isCore);
          if (isCoreA !== isCoreB) {
            return isCoreA ? -1 : 1;
          }

          return compareNames(a, b);
        });
        configuredDisabled.sort(compareNames);
        configuredMissingSetup.sort(compareNames);
        unconfigured.sort(compareNames);

        const getGridEntryPriority = (entry) => {
          if (entry?.missingSetup) return 4;
          if (entry?.setupAction === "authenticate") return 0;
          if (entry?.setupAction === "configure") return 1;
          if (entry?.enabled) return 2;
          return 3;
        };
        const compareGridEntries = (a, b) => {
          const priorityA = getGridEntryPriority(a);
          const priorityB = getGridEntryPriority(b);
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }

          if (priorityA === 2) {
            const statusPriorityA =
              statusPriority[a?.healthStatus] ?? statusPriority.unknown;
            const statusPriorityB =
              statusPriority[b?.healthStatus] ?? statusPriority.unknown;
            if (statusPriorityA !== statusPriorityB) {
              return statusPriorityA - statusPriorityB;
            }

            const isCoreA = Boolean(a?.isCore ?? a?.server?.isCore);
            const isCoreB = Boolean(b?.isCore ?? b?.server?.isCore);
            if (isCoreA !== isCoreB) {
              return isCoreA ? -1 : 1;
            }
          }

          return compareNames(a, b);
        };

        return {
          configuredEnabled,
          unconfigured,
          configuredDisabled,
          configuredMissingSetup,
          ordered: [...(Array.isArray(entries) ? entries : [])].sort(
            compareGridEntries,
          ),
        };
      };
const HOST_MODE_MISSING_SETUP_MESSAGE =
  "The necessary dependencies needed to run Host-mode integrations are not installed. These servers will be unavailable. For help, please ask in #help-portico on Slack.";

function hideMcpBadgeTooltipShell() {
  const tooltip = document.getElementById("mcp-tooltip");
  if (!tooltip) {
    return;
  }

  tooltip.style.display = "none";
  tooltip.style.opacity = "0";
  tooltip.style.visibility = "hidden";
  tooltip.style.pointerEvents = "none";
}

function hideMcpBadgeTooltipNow() {
  mcpBadgeHoverState = false;
  mcpBadgeTooltipVisible = false;
  mcpBadgeTooltipRequestId += 1;
  hideMcpBadgeTooltipShell();
  window.electronAPI?.mcpTooltip?.hide?.().catch(() => {});
}

function clearMcpBadgeTooltipTimers() {
  if (mcpBadgeHoverDelayTimeout) {
    clearTimeout(mcpBadgeHoverDelayTimeout);
    mcpBadgeHoverDelayTimeout = null;
  }
}

function recordMcpBadgePointerPosition(event) {
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }

  mcpBadgeLastPointerPosition = { x, y };
}

function ensureMcpBadgePointerTracking() {
  if (mcpBadgePointerTrackingBound) {
    return;
  }

  mcpBadgePointerTrackingBound = true;
  window.addEventListener("pointermove", recordMcpBadgePointerPosition, true);
  window.addEventListener("pointerdown", recordMcpBadgePointerPosition, true);
}

function isOverlayInteractionSuppressed() {
  return Boolean(
    document.body?.classList?.contains?.("overlay-interaction-suppressed"),
  );
}

function shouldBlockMcpBadgeTooltipShow() {
  return (
    mcpBadgeTooltipSuppressedUntilPointerMove || isOverlayInteractionSuppressed()
  );
}

function releaseMcpBadgeTooltipSuppression() {
  mcpBadgeTooltipSuppressedUntilPointerMove = false;
  mcpBadgeTooltipSuppressionStartPoint = null;

  if (!mcpBadgeTooltipSuppressionReleaseHandler) {
    return;
  }

  window.removeEventListener(
    "pointermove",
    mcpBadgeTooltipSuppressionReleaseHandler,
    true,
  );
  window.removeEventListener(
    "pointerdown",
    mcpBadgeTooltipSuppressionReleaseHandler,
    true,
  );
  mcpBadgeTooltipSuppressionReleaseHandler = null;
}

function suppressMcpBadgeTooltip(options = {}) {
  const { untilPointerMove = false } = options;

  clearMcpBadgeTooltipTimers();
  hideMcpBadgeTooltipNow();

  if (!untilPointerMove) {
    releaseMcpBadgeTooltipSuppression();
    return;
  }

  ensureMcpBadgePointerTracking();
  mcpBadgeTooltipSuppressedUntilPointerMove = true;
  mcpBadgeTooltipSuppressionStartPoint = mcpBadgeLastPointerPosition
    ? { ...mcpBadgeLastPointerPosition }
    : null;
  if (mcpBadgeTooltipSuppressionReleaseHandler) {
    return;
  }

  mcpBadgeTooltipSuppressionReleaseHandler = (event) => {
    if (event?.type === "pointerdown") {
      releaseMcpBadgeTooltipSuppression();
      return;
    }

    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    if (!mcpBadgeTooltipSuppressionStartPoint) {
      mcpBadgeTooltipSuppressionStartPoint = { x, y };
      return;
    }

    const deltaX = x - mcpBadgeTooltipSuppressionStartPoint.x;
    const deltaY = y - mcpBadgeTooltipSuppressionStartPoint.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < MCP_TOOLTIP_SUPPRESSION_RELEASE_DISTANCE_PX) {
      return;
    }

    releaseMcpBadgeTooltipSuppression();
  };

  window.addEventListener(
    "pointermove",
    mcpBadgeTooltipSuppressionReleaseHandler,
    true,
  );
  window.addEventListener(
    "pointerdown",
    mcpBadgeTooltipSuppressionReleaseHandler,
    true,
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(text, maxLength) {
  const value = String(text ?? "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatRelativeDuration(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 1000) return "just now";
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  const hours = Math.floor(ageMs / 3600000);
  const minutes = Math.floor((ageMs % 3600000) / 60000);
  return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

function formatSyncTimestamp(timestamp, ageMs) {
  if (!timestamp) return "never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "invalid";
  const relative = formatRelativeDuration(ageMs);
  const absolute = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return relative ? `${absolute} (${relative})` : absolute;
}

function renderHealthSyncDiagnostics(sync, syncDiagnostics = null) {
  if (!sync || typeof sync !== "object") return "";

  const pending = sync.pending_full_sync || {};
  const pendingReasons = Array.isArray(pending.reasons)
    ? pending.reasons.slice(0, 4).map((reason) => escapeHtml(reason))
    : [];
  const pendingText = pending.queued
    ? `${pending.reason_count || pendingReasons.length || 1} queued (${formatRelativeDuration(pending.queued_age_ms) || "pending"})`
    : "none";
  const warnings = Array.isArray(sync.warnings) ? sync.warnings : [];
  const laggingServers = Number(syncDiagnostics?.lagging_servers || 0);
  const laggingIds = Array.isArray(syncDiagnostics?.lagging_server_ids)
    ? syncDiagnostics.lagging_server_ids.slice(0, 4).map((id) => escapeHtml(id))
    : [];

  return `
    <div class="tooltip-sync-section">
      <div class="tooltip-sync-title">Health Sync</div>
      <div class="tooltip-sync-row">
        <span class="tooltip-sync-label">Last full attempt</span>
        <span class="tooltip-sync-value">${escapeHtml(
          formatSyncTimestamp(sync.last_full_sync_attempt_at, sync.last_full_sync_attempt_age_ms),
        )}</span>
      </div>
      <div class="tooltip-sync-row">
        <span class="tooltip-sync-label">Last full success</span>
        <span class="tooltip-sync-value">${escapeHtml(
          formatSyncTimestamp(sync.last_full_sync_success_at, sync.last_full_sync_success_age_ms),
        )}</span>
      </div>
      <div class="tooltip-sync-row">
        <span class="tooltip-sync-label">Pending full sync</span>
        <span class="tooltip-sync-value">${escapeHtml(pendingText)}</span>
      </div>
      <div class="tooltip-sync-row">
        <span class="tooltip-sync-label">Lagging servers</span>
        <span class="tooltip-sync-value">${escapeHtml(String(laggingServers))}</span>
      </div>
      ${
        pendingReasons.length > 0
          ? `<div class="tooltip-sync-reasons">${pendingReasons.join(", ")}</div>`
          : ""
      }
      ${
        laggingIds.length > 0
          ? `<div class="tooltip-sync-reasons">${laggingIds.join(", ")}</div>`
          : ""
      }
      ${
        warnings.length > 0
          ? `<div class="tooltip-sync-warning">${warnings
              .map((warning) => escapeHtml(warning.message || warning.code || "sync warning"))
              .join(" · ")}</div>`
          : ""
      }
    </div>
  `;
}

// Funny Sims-style messages for deletion process
const funnyDeleteMessages = [
  "Saying goodbye to server bits...",
  "Convincing Docker to let go...",
  "Shredding configuration files...",
  "Releasing server into the void...",
  "Untangling dependencies...",
  "Sweeping up digital crumbs...",
  "Erasing server memories...",
  "Closing interdimensional portals...",
  "Thanking the server for its service...",
  "Archiving nostalgia files...",
  "Notifying the cloud spirits...",
  "Deflating container balloons...",
  "Returning borrowed electrons...",
  "Filing farewell paperwork...",
  "Consulting the deletion oracle...",
  "Rewinding server timeline...",
  "Scattering config ashes...",
  "Feeding bits to the void...",
  "Polishing the empty slot...",
  "Completing the circle of life...",
];

/**
 * Get a random funny delete message
 */
function getRandomDeleteMessage() {
  return funnyDeleteMessages[
    Math.floor(Math.random() * funnyDeleteMessages.length)
  ];
}

/**
 * Show the delete confirmation modal
 */
function showDeleteConfirmationModal(serverId, serverName) {
  pendingDeleteServerId = serverId;
  pendingDeleteServerName = serverName;

  const modal = document.getElementById("delete-server-modal");
  const serverNameEl = document.getElementById("delete-server-name");

  if (serverNameEl) {
    serverNameEl.textContent = serverName;
  }

  if (modal) {
    modal.classList.add("visible");
  }

  // Set up button handlers
  const cancelBtn = document.getElementById("delete-server-cancel-btn");
  const confirmBtn = document.getElementById("delete-server-confirm-btn");
  const closeBtn = document.getElementById("delete-modal-close-btn");

  if (cancelBtn) {
    cancelBtn.onclick = hideDeleteConfirmationModal;
  }

  if (confirmBtn) {
    confirmBtn.onclick = confirmDeleteServer;
  }

  // X button handler
  if (closeBtn) {
    closeBtn.onclick = hideDeleteConfirmationModal;
  }

  // Handle escape key - remove old handler first
  if (deleteEscapeHandler) {
    document.removeEventListener("keydown", deleteEscapeHandler);
  }
  deleteEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideDeleteConfirmationModal();
    }
  };
  document.addEventListener("keydown", deleteEscapeHandler);

  // Handle click outside modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      hideDeleteConfirmationModal();
    }
  };
}

/**
 * Hide the delete confirmation modal
 */
function hideDeleteConfirmationModal() {
  const modal = document.getElementById("delete-server-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  pendingDeleteServerId = null;
  pendingDeleteServerName = null;
  // Clean up escape handler
  if (deleteEscapeHandler) {
    document.removeEventListener("keydown", deleteEscapeHandler);
    deleteEscapeHandler = null;
  }
}

/**
 * Confirm and execute server deletion
 */
async function confirmDeleteServer() {
  const serverId = pendingDeleteServerId;
  const serverName = pendingDeleteServerName;

  if (!serverId) {
    console.error("[MCP Delete] No server ID pending");
    return;
  }

  hideDeleteConfirmationModal();

  // Show loading with funny messages
  window.showLoading(getRandomDeleteMessage());
  const messageInterval = setInterval(() => {
    window.showLoading(getRandomDeleteMessage());
  }, 2500);

  try {
    console.log(`[MCP Delete] Deleting server: ${serverId}`);

    const result = await window.electronAPI.deleteUserMcpServer(serverId);
    console.log(`[MCP Delete] Result:`, result);

    clearInterval(messageInterval);

    if (result.success) {
      window.showNotification(`${serverName} deleted successfully`, "success");
      // Reload servers from backend and refresh UI
      const serversResult = await window.electronAPI.loadMcpServers();
      if (serversResult.success) {
        window.appState.servers = serversResult.data;
        if (window.updateMcpServersList) window.updateMcpServersList();
        if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
      }
    } else {
      window.showNotification(
        `Failed to delete ${serverName}: ${result.error}`,
        "error",
      );
    }
  } catch (error) {
    clearInterval(messageInterval);
    console.error("[MCP Delete] Error:", error);
    window.showNotification(
      `Error deleting ${serverName}: ${error.message}`,
      "error",
    );
  } finally {
    window.hideLoading();
  }
}

// Toggle confirmation modal state
let pendingToggleServerId = null;
let pendingToggleServerName = null;
let pendingToggleEnabled = null;
let pendingToggleDeploymentType = null;
let pendingToggleDisableMode = "soft";
let pendingBulkToggleServerIds = [];

// Funny Sims-style messages for toggle process
const funnyToggleMessages = [
  // Disable messages
  "Tucking server into bed...",
  "Putting server in timeout...",
  "Giving server a vacation...",
  "Dimming the server lights...",
  "Winding down the gears...",
  "Sending server to dreamland...",
  "Putting server on pause...",
  "Powering down the flux capacitor...",
  // Enable messages
  "Waking up the server...",
  "Brewing server coffee...",
  "Stretching server muscles...",
  "Warming up the circuits...",
  "Revving the engines...",
  "Caffeinating the container...",
  "Summoning server energy...",
  "Charging up the capacitors...",
  // Generic messages
  "Consulting the config gods...",
  "Reticulating splines...",
  "Aligning the quantum bits...",
  "Negotiating with Docker...",
  "Whispering to the containers...",
  "Adjusting the Matrix...",
  "Tuning the hyperparameters...",
  "Recalibrating the widgets...",
];

/**
 * Get a random funny toggle message
 */
function getRandomToggleMessage() {
  return funnyToggleMessages[
    Math.floor(Math.random() * funnyToggleMessages.length)
  ];
}

/**
 * Show the toggle confirmation modal
 */
function showToggleConfirmationModal(
  serverId,
  serverName,
  newEnabled,
  deploymentType,
  disableMode = "soft",
) {
  pendingToggleServerId = serverId;
  pendingToggleServerName = serverName;
  pendingToggleEnabled = newEnabled;
  pendingToggleDeploymentType = deploymentType;
  pendingToggleDisableMode = disableMode === "hard" ? "hard" : "soft";
  pendingBulkToggleServerIds = [];

  const modal = document.getElementById("toggle-server-modal");
  const serverNameEl = document.getElementById("toggle-server-name");
  const titleEl = document.getElementById("toggle-modal-title");
  const actionTextEl = document.getElementById("toggle-action-text");
  const infoTextEl = document.getElementById("toggle-info-text");
  const confirmBtn = document.getElementById("toggle-server-confirm-btn");

  if (serverNameEl) {
    serverNameEl.textContent = serverName;
  }

  // Update modal content based on action (enable vs disable soft/hard)
  if (newEnabled) {
    // Enabling
    modal?.classList.add("enable-mode");
    modal?.classList.remove("hard-mode");
    if (titleEl) titleEl.textContent = "Enable Integration";
    if (actionTextEl) actionTextEl.textContent = "enable";
    if (infoTextEl) {
      if (deploymentType === "host") {
        infoTextEl.textContent =
          "The host MCP service will be restarted to include this integration.";
      } else {
        infoTextEl.textContent =
          "This integration may take a few moments to enable.";
      }
    }
    if (confirmBtn) confirmBtn.textContent = "Enable Integration";
  } else if (pendingToggleDisableMode === "hard") {
    // Hard disable (PORTICO-410): fully opaque to the AI.
    modal?.classList.remove("enable-mode");
    modal?.classList.add("hard-mode");
    if (titleEl) titleEl.textContent = "Disable Integration (Hard)";
    if (actionTextEl) actionTextEl.textContent = "hard-disable";
    if (infoTextEl) {
      infoTextEl.textContent =
        deploymentType === "host"
          ? "The host MCP service will be restarted without this integration. The AI will not see this integration and cannot re-enable it. Only you can re-enable it from the Control Plane."
          : "The AI will not see this integration and cannot re-enable it. Only you can re-enable it from the Control Plane.";
    }
    if (confirmBtn) confirmBtn.textContent = "Disable (Hard)";
  } else {
    // Soft disable — today's behavior; the AI may re-enable it when needed.
    modal?.classList.remove("enable-mode");
    modal?.classList.remove("hard-mode");
    if (titleEl) titleEl.textContent = "Disable Integration (Soft)";
    if (actionTextEl) actionTextEl.textContent = "disable";
    if (infoTextEl) {
      infoTextEl.textContent =
        deploymentType === "host"
          ? "The host MCP service will be restarted without this integration. You can re-enable it at any time, and the AI may re-enable it when a task needs it."
          : "You can re-enable it at any time, and the AI may re-enable it when a task needs it.";
    }
    if (confirmBtn) confirmBtn.textContent = "Disable (Soft)";
  }

  if (modal) {
    modal.classList.add("visible");
  }

  // Set up button handlers
  const cancelBtn = document.getElementById("toggle-server-cancel-btn");
  const closeBtn = document.getElementById("toggle-modal-close-btn");

  if (cancelBtn) {
    cancelBtn.onclick = hideToggleConfirmationModal;
  }

  if (confirmBtn) {
    confirmBtn.onclick = confirmToggleServer;
  }

  // X button handler
  if (closeBtn) {
    closeBtn.onclick = hideToggleConfirmationModal;
  }

  // Handle escape key - remove old handler first
  if (toggleEscapeHandler) {
    document.removeEventListener("keydown", toggleEscapeHandler);
  }
  toggleEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideToggleConfirmationModal();
    }
  };
  document.addEventListener("keydown", toggleEscapeHandler);

  // Handle click outside modal
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideToggleConfirmationModal();
      }
    };
  }
}

function showBulkToggleConfirmationModal(servers, newEnabled) {
  const targetServers = Array.isArray(servers) ? servers : [];
  if (targetServers.length === 0) {
    return;
  }

  pendingBulkToggleServerIds = targetServers.map((server) => server.id);
  pendingToggleEnabled = newEnabled;
  pendingToggleServerId = null;
  pendingToggleServerName = null;
  pendingToggleDeploymentType = null;
  pendingToggleDisableMode = "soft";

  const modal = document.getElementById("toggle-server-modal");
  const serverNameEl = document.getElementById("toggle-server-name");
  const titleEl = document.getElementById("toggle-modal-title");
  const actionTextEl = document.getElementById("toggle-action-text");
  const infoTextEl = document.getElementById("toggle-info-text");
  const confirmBtn = document.getElementById("toggle-server-confirm-btn");
  const cancelBtn = document.getElementById("toggle-server-cancel-btn");
  const closeBtn = document.getElementById("toggle-modal-close-btn");

  if (serverNameEl) {
    const noun = targetServers.length === 1 ? "server" : "servers";
    serverNameEl.textContent = `${targetServers.length} selected ${noun}`;
  }

  if (newEnabled) {
    modal?.classList.add("enable-mode");
    modal?.classList.remove("hard-mode");
    if (titleEl) titleEl.textContent = "Enable Selected Servers";
    if (actionTextEl) actionTextEl.textContent = "enable";
    if (infoTextEl) {
      infoTextEl.textContent =
        "Selected servers will be enabled. Docker servers will start containers and host servers may restart the host MCP service.";
    }
    if (confirmBtn) confirmBtn.textContent = "Enable Selected";
  } else {
    modal?.classList.remove("enable-mode");
    modal?.classList.remove("hard-mode");
    if (titleEl) titleEl.textContent = "Disable Selected Servers";
    if (actionTextEl) actionTextEl.textContent = "disable";
    if (infoTextEl) {
      infoTextEl.textContent =
        "Selected servers will be disabled. Docker servers will stop containers and host servers may restart the host MCP service.";
    }
    if (confirmBtn) confirmBtn.textContent = "Disable Selected";
  }

  if (modal) {
    modal.classList.add("visible");
  }

  if (cancelBtn) {
    cancelBtn.onclick = hideToggleConfirmationModal;
  }

  if (confirmBtn) {
    confirmBtn.onclick = confirmBulkToggleServers;
  }

  if (closeBtn) {
    closeBtn.onclick = hideToggleConfirmationModal;
  }

  if (toggleEscapeHandler) {
    document.removeEventListener("keydown", toggleEscapeHandler);
  }
  toggleEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideToggleConfirmationModal();
    }
  };
  document.addEventListener("keydown", toggleEscapeHandler);

  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideToggleConfirmationModal();
      }
    };
  }
}

/**
 * Hide the toggle confirmation modal
 */
function hideToggleConfirmationModal() {
  const modal = document.getElementById("toggle-server-modal");
  if (modal) {
    modal.classList.remove("visible");
    modal.classList.remove("enable-mode");
    modal.classList.remove("hard-mode");
  }
  pendingToggleServerId = null;
  pendingToggleServerName = null;
  pendingToggleEnabled = null;
  pendingToggleDeploymentType = null;
  pendingToggleDisableMode = "soft";
  pendingBulkToggleServerIds = [];
  // Clean up escape handler
  if (toggleEscapeHandler) {
    document.removeEventListener("keydown", toggleEscapeHandler);
    toggleEscapeHandler = null;
  }
}

/**
 * Switch the disable mode of an already-disabled server (PORTICO-410).
 */
async function handleDisableModeSwitch(serverId, targetMode) {
  const state = window.appState;
  const server = state.servers.find((entry) => entry.id === serverId);
  const label = server?.display_name || server?.name || serverId;

  if (typeof window.electronAPI?.setMcpDisableMode !== "function") {
    window.showNotification(
      "Changing the disable mode is not supported in this build.",
      "error",
    );
    return;
  }

  try {
    const result = await window.electronAPI.setMcpDisableMode(
      serverId,
      targetMode,
    );
    if (result?.success) {
      if (!state.disableModes || typeof state.disableModes !== "object") {
        state.disableModes = {};
      }
      if (targetMode === "hard") {
        state.disableModes[serverId] = "hard";
        // Hard implies toggled-off on disk (the IPC forces the boolean for
        // servers whose toggle key was absent) — mirror it locally so
        // desired-state menus/badges are right before any broadcast lands.
        if (!state.toggles || typeof state.toggles !== "object") {
          state.toggles = {};
        }
        state.toggles[serverId] = false;
      } else {
        delete state.disableModes[serverId];
      }
      window.showNotification(
        targetMode === "hard"
          ? `${label} is now hard-disabled — the AI cannot see or enable it.`
          : `${label} is now soft-disabled — the AI may re-enable it when needed.`,
        "success",
      );
      if (window.updateMcpServersList) window.updateMcpServersList();
    } else {
      window.showNotification(
        `Could not change disable mode for ${label}: ${result?.error || "Unknown error"}`,
        "error",
      );
    }
  } catch (error) {
    window.showNotification(
      `Could not change disable mode for ${label}: ${error.message || "Unknown error"}`,
      "error",
    );
  }
}

/**
 * Optimistically mirror a confirmed toggle's disable-mode effect into local
 * state so badges/menus are correct before the main-process broadcast lands.
 */
function applyLocalDisableModeState(serverId, enabled, disableMode) {
  const state = window.appState;
  if (!state.disableModes || typeof state.disableModes !== "object") {
    state.disableModes = {};
  }
  if (enabled) {
    delete state.disableModes[serverId];
  } else if (disableMode === "hard") {
    state.disableModes[serverId] = "hard";
  }
}

function applyLocalToggleState(serverId, enabled, options = {}) {
  window.appState.toggles[serverId] = enabled;
  const healthStatus = ensureLocalHealthStatusSnapshot(window.appState);
  const progressApi = getMcpOperationProgressApi();
  if (progressApi && healthStatus?.servers) {
    const updated = progressApi.applyLocalToggleHealthState(
      healthStatus.servers,
      serverId,
      enabled,
      options,
    );
    if (updated?.summary) {
      healthStatus.summary = updated.summary;
    }
  }
  if (!enabled && window.appState.serverToolsCache) {
    delete window.appState.serverToolsCache[serverId];
  }
}

function getMcpOperationProgressApi() {
  return window.McpOperationProgress || null;
}

function getPendingServerOperation(serverId) {
  const authoritative =
    window.McpOperationOverlayController?.getCurrentSnapshot?.();
  if (authoritative) {
    const row = authoritative.rows?.find((entry) => entry.id === serverId);
    if (authoritative.terminal !== true) {
      if (row && row.terminal !== true) {
        return {
          serverId,
          label: row.label || serverId,
          targetEnabled: authoritative.kind !== "disable",
          stage: row.stage || authoritative.phase || "starting",
          detail: row.detail || row.stageLabel || "Operation in progress",
          operationId: authoritative.operationId,
          authoritative: true,
          startedAt: authoritative.createdAt || Date.now(),
          updatedAt: authoritative.updatedAt || Date.now(),
        };
      }
    } else if (row) {
      // A completed authoritative operation supersedes any stale locally-seeded
      // pending op (e.g. post_oauth_recovery) that was registered no later than
      // this operation finished. Without this, an orphaned targetEnabled:true
      // entry can pin the card enabled and block an explicit disable until an
      // app restart clears in-memory state.
      const legacy = window.appState.pendingServerOperations?.[serverId] || null;
      if (legacy) {
        const authoritativeAt = Number(
          authoritative.updatedAt || authoritative.createdAt || 0,
        );
        const legacyAt = Number(legacy.updatedAt || legacy.startedAt || 0);
        if (authoritativeAt >= legacyAt) {
          clearPendingServerOperation(serverId);
          return null;
        }
      }
    }
  }
  return window.appState.pendingServerOperations?.[serverId] || null;
}

function ensureLocalHealthStatusSnapshot(state = window.appState) {
  if (!state) {
    return null;
  }

  if (!state.healthStatus || typeof state.healthStatus !== "object") {
    state.healthStatus = {
      servers: {},
      summary: recalculateLocalHealthSummary({}),
    };
  }

  if (!state.healthStatus.servers || typeof state.healthStatus.servers !== "object") {
    state.healthStatus.servers = {};
  }

  if (!state.healthStatus.summary || typeof state.healthStatus.summary !== "object") {
    state.healthStatus.summary = recalculateLocalHealthSummary(
      state.healthStatus.servers,
    );
  }

  return state.healthStatus;
}

function scheduleMcpServersListRefresh(reason = "mcp-state-change") {
  if (mcpServerListRefreshQueued) {
    return;
  }
  mcpServerListRefreshQueued = true;
  const render = () => {
    mcpServerListRefreshQueued = false;
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(render);
  } else {
    setTimeout(render, 0);
  }
  console.log(`[MCP Servers] Scheduled refresh (${reason})`);
}

function setPendingServerOperation(serverId, nextOperation) {
  const state = window.appState;
  if (!state.pendingServerOperations) {
    state.pendingServerOperations = {};
  }
  const existingOperation = state.pendingServerOperations[serverId] || {};
  const timestamp = Date.now();
  state.pendingServerOperations[serverId] = {
    ...existingOperation,
    ...nextOperation,
    startedAt:
      Number.isFinite(Number(existingOperation.startedAt))
        ? Number(existingOperation.startedAt)
        : timestamp,
    updatedAt: timestamp,
  };
}

// Configure/Auth success flows can close before the next backend health broadcast.
// Seed the local state so the Control Plane immediately shows the server starting.
function markMcpServerPostSuccessStarting(serverId, options = {}) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  const label =
    options.label || server?.display_name || server?.name || serverId;
  const stage = options.stage || "waiting";
  const detail = options.detail || "Waiting for readiness...";

  if (server) {
    server.isConfigured = true;
  }

  if (!state.toggles || typeof state.toggles !== "object") {
    state.toggles = {};
  }
  if (options.applyLocalToggle !== false) {
    state.toggles[serverId] = true;
  }

  const healthStatus = ensureLocalHealthStatusSnapshot(state);
  const progressApi = getMcpOperationProgressApi();
  if (progressApi && healthStatus?.servers) {
    const updated = progressApi.applyLocalToggleHealthState(
      healthStatus.servers,
      serverId,
      true,
    );
    if (updated?.summary) {
      healthStatus.summary = updated.summary;
    }
  }

  if (healthStatus?.servers) {
    const current = healthStatus.servers[serverId] || {};
    healthStatus.servers[serverId] = {
      ...current,
      configured: true,
      status: stage === "checking" ? "checking" : "starting",
      error: null,
      running: false,
      host: null,
      port: null,
      disabled_by_user: false,
      disabled_reason: null,
      authorization_url_available: false,
      authorizationUrlAvailable: false,
      oauth_state: null,
    };
    healthStatus.summary = recalculateLocalHealthSummary(healthStatus.servers);
  }

  setPendingServerOperation(serverId, {
    serverId,
    label,
    targetEnabled: true,
    stage,
    detail,
    operationKind: options.operationKind || null,
    postAuthRecovery: options.postAuthRecovery === true,
  });

  if (window.updateMcpServersList) window.updateMcpServersList();
  if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();

  return { serverId, stage, detail };
}

function markMcpServerEnableAttemptStarted(serverId, options = {}) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  const label =
    options.label || server?.display_name || server?.name || serverId;
  const stage = options.stage || "applying";
  const detail = options.detail || "Applying configuration...";

  if (!state.toggles || typeof state.toggles !== "object") {
    state.toggles = {};
  }
  state.toggles[serverId] = true;

  applyLocalToggleState(serverId, true, {
    status: options.status || "starting",
    error: null,
    running: false,
    host: null,
    port: null,
    authorizationUrlAvailable: false,
    oauthState: null,
  });

  setPendingServerOperation(serverId, {
    serverId,
    label,
    targetEnabled: true,
    stage,
    detail,
  });
  updateMcpOperationTracker(serverId, {
    stage,
    detail,
  });
  scheduleMcpServersListRefresh(`enable-attempt:${serverId}`);

  return { serverId, stage, detail };
}

function markMcpServerEnabledNeedsConfiguration(serverId, options = {}) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  const label =
    options.label || server?.display_name || server?.name || serverId;
  const detail =
    options.detail || "Configuration required before this integration can start.";

  if (server) {
    server.isConfigured = false;
  }

  applyLocalToggleState(serverId, true, {
    configured: false,
    status: "not_configured",
    error: null,
    running: false,
    host: null,
    port: null,
    authorizationUrlAvailable: false,
    oauthState: null,
  });

  updateMcpOperationTracker(serverId, {
    stage: "not_configured",
    detail,
  });
  clearPendingServerOperation(serverId);

  if (window.updateMcpServersList) window.updateMcpServersList();
  if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();

  return { serverId, label, detail };
}

function markMcpServerEnabledNeedsAuthentication(serverId, options = {}) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  const label =
    options.label || server?.display_name || server?.name || serverId;
  const detail =
    options.detail ||
    "Authentication required before this integration can be configured.";

  if (server) {
    server.isConfigured = false;
    server.hasOAuthTokens = false;
  }

  applyLocalToggleState(serverId, true, {
    configured: false,
    status: "needs_oauth",
    error: null,
    running: false,
    host: null,
    port: null,
    authorizationUrlAvailable: false,
    oauthState: null,
  });

  updateMcpOperationTracker(serverId, {
    stage: "needs_oauth",
    detail,
  });
  clearPendingServerOperation(serverId);

  if (window.updateMcpServersList) window.updateMcpServersList();
  if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();

  return { serverId, label, detail };
}

// The authoritative operation coordinator (overlay controller) drives enable
// results through main-process snapshots and does not update the renderer's
// local toggle cache. When an enable finishes needing OAuth/configuration and
// the user dismisses the overlay without authenticating, the container is
// created but state.toggles[id] can remain a stale `false`, so isServerEnabled
// short-circuits to disabled and the Authenticate button never renders. Mirror
// the legacy toggle path by reconciling local state from the terminal snapshot.
function reconcileEnableTerminalOperationState(snapshot) {
  const state = window.appState;
  if (!state || !snapshot || snapshot.terminal !== true) {
    return;
  }
  if (snapshot.kind !== "enable") {
    return;
  }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  for (const row of rows) {
    if (!row || !row.id) {
      continue;
    }
    const stage = String(row.stage || row.terminalState || "").toLowerCase();
    if (stage === "needs_oauth" || stage === "waiting_callback") {
      markMcpServerEnabledNeedsAuthentication(row.id, { label: row.label });
    } else if (stage === "not_configured") {
      markMcpServerEnabledNeedsConfiguration(row.id, {
        label: row.label,
        detail: row.detail,
      });
    } else if (
      stage === "healthy" ||
      stage === "running" ||
      stage === "starting" ||
      stage === "checking"
    ) {
      applyLocalToggleState(row.id, true, { status: stage });
    }
    // Failure stages (failed/timeout/not_running) are intentionally left to the
    // existing health and startup-failure reconciliation.
  }
}

function markMcpServerOAuthAuthenticated(serverId, options = {}) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  if (!server) {
    return null;
  }

  server.hasOAuthTokens = true;
  const configurationPending =
    typeof options.configurationPending === "boolean"
      ? options.configurationPending
      : serverRequiresConfig(server) && server.isConfigured !== true;

  if (configurationPending) {
    server.isConfigured = false;
    const enabled = isServerEnabled(server, state);
    if (enabled) {
      applyLocalToggleState(serverId, true, {
        configured: false,
        status: "not_configured",
        error: null,
        running: false,
        host: null,
        port: null,
        authorizationUrlAvailable: false,
        oauthState: null,
      });
      updateMcpOperationTracker(serverId, {
        stage: "not_configured",
        detail: "Authentication complete; configuration required.",
      });
    } else {
      const healthStatus = ensureLocalHealthStatusSnapshot(state);
      if (healthStatus?.servers?.[serverId]) {
        healthStatus.servers[serverId] = {
          ...healthStatus.servers[serverId],
          configured: false,
        };
        healthStatus.summary = recalculateLocalHealthSummary(
          healthStatus.servers,
        );
      }
    }
    clearPendingServerOperation(serverId);
  }

  scheduleMcpServersListRefresh(
    configurationPending
      ? `oauth-complete-config-pending:${serverId}`
      : `oauth-complete:${serverId}`,
  );
  return { serverId, configurationPending };
}

function markMcpServerOAuthUnauthenticated(serverId) {
  const state = window.appState;
  if (!serverId || !state) {
    return null;
  }

  const server = Array.isArray(state.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  if (!server) {
    return null;
  }

  server.hasOAuthTokens = false;
  if (isServerEnabled(server, state)) {
    applyLocalToggleState(serverId, true, {
      configured: server.isConfigured === true,
      status: "needs_oauth",
      error: null,
      running: false,
      host: null,
      port: null,
      authorizationUrlAvailable: false,
      oauthState: null,
    });
  }
  scheduleMcpServersListRefresh(`oauth-missing:${serverId}`);
  return { serverId };
}

async function refreshServerOAuthTokenState(server) {
  if (!serverRequiresOAuth(server)) {
    return true;
  }

  let hasOAuthTokens = false;
  try {
    const tokenState =
      await window.electronAPI?.checkOAuthTokensExist?.(server.id);
    hasOAuthTokens = tokenState?.exists === true;
  } catch (error) {
    console.warn(
      `[OAuth] Failed to refresh token state for ${server.id}:`,
      error,
    );
  }

  server.hasOAuthTokens = hasOAuthTokens;
  return hasOAuthTokens;
}

async function resolveSetupActionAfterConfigurationRequired(server) {
  if (serverRequiresOAuth(server)) {
    await refreshServerOAuthTokenState(server);
  }
  return resolveServerSetupAction(server, { isConfigured: false }) || "configure";
}

function clearPendingServerOperation(serverId) {
  const state = window.appState;
  if (state.pendingServerOperations) {
    delete state.pendingServerOperations[serverId];
  }
}

function getStartupFailureInfo(healthInfo, serverId = null) {
  if (!healthInfo || typeof healthInfo !== "object") {
    return null;
  }
  const expectedServerId = String(serverId || "").trim();
  const failureMatchesServer = (failure) => {
    if (!expectedServerId) {
      return true;
    }
    const failureServerId = String(
      failure?.serverId || failure?.server_id || "",
    ).trim();
    return !failureServerId || failureServerId === expectedServerId;
  };
  if (
    healthInfo.startup_failure &&
    typeof healthInfo.startup_failure === "object"
  ) {
    if (!failureMatchesServer(healthInfo.startup_failure)) {
      return null;
    }
    return healthInfo.startup_failure;
  }
  const error = String(healthInfo.error || "").trim();
  const source = String(
    healthInfo.startup_failure_source || healthInfo.source || "",
  ).trim();
  const stage = String(
    healthInfo.startup_failure_stage || healthInfo.stage || "",
  ).trim();
  if (!error || (!source && !stage)) {
    return null;
  }
  const failure = {
    serverId: healthInfo.serverId || null,
    operation: healthInfo.operation || "enable",
    stage: stage || "startup",
    error,
    source: source || "runtime",
    timestamp: healthInfo.startup_failure_timestamp || healthInfo.timestamp,
    deploymentType: healthInfo.deployment || healthInfo.deploymentType,
    containerName: healthInfo.container_name || healthInfo.containerName,
    configPath: healthInfo.config_path || healthInfo.configPath,
  };
  return failureMatchesServer(failure) ? failure : null;
}

function hasStartupFailureState(healthStatus, healthInfo, serverId = null) {
  const normalizedStatus = String(healthStatus || healthInfo?.status || "")
    .trim()
    .toLowerCase();
  if (
    healthInfo?.startup_failure &&
    typeof healthInfo.startup_failure === "object"
  ) {
    return Boolean(getStartupFailureInfo(healthInfo, serverId));
  }
  if (normalizedStatus === "disabled" || healthInfo?.disabled_by_user === true) {
    return false;
  }
  if (getStartupFailureInfo(healthInfo, serverId)) {
    return true;
  }
  return (
    (healthStatus === "failed" ||
      healthStatus === "timeout" ||
      healthStatus === "not_running") &&
    Boolean(String(healthInfo?.error || "").trim())
  );
}

function isConfigStartupFailure(healthInfo, serverId = null) {
  const failure = getStartupFailureInfo(healthInfo, serverId);
  const source = String(failure?.source || "").toLowerCase();
  const stage = String(failure?.stage || "").toLowerCase();
  // Only true config-stage failures have no useful runtime logs. Runtime
  // failures (readiness timeouts publish source "runtime" without a
  // containerName) must route to the real log viewer, not the fields-only
  // startup-failure modal.
  return (
    source === "config" ||
    stage === "config_generation" ||
    stage === "preflight"
  );
}

function markMcpServerStartupFailure(serverId, failure = {}) {
  const state = window.appState;
  const healthStatus = ensureLocalHealthStatusSnapshot(state);
  const error = String(failure.error || failure.message || "Startup failed");
  const startupFailure = {
    serverId,
    operation: failure.operation || "enable",
    stage: failure.stage || "startup",
    error,
    source: failure.source || "runtime",
    timestamp: failure.timestamp || new Date().toISOString(),
    ...(failure.deploymentType ? { deploymentType: failure.deploymentType } : {}),
    ...(failure.containerName ? { containerName: failure.containerName } : {}),
    ...(failure.configPath ? { configPath: failure.configPath } : {}),
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
  };

  healthStatus.servers[serverId] = {
    ...(healthStatus.servers[serverId] || {}),
    status: startupFailure.stage === "timeout" ? "timeout" : "failed",
    error,
    running: false,
    host: null,
    port: null,
    disabled_by_user: false,
    disabled_reason: null,
    startup_failure: startupFailure,
    startup_failure_source: startupFailure.source,
    startup_failure_stage: startupFailure.stage,
    startup_failure_timestamp: startupFailure.timestamp,
  };
  healthStatus.summary = recalculateLocalHealthSummary(healthStatus.servers);
  clearPendingServerOperation(serverId);
  updateMcpOperationTracker(serverId, {
    stage: startupFailure.stage === "timeout" ? "timeout" : "failed",
    detail: error,
  });
  scheduleMcpServersListRefresh(`startup-failure:${serverId}`);
}

function createOperationServers(servers, targetEnabled) {
  return servers.map((server) => ({
    id: server.id,
    label: server.display_name || server.name || server.id,
    targetEnabled,
  }));
}

function startMcpOperationTracker(action, title, servers, targetEnabled) {
  const state = window.appState;
  const progressApi = getMcpOperationProgressApi();
  if (!progressApi) {
    return null;
  }

  state.activeMcpOperationTracker = progressApi.createTracker({
    action,
    title,
    servers: createOperationServers(servers, targetEnabled),
  });

  if (targetEnabled) {
    for (const server of servers) {
      setPendingServerOperation(server.id, {
        serverId: server.id,
        label: server.display_name || server.name || server.id,
        targetEnabled: true,
        stage: "queued",
        detail: "Queued",
      });
    }
  } else {
    for (const server of servers) {
      setPendingServerOperation(server.id, {
        serverId: server.id,
        label: server.display_name || server.name || server.id,
        targetEnabled: false,
        stage: "queued",
        detail: "Queued",
      });
    }
  }

  renderActiveMcpOperationTracker();
  return state.activeMcpOperationTracker;
}

function updateMcpOperationTracker(serverId, patch = {}, options = {}) {
  const state = window.appState;
  const progressApi = getMcpOperationProgressApi();
  const tracker = state.activeMcpOperationTracker;
  if (!progressApi || !tracker) {
    return;
  }

  progressApi.updateTrackerServer(tracker, serverId, patch);

  const pendingOperation = getPendingServerOperation(serverId);
  if (pendingOperation) {
    setPendingServerOperation(serverId, {
      stage: patch.stage || pendingOperation.stage,
      detail: patch.detail || pendingOperation.detail,
    });
  }

  if (options.render !== false) {
    renderActiveMcpOperationTracker();
  }
}

function finishMcpOperationTracker() {
  const state = window.appState;
  state.activeMcpOperationTracker = null;
}

function renderActiveMcpOperationTracker() {
  const state = window.appState;
  const progressApi = getMcpOperationProgressApi();
  const tracker = state.activeMcpOperationTracker;
  if (!progressApi || !tracker) {
    return;
  }

  const view = progressApi.buildTrackerView(tracker);
  window.showLoading(view);

  if (view.terminal) {
    const finishedTracker = tracker;
    setTimeout(() => {
      if (window.appState.activeMcpOperationTracker === finishedTracker) {
        finishMcpOperationTracker();
        if (window.updateMcpServersList) window.updateMcpServersList();
      }
    }, MCP_PROGRESS_HIDE_DELAY_MS);
  }
}

function handleSuccessfulServerEnable(serverId, serverName) {
  setPendingServerOperation(serverId, {
    serverId,
    label: serverName,
    targetEnabled: true,
    stage: "waiting",
    detail: "Waiting for readiness...",
  });
  updateMcpOperationTracker(serverId, {
    stage: "waiting",
    detail: "Waiting for readiness...",
  });
}

function syncPendingMcpOperationsFromHealthStatus(healthStatus) {
  // Authoritative operations are driven only by main-process snapshots. Health
  // broadcasts remain card reconciliation and must not advance/regress rows.
  if (window.McpOperationOverlayController?.isSupported?.()) {
    return;
  }
  const state = window.appState;
  const progressApi = getMcpOperationProgressApi();
  if (!progressApi || !state.pendingServerOperations) {
    return;
  }

  const serversById = new Map(
    (state.servers || [])
      .filter((server) => server && server.id)
      .map((server) => [server.id, server]),
  );

  for (const [serverId, operation] of Object.entries(state.pendingServerOperations)) {
    const server = serversById.get(serverId) || null;
    const backendInfo = healthStatus?.servers?.[serverId] || null;
    const backendStatus = normalizeBackendHealthStatusForUi(backendInfo);
    const backendStage = progressApi.stageFromHealthStatus(backendStatus);
    const backendError = getDisplayHealthError(backendStatus, backendInfo);
    const progressOptions = {
      backendError,
      expectsOAuth: serverExpectsOAuth(server, backendInfo),
      allowNotConfiguredOverride: Boolean(server?.isConfigured),
    };

    if (operation.targetEnabled) {
      if (
        progressApi.shouldPreferPendingStateForEnableBackendStatus(
          backendStatus,
          operation,
          progressOptions,
        )
      ) {
        const currentStage = progressApi.normalizeStage(operation.stage);
        const stage =
          currentStage === "queued" ||
          currentStage === "applying" ||
          currentStage === "restarting" ||
          progressApi.isTerminalStage(currentStage)
            ? "starting"
            : currentStage;
        const detail =
          backendInfo?.error &&
          /exposed no tools|bad gateway|fetch failed|connection refused/i.test(
            String(backendInfo.error),
          )
            ? "Waiting for tools to register..."
            : backendStatus === "not_running"
              ? "Runtime is still starting..."
              : operation.detail || progressApi.getStageMeta(stage).label;
        updateMcpOperationTracker(serverId, {
          stage,
          detail,
        });
        continue;
      }

      if (backendStatus !== "disabled" && backendStatus !== "unknown") {
        updateMcpOperationTracker(serverId, {
          stage: backendStage,
          detail:
            backendStage === "needs_oauth"
              ? progressApi.getStageMeta(backendStage).label
              : backendError || progressApi.getStageMeta(backendStage).label,
        });
        if (progressApi.isTerminalStage(backendStage)) {
          clearPendingServerOperation(serverId);
        }
      }
      continue;
    }

    if (backendStatus === "disabled") {
      clearPendingServerOperation(serverId);
    }
  }
}

/**
 * Confirm and execute the toggle operation
 */
async function confirmToggleServer() {
  const controller = window.McpOperationOverlayController;
  if (!controller?.isSupported?.()) {
    return confirmToggleServerLegacy();
  }

  const serverId = pendingToggleServerId;
  const serverName = pendingToggleServerName;
  const enabled = pendingToggleEnabled;
  const deploymentType = pendingToggleDeploymentType;
  const disableMode = pendingToggleDisableMode;
  hideToggleConfirmationModal();

  if (!serverId) {
    console.error("[MCP Toggle] No server ID to toggle");
    return;
  }

  const server = window.appState.servers.find((entry) => entry.id === serverId) || {
    id: serverId,
    name: serverName,
    display_name: serverName,
    deploymentType,
  };
  try {
    await controller.startOperation(
      createMcpOperationRequest(enabled ? "enable" : "disable", [server], {
        targetEnabled: enabled,
        // PORTICO-410: user-initiated enables lift a hard disable; disables carry
        // the chosen mode (hard pins the server out of the AI's world).
        ...(enabled
          ? { clearDisableMode: true, metadata: { clearDisableMode: true } }
          : disableMode === "hard"
            ? { disableMode: "hard", metadata: { disableMode: "hard" } }
            : {}),
      }),
      { servers: [server] },
    );
    applyLocalDisableModeState(serverId, enabled, disableMode);
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  } catch (error) {
    console.error("[MCP Toggle] Could not start operation:", error);
    window.showNotification(
      `Could not ${enabled ? "enable" : "disable"} ${serverName}: ${error.message || "Unknown error"}`,
      "error",
    );
  }
}

async function confirmToggleServerLegacy() {
  const serverId = pendingToggleServerId;
  const serverName = pendingToggleServerName;
  const enabled = pendingToggleEnabled;
  const deploymentType = pendingToggleDeploymentType;
  const disableMode = pendingToggleDisableMode;

  hideToggleConfirmationModal();

  if (!serverId) {
    console.error("[MCP Toggle] No server ID to toggle");
    return;
  }

  const server = window.appState.servers.find((entry) => entry.id === serverId) || {
    id: serverId,
    name: serverName,
    display_name: serverName,
  };
  startMcpOperationTracker(
    enabled ? "enable" : "disable",
    `${enabled ? "Enabling" : "Disabling"} ${serverName}`,
    [server],
    enabled,
  );
  if (enabled) {
    markMcpServerEnableAttemptStarted(serverId, {
      label: serverName,
      stage: "applying",
      detail: "Applying configuration...",
    });
  } else {
    updateMcpOperationTracker(serverId, {
      stage: "applying",
      detail: "Stopping server...",
    });
  }

  try {
    console.log(
      `[MCP Toggle] Toggling server: ${serverId} to ${enabled ? "enabled" : "disabled"}`,
    );

    const result = await window.electronAPI.toggleMcpServer(
      serverId,
      enabled,
      deploymentType,
      enabled
        ? { clearDisableMode: true }
        : disableMode === "hard"
          ? { disableMode: "hard" }
          : {},
    );
    console.log(`[MCP Toggle] Result:`, result);
    if (result.success) {
      applyLocalDisableModeState(serverId, enabled, disableMode);
    }

    if (result.success) {
      if (enabled) {
        if (result.requiresConfiguration) {
          const setupAction =
            await resolveSetupActionAfterConfigurationRequired(server);
          if (setupAction === "authenticate") {
            markMcpServerEnabledNeedsAuthentication(serverId, {
              label: serverName,
            });
            window.showNotification(
              `${serverName} enabled; authentication required`,
              "warning",
            );
          } else {
            markMcpServerEnabledNeedsConfiguration(serverId, {
              label: serverName,
              detail:
                result.message ||
                "Configuration required before this integration can start.",
            });
            window.showNotification(
              `${serverName} enabled; configuration required`,
              "warning",
            );
          }
        } else {
          applyLocalToggleState(serverId, enabled);
          handleSuccessfulServerEnable(serverId, serverName);
          await refreshServerAfterOperation(serverId, {
            waitForHealthy: true,
            maxWait: POST_OPERATION_MAX_WAIT_MS,
            onProgress: (progress) => {
              updateMcpOperationTracker(serverId, progress);
            },
          });
          window.showNotification(
            `${serverName} enabled successfully`,
            "success",
          );
        }
      } else {
        applyLocalToggleState(serverId, enabled);
        setPendingServerOperation(serverId, {
          serverId,
          label: serverName,
          targetEnabled: false,
          stage: "disabled",
          detail: "Disabled",
        });
        updateMcpOperationTracker(serverId, {
          stage: "disabled",
          detail: "Disabled",
        });
        window.showNotification(
          `${serverName} disabled successfully`,
          "success",
        );
      }

      if (window.updateMcpServersList) window.updateMcpServersList();
      if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
    } else {
      if (enabled) {
        markMcpServerStartupFailure(
          serverId,
          result.startupFailure || {
            operation: "enable",
            stage: result.stage || "startup",
            source: result.source || "runtime",
            error: result.error || "Operation failed",
            errorCode: result.errorCode || null,
          },
        );
      } else {
        updateMcpOperationTracker(serverId, {
          stage: "failed",
          detail: result.error || "Operation failed",
        });
        scheduleMcpServersListRefresh(`toggle-failure:${serverId}`);
      }
      window.showNotification(
        `Failed to ${enabled ? "enable" : "disable"} ${serverName}: ${result.error}`,
        "error",
      );
    }
  } catch (error) {
    console.error("[MCP Toggle] Error:", error);
    if (enabled) {
      markMcpServerStartupFailure(serverId, {
        operation: "enable",
        stage: "startup",
        source: "runtime",
        error: error.message || "Operation failed",
      });
    } else {
      updateMcpOperationTracker(serverId, {
        stage: "failed",
        detail: error.message || "Operation failed",
      });
      scheduleMcpServersListRefresh(`toggle-exception:${serverId}`);
    }
    window.showNotification(
      `Error ${enabled ? "enabling" : "disabling"} ${serverName}: ${error.message}`,
      "error",
    );
  }
}

function createMcpOperationClientRequestId() {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `mcp-operation-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function createMcpOperationRequest(action, servers, options = {}) {
  const normalizedServers = (Array.isArray(servers) ? servers : [])
    .filter((server) => server?.id || server?.serverId)
    .map((server) => ({
      serverId: server.id || server.serverId,
      label:
        server.display_name ||
        server.displayName ||
        server.name ||
        server.label ||
        server.id ||
        server.serverId,
      deploymentType: server.deployment_type || server.deploymentType || null,
    }));
  const targetEnabled =
    typeof options.targetEnabled === "boolean"
      ? options.targetEnabled
      : action !== "disable";
  return {
    clientRequestId: createMcpOperationClientRequestId(),
    kind: action,
    action,
    targetEnabled,
    serverIds: normalizedServers.map((server) => server.serverId),
    servers: normalizedServers,
    ...(options.disableMode ? { disableMode: options.disableMode } : {}),
    ...(options.clearDisableMode ? { clearDisableMode: true } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

async function confirmBulkToggleServers() {
  const controller = window.McpOperationOverlayController;
  if (!controller?.isSupported?.()) {
    return confirmBulkToggleServersLegacy();
  }

  const enabled = pendingToggleEnabled;
  const selectedIds = [...pendingBulkToggleServerIds];
  hideToggleConfirmationModal();

  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    return;
  }

  const state = window.appState;
  const actionTargets = selectedIds
    .map((serverId) => state.servers.find((server) => server.id === serverId))
    .filter((server) => server && isServerBulkSelectable(server, state));
  if (actionTargets.length === 0) {
    clearBulkSelection();
    return;
  }

  const request = createMcpOperationRequest(
    enabled ? "enable" : "disable",
    actionTargets,
    {
      targetEnabled: enabled,
      // PORTICO-410: bulk enable lifts hard disables; bulk disable stays soft.
      ...(enabled
        ? { clearDisableMode: true, metadata: { clearDisableMode: true } }
        : {}),
    },
  );

  try {
    await controller.startOperation(request, { servers: actionTargets });
    clearBulkSelection();
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  } catch (error) {
    console.error("[MCP Toggle] Could not start bulk operation:", error);
    window.showNotification(
      `Could not start MCP server update: ${error.message || "Unknown error"}`,
      "error",
    );
  }
}

async function confirmBulkToggleServersLegacy() {
  const enabled = pendingToggleEnabled;
  const selectedIds = [...pendingBulkToggleServerIds];

  hideToggleConfirmationModal();

  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    return;
  }

  const state = window.appState;
  const actionTargets = selectedIds
    .map((serverId) => state.servers.find((server) => server.id === serverId))
    .filter((server) => server && isServerBulkSelectable(server, state));

  if (actionTargets.length === 0) {
    clearBulkSelection();
    return;
  }

  startMcpOperationTracker(
    enabled ? "enable" : "disable",
    enabled ? "Enabling MCP servers" : "Disabling MCP servers",
    actionTargets,
    enabled,
  );
  actionTargets.forEach((server) => {
    if (enabled) {
      markMcpServerEnableAttemptStarted(server.id, {
        label: server.display_name || server.name || server.id,
        stage: "applying",
        detail: "Applying configuration...",
      });
    } else {
      updateMcpOperationTracker(server.id, {
        stage: "applying",
        detail: "Stopping server...",
      });
    }
  });

  let successCount = 0;
  let requiresAuthenticationCount = 0;
  let requiresConfigurationCount = 0;
  const failures = [];
  const successfulEnabledServerIds = [];

  try {
    const targetIds = actionTargets.map((server) => server.id);
    const bulkResult = await window.electronAPI.toggleMcpServersBulk(
      targetIds,
      enabled,
    );

    const resultMap = new Map();
    const resultEntries = Array.isArray(bulkResult?.results) ? bulkResult.results : [];
    resultEntries.forEach((entry) => {
      if (entry?.serverId) {
        resultMap.set(entry.serverId, entry);
      }
    });

    for (const server of actionTargets) {
      const entry = resultMap.get(server.id);
      const wasSuccessful =
        typeof entry?.success === "boolean"
          ? entry.success
          : Boolean(bulkResult?.success);
      if (wasSuccessful) {
        successCount += 1;
        if (enabled && entry?.requiresConfiguration) {
          const setupAction =
            await resolveSetupActionAfterConfigurationRequired(server);
          if (setupAction === "authenticate") {
            requiresAuthenticationCount += 1;
            markMcpServerEnabledNeedsAuthentication(server.id, {
              label: server.display_name || server.name || server.id,
            });
          } else {
            requiresConfigurationCount += 1;
            markMcpServerEnabledNeedsConfiguration(server.id, {
              label: server.display_name || server.name || server.id,
              detail:
                entry?.message ||
                "Configuration required before this integration can start.",
            });
          }
        } else {
          applyLocalToggleState(server.id, enabled);
        }
        if (enabled && !entry?.requiresConfiguration) {
          successfulEnabledServerIds.push(server.id);
        }
      } else {
        const failureError =
          entry?.error ||
          bulkResult?.error ||
          "Unknown error";
        failures.push({
          id: server.id,
          error: failureError,
        });
        if (enabled) {
          markMcpServerStartupFailure(
            server.id,
            entry?.startupFailure || {
              operation: "enable",
              stage: entry?.stage || "startup",
              source: entry?.source || "runtime",
              error: failureError,
              errorCode: entry?.errorCode || null,
            },
          );
        }
      }
    }

    const bulkErrors = Array.isArray(bulkResult?.errors) ? bulkResult.errors : [];
    if (bulkErrors.length > 0) {
      console.error("[MCP Toggle] Bulk toggle backend errors:", bulkErrors);
    }

    const actionLabel = enabled ? "enabled" : "disabled";
    const followUpCount =
      requiresAuthenticationCount + requiresConfigurationCount;
    if (failures.length === 0 && followUpCount === 0) {
      window.showNotification(
        `${successCount} server(s) ${actionLabel} successfully`,
        "success",
      );
    } else {
      const messageParts = [`${successCount} server(s) ${actionLabel}`];
      if (requiresAuthenticationCount > 0) {
        messageParts.push(
          `${requiresAuthenticationCount} require authentication`,
        );
      }
      if (requiresConfigurationCount > 0) {
        messageParts.push(`${requiresConfigurationCount} require configuration`);
      }
      if (failures.length > 0) {
        messageParts.push(`${failures.length} failed`);
      }
      window.showNotification(
        messageParts.join("; "),
        successCount === 0 && failures.length > 0 ? "error" : "warning",
      );
    }

    if (failures.length > 0) {
      console.error("[MCP Toggle] Bulk toggle failures:", failures);
    }

    if (enabled && successfulEnabledServerIds.length > 0) {
      const refreshPromises = successfulEnabledServerIds.map((serverId) => {
        const server = actionTargets.find((entry) => entry.id === serverId);
        handleSuccessfulServerEnable(
          serverId,
          server?.display_name || server?.name || serverId,
        );
        return refreshServerAfterOperation(serverId, {
          waitForHealthy: true,
          maxWait: POST_OPERATION_MAX_WAIT_MS,
          onProgress: (progress) => {
            updateMcpOperationTracker(serverId, progress);
          },
        });
      });
      await Promise.all(refreshPromises);
    } else if (!enabled) {
      actionTargets.forEach((server) => {
        if (!failures.find((entry) => entry.id === server.id)) {
          setPendingServerOperation(server.id, {
            serverId: server.id,
            label: server.display_name || server.name || server.id,
            targetEnabled: false,
            stage: "disabled",
            detail: "Disabled",
          });
          updateMcpOperationTracker(server.id, {
            stage: "disabled",
            detail: "Disabled",
          });
        }
      });
    }

    clearBulkSelection();
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  } finally {
    for (const failure of failures) {
      updateMcpOperationTracker(failure.id, {
        stage: "failed",
        detail: failure.error || "Operation failed",
      });
    }
  }
}

// ===== Restart Confirmation Modal Functions =====

/**
 * Show the restart confirmation modal
 * @param {string|null} serverId - Server ID for single restart, null for all servers
 * @param {string|null} serverName - Server name for display, null for all servers
 */
function showRestartConfirmationModal(serverId, serverName) {
  pendingRestartServerId = serverId;
  pendingRestartServerName = serverName;
  pendingRestartIsAll = !serverId; // If no serverId, it's restart all

  const modal = document.getElementById("restart-confirm-modal");
  const titleEl = document.getElementById("restart-modal-title");
  const serverNameEl = document.getElementById("restart-server-name");
  const infoTextEl = document.getElementById("restart-info-text");
  const confirmBtn = document.getElementById("restart-modal-confirm-btn");

  if (pendingRestartIsAll) {
    // Restart all servers mode
    modal?.classList.add("restart-all");
    if (titleEl) titleEl.textContent = "Restart All MCP Servers";
    if (serverNameEl) serverNameEl.textContent = "all MCP servers";
    if (infoTextEl)
      infoTextEl.textContent =
        "This will restart all MCP server containers. The restart takes approximately 30 seconds.";
    if (confirmBtn) confirmBtn.textContent = "Restart All";
  } else {
    // Single server restart
    modal?.classList.remove("restart-all");
    if (titleEl) titleEl.textContent = "Restart Server";
    if (serverNameEl) serverNameEl.textContent = serverName;
    if (infoTextEl)
      infoTextEl.textContent =
        "The server will be temporarily unavailable during restart.";
    if (confirmBtn) confirmBtn.textContent = "Restart";
  }

  if (modal) {
    modal.classList.add("visible");
  }

  // Set up button handlers
  const cancelBtn = document.getElementById("restart-modal-cancel-btn");
  const closeBtn = document.getElementById("restart-modal-close-btn");

  if (cancelBtn) {
    cancelBtn.onclick = hideRestartConfirmationModal;
  }

  if (confirmBtn) {
    confirmBtn.onclick = confirmRestart;
  }

  // X button handler
  if (closeBtn) {
    closeBtn.onclick = hideRestartConfirmationModal;
  }

  // Handle escape key - remove old handler first
  if (restartEscapeHandler) {
    document.removeEventListener("keydown", restartEscapeHandler);
  }
  restartEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideRestartConfirmationModal();
    }
  };
  document.addEventListener("keydown", restartEscapeHandler);

  // Handle click outside modal
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideRestartConfirmationModal();
      }
    };
  }
}

/**
 * Hide the restart confirmation modal
 */
function hideRestartConfirmationModal() {
  const modal = document.getElementById("restart-confirm-modal");
  if (modal) {
    modal.classList.remove("visible");
    modal.classList.remove("restart-all");
  }
  pendingRestartServerId = null;
  pendingRestartServerName = null;
  pendingRestartIsAll = false;
  // Clean up escape handler
  if (restartEscapeHandler) {
    document.removeEventListener("keydown", restartEscapeHandler);
    restartEscapeHandler = null;
  }
}

/**
 * Confirm and execute the restart operation
 */
async function confirmRestart() {
  const controller = window.McpOperationOverlayController;
  if (!controller?.isSupported?.()) {
    return confirmRestartLegacy();
  }

  const serverId = pendingRestartServerId;
  const serverName = pendingRestartServerName;
  const isAll = pendingRestartIsAll;
  hideRestartConfirmationModal();

  const state = window.appState;
  const restartTargets = isAll
    ? state.servers.filter((server) => isServerEnabled(server, state))
    : [
        state.servers.find((server) => server.id === serverId) || {
          id: serverId,
          name: serverName,
          display_name: serverName,
        },
      ].filter((server) => server?.id);
  if (restartTargets.length === 0) {
    window.showNotification(
      "No enabled MCP servers are available to restart",
      "info",
    );
    return;
  }

  try {
    await controller.startOperation(
      createMcpOperationRequest("restart", restartTargets, {
        targetEnabled: true,
        metadata: { scope: isAll ? "all" : "single" },
      }),
      { servers: restartTargets },
    );
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  } catch (error) {
    console.error("[Restart] Could not start operation:", error);
    window.showNotification(
      `Could not restart ${isAll ? "MCP servers" : serverName}: ${error.message || "Unknown error"}`,
      "error",
    );
  }
}

async function confirmRestartLegacy() {
  const serverId = pendingRestartServerId;
  const serverName = pendingRestartServerName;
  const isAll = pendingRestartIsAll;

  hideRestartConfirmationModal();

  if (isAll) {
    // Restart all servers
    try {
      const state = window.appState;
      const restartTargets = state.servers.filter((server) =>
        isServerEnabled(server, state),
      );
      startMcpOperationTracker(
        "restart",
        "Restarting MCP servers",
        restartTargets,
        true,
      );
      restartTargets.forEach((server) => {
        setPendingServerOperation(server.id, {
          serverId: server.id,
          label: server.display_name || server.name || server.id,
          targetEnabled: true,
          stage: "restarting",
          detail: "Restarting runtime...",
        });
        updateMcpOperationTracker(server.id, {
          stage: "restarting",
          detail: "Restarting runtime...",
        });
      });

      const result = await window.electronAPI.apiRestartAllMcpServers();

      if (result.success) {
        if (window.checkHostModeSupport) {
          await window.checkHostModeSupport();
        }
        if (window.updateMcpServersList) {
          window.updateMcpServersList();
        }
        const count = result.restarted ? result.restarted.length : 0;
        window.showNotification(
          `MCP servers restarted: ${count} container(s)`,
          "success",
        );
        console.log("[Restart] Restarted containers:", result.restarted);

        // Refresh health and tools for all restarted servers immediately
        if (result.restarted && result.restarted.length > 0) {
          await Promise.all(
            result.restarted.map(async (id) => {
              const target = restartTargets.find((server) => server.id === id);
              handleSuccessfulServerEnable(
                id,
                target?.display_name || target?.name || id,
              );
              await refreshServerAfterOperation(id, {
                maxWait: POST_OPERATION_MAX_WAIT_MS,
                onProgress: (progress) => {
                  updateMcpOperationTracker(id, progress);
                },
              });
            }),
          );
        }
      } else {
        restartTargets.forEach((server) => {
          updateMcpOperationTracker(server.id, {
            stage: "failed",
            detail: (result.errors || []).join(", ") || "Restart failed",
          });
        });
        window.showNotification(
          `Restart completed with errors: ${result.errors?.join(", ") || "Unknown error"}`,
          "warning",
        );
        console.error("Restart errors:", result.errors);
      }
    } catch (error) {
      console.error("Failed to call restart IPC:", error);
      const state = window.appState;
      state.servers
        .filter((server) => isServerEnabled(server, state))
        .forEach((server) => {
          updateMcpOperationTracker(server.id, {
            stage: "failed",
            detail: error.message || "Restart failed",
          });
        });
      window.showNotification(
        "Failed to restart MCP servers. Please try restarting all services.",
        "error",
      );
    }
  } else {
    // Restart single server
    try {
      const server =
        window.appState.servers.find((entry) => entry.id === serverId) || {
          id: serverId,
          name: serverName,
          display_name: serverName,
        };
      startMcpOperationTracker(
        "restart",
        `Restarting ${serverName}`,
        [server],
        true,
      );
      setPendingServerOperation(serverId, {
        serverId,
        label: serverName,
        targetEnabled: true,
        stage: "restarting",
        detail: "Restarting runtime...",
      });
      updateMcpOperationTracker(serverId, {
        stage: "restarting",
        detail: "Restarting runtime...",
      });

      const result = await window.electronAPI.apiRestartMcpServers([serverId]);

      if (result.success) {
        if (window.checkHostModeSupport) {
          await window.checkHostModeSupport();
        }
        if (window.updateMcpServersList) {
          window.updateMcpServersList();
        }
        window.showNotification(
          `${serverName} restarted successfully`,
          "success",
        );

        // Refresh health and tools for the restarted server immediately
        handleSuccessfulServerEnable(serverId, serverName);
        await refreshServerAfterOperation(serverId, {
          maxWait: POST_OPERATION_MAX_WAIT_MS,
          onProgress: (progress) => {
            updateMcpOperationTracker(serverId, progress);
          },
        });
      } else {
        const errorMsg = result.errors?.join(", ") || "Unknown error";
        updateMcpOperationTracker(serverId, {
          stage: "failed",
          detail: errorMsg,
        });
        window.showNotification(
          `Failed to restart ${serverName}: ${errorMsg}`,
          "error",
        );
      }
    } catch (error) {
      console.error("Restart error:", error);
      updateMcpOperationTracker(serverId, {
        stage: "failed",
        detail: error.message || "Restart failed",
      });
      window.showNotification(
        `Failed to restart ${serverName}: ${error.message}`,
        "error",
      );
    }
  }
}

// Export restart functions for use in other modules
window.showRestartConfirmationModal = showRestartConfirmationModal;
window.hideRestartConfirmationModal = hideRestartConfirmationModal;

// ===== Re-auth Confirmation Modal Functions =====

function showReauthConfirmationModal(serverId, serverName) {
  pendingReauthServerId = serverId;
  pendingReauthServerName = serverName;

  const modal = document.getElementById("reauth-confirm-modal");
  const titleEl = document.getElementById("reauth-modal-title");
  const serverNameEl = document.getElementById("reauth-server-name");
  const infoTextEl = document.getElementById("reauth-info-text");
  const confirmBtn = document.getElementById("reauth-modal-confirm-btn");
  const cancelBtn = document.getElementById("reauth-modal-cancel-btn");
  const closeBtn = document.getElementById("reauth-modal-close-btn");

  if (titleEl) titleEl.textContent = "Re-authenticate Server";
  if (serverNameEl) serverNameEl.textContent = serverName;
  if (infoTextEl) {
    infoTextEl.textContent =
      "This reopens the sign-in flow while preserving the current authorization until the new sign-in succeeds.";
  }
  if (confirmBtn) {
    confirmBtn.textContent = "Re-auth";
    confirmBtn.onclick = confirmReauth;
  }
  if (cancelBtn) {
    cancelBtn.onclick = hideReauthConfirmationModal;
  }
  if (closeBtn) {
    closeBtn.onclick = hideReauthConfirmationModal;
  }

  if (reauthEscapeHandler) {
    document.removeEventListener("keydown", reauthEscapeHandler);
  }
  reauthEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideReauthConfirmationModal();
    }
  };
  document.addEventListener("keydown", reauthEscapeHandler);

  if (modal) {
    modal.classList.add("visible");
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideReauthConfirmationModal();
      }
    };
  }
}

function hideReauthConfirmationModal() {
  const modal = document.getElementById("reauth-confirm-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  pendingReauthServerId = null;
  pendingReauthServerName = null;
  if (reauthEscapeHandler) {
    document.removeEventListener("keydown", reauthEscapeHandler);
    reauthEscapeHandler = null;
  }
}

async function confirmReauth() {
  const serverId = pendingReauthServerId;
  const serverName = pendingReauthServerName || serverId;

  hideReauthConfirmationModal();

  if (!serverId) {
    return;
  }

  try {
    await runReauthFlowForServer(serverId);
  } catch (error) {
    console.error(`[OAuth Reauth] Failed for ${serverId}:`, error);
    window.showNotification(
      `Failed to re-authenticate ${serverName}: ${error.message}`,
      "error",
    );
  }
}

window.showReauthConfirmationModal = showReauthConfirmationModal;
window.hideReauthConfirmationModal = hideReauthConfirmationModal;

function showResyncConfirmationModal(serverId, serverName) {
  const capability = RESYNCABLE_DATA_SERVERS[serverId];
  if (!capability) {
    return;
  }
  pendingResyncServerId = serverId;
  pendingResyncServerName = serverName;

  const modal = document.getElementById("resync-confirm-modal");
  const titleEl = document.getElementById("resync-modal-title");
  const serverNameEl = document.getElementById("resync-server-name");
  const infoTextEl = document.getElementById("resync-info-text");
  const confirmBtn = document.getElementById("resync-modal-confirm-btn");
  const cancelBtn = document.getElementById("resync-modal-cancel-btn");
  const closeBtn = document.getElementById("resync-modal-close-btn");

  if (titleEl) titleEl.textContent = capability.menuLabel;
  if (serverNameEl) serverNameEl.textContent = serverName;
  if (infoTextEl) {
    infoTextEl.textContent = capability.modalText;
  }
  if (confirmBtn) {
    confirmBtn.textContent = "Re-sync";
    confirmBtn.onclick = confirmResync;
  }
  if (cancelBtn) {
    cancelBtn.onclick = hideResyncConfirmationModal;
  }
  if (closeBtn) {
    closeBtn.onclick = hideResyncConfirmationModal;
  }

  if (resyncEscapeHandler) {
    document.removeEventListener("keydown", resyncEscapeHandler);
  }
  resyncEscapeHandler = (e) => {
    if (e.key === "Escape") {
      hideResyncConfirmationModal();
    }
  };
  document.addEventListener("keydown", resyncEscapeHandler);

  if (modal) {
    modal.classList.add("visible");
    modal.onclick = (e) => {
      if (e.target === modal) {
        hideResyncConfirmationModal();
      }
    };
  }
}

function hideResyncConfirmationModal() {
  const modal = document.getElementById("resync-confirm-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  pendingResyncServerId = null;
  pendingResyncServerName = null;
  if (resyncEscapeHandler) {
    document.removeEventListener("keydown", resyncEscapeHandler);
    resyncEscapeHandler = null;
  }
}

async function confirmResync() {
  const serverId = pendingResyncServerId;
  const serverName = pendingResyncServerName || serverId;

  hideResyncConfirmationModal();

  if (!serverId) {
    return;
  }

  let purgeResult;
  try {
    purgeResult = await window.electronAPI.resyncMcpServerData(serverId);
  } catch (error) {
    purgeResult = { success: false, error: error.message };
  }
  if (!purgeResult?.success) {
    const reason = purgeResult?.error || "Unknown error";
    window.showNotification(
      purgeResult?.errorCode === "MCP_OPERATION_BUSY"
        ? `Another MCP change is still running — try re-syncing ${serverName} once it finishes`
        : `Could not clear ${serverName} data: ${reason}`,
      "error",
    );
    return;
  }

  // The data is gone and a cold re-sync is about to run for minutes, but
  // periodic health sweeps stay paused while the operation holds the
  // mutation lease — without this local flip the card keeps rendering the
  // stale pre-purge "Running · N tools" snapshot for the whole rebuild
  // (observed live: 10 minutes of "Running" beside a 503 /health). The
  // next real sweep after the operation replaces this local state.
  markMcpServerPostSuccessStarting(serverId, {
    label: serverName,
    stage: "waiting",
    detail: "Re-syncing data...",
  });

  const state = window.appState;
  const server = state?.servers?.find((entry) => entry.id === serverId) || {
    id: serverId,
    name: serverName,
    display_name: serverName,
  };

  const controller = window.McpOperationOverlayController;
  if (!controller?.isSupported?.()) {
    try {
      await window.electronAPI.apiRestartMcpServers([serverId]);
    } catch (error) {
      window.showNotification(
        `Cleared ${serverName} data, but the restart failed: ${error.message}`,
        "error",
      );
    }
    return;
  }

  try {
    await controller.startOperation(
      createMcpOperationRequest("restart", [server], {
        targetEnabled: true,
        metadata: { scope: "single", source: "slack-data-resync" },
      }),
      { servers: [server] },
    );
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();
  } catch (error) {
    console.error("[Resync] Could not start restart operation:", error);
    window.showNotification(
      `Cleared ${serverName} data, but could not start the rebuild: ${error.message || "Unknown error"}`,
      "error",
    );
  }
}

window.showResyncConfirmationModal = showResyncConfirmationModal;
window.hideResyncConfirmationModal = hideResyncConfirmationModal;
window.confirmResync = confirmResync;

// Initialize search and filter functionality
function initMcpSearchFilter() {
  // Only initialize once - use event delegation
  if (mcpSearchFilterInitialized) {
    console.log("[MCP] Search/filter already initialized");
    return;
  }

  console.log("[MCP] Initializing search and filter...");

  // Use event delegation on the parent container for filter tabs
  const filterTabsContainer = document.querySelector(".mcp-filter-tabs");
  if (filterTabsContainer) {
    filterTabsContainer.addEventListener("click", (e) => {
      const tab = e.target.closest(".mcp-filter-tab");
      if (tab) {
        console.log("[MCP] Filter tab clicked:", tab.dataset.filter);
        document
          .querySelectorAll(".mcp-filter-tab")
          .forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        mcpActiveFilter = tab.dataset.filter;
        filterAndRenderMcpServers();
      }
    });
    console.log("[MCP] Filter tabs listener attached");
  } else {
    console.warn("[MCP] Filter tabs container not found");
  }

  // Bind search input directly
  const searchInput = document.getElementById("mcp-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      console.log("[MCP] Search input changed:", e.target.value);
      mcpSearchQuery = e.target.value.toLowerCase();
      filterAndRenderMcpServers();
    });
    console.log("[MCP] Search input listener attached");
  } else {
    console.warn("[MCP] Search input not found");
  }

  mcpSearchFilterInitialized = true;
  console.log("[MCP] Search/filter initialization complete");
}

function getFilteredMcpServerGridEntries(entries) {
  return entries.filter((entry) => {
    const server = entry.server;
    const name = (server.display_name || server.name).toLowerCase();
    if (mcpSearchQuery && !name.includes(mcpSearchQuery)) return false;

    switch (mcpActiveFilter) {
      case "enabled":
        return entry.enabled;
      case "disabled":
        return !entry.enabled;
      case "attention":
        return (
          Boolean(entry.setupAction) ||
          (["failed", "needs_oauth", "timeout", "not_running"].includes(
            entry.healthStatus,
          ) &&
            entry.enabled)
        );
      default:
        return true;
    }
  });
}

// Filter servers based on search query and active filter
function getFilteredServers(servers) {
  const state = window.appState;
  return getFilteredMcpServerGridEntries(
    servers.map((server) => buildMcpServerGridEntry(server, state)),
  ).map((entry) => entry.server);
}

// Re-render after filter change
function filterAndRenderMcpServers() {
  updateMcpServersList();
}

// Dropdown menu functions
function toggleServerDropdown(serverId, event) {
  event.stopPropagation();
  const dropdown = document.querySelector(`[data-dropdown-id="${serverId}"]`);
  const wasOpen = dropdown?.classList.contains("visible");

  closeAllDropdowns();
  if (!wasOpen && dropdown) {
    dropdown.classList.add("visible");
    openDropdownId = serverId;
  }
}

function closeAllDropdowns() {
  document.querySelectorAll(".mcp-card-dropdown.visible").forEach((d) => {
    d.classList.remove("visible");
    // Move dropdown back to its original parent if it was moved to body
    const originalParent = d._originalParent;
    if (originalParent && d.parentElement === document.body) {
      originalParent.appendChild(d);
    }
    // Stale fixed coords on the hidden box get re-based into the card by
    // hover transforms and widen the scroll host.
    d.style.top = "";
    d.style.left = "";
  });
  openDropdownId = null;
}

function isServerEnabled(server, state) {
  if (!server) return false;
  if (server.isCore) return true;
  if (!isServerConfiguredForUi(server, state)) return false;

  const isHostDisabled = isHostModeMissingSetup(server, state);
  if (isHostDisabled) return false;

  const backendInfo = state?.healthStatus?.servers?.[server.id] || null;
  const backendStatus = backendInfo?.status;
  const progressApi = getMcpOperationProgressApi();
  const pendingOperation = getPendingServerOperation(server.id);
  if (pendingOperation?.targetEnabled === false) {
    return false;
  }
  if (pendingOperation?.targetEnabled === true) {
    return true;
  }
  if (hasStartupFailureState(backendStatus, backendInfo, server.id)) {
    return true;
  }
  if (
    backendInfo?.disabled_by_user === true ||
    String(backendStatus || "").toLowerCase() === "disabled"
  ) {
    return false;
  }
  const hasStructuredStartupFailure =
    backendInfo?.startup_failure &&
    typeof backendInfo.startup_failure === "object";
  if (state.toggles?.[server.id] === false && !hasStructuredStartupFailure) {
    return false;
  }
  if (progressApi) {
    return progressApi.resolveEffectiveEnabled({
      isCore: server.isCore,
      backendStatus,
      toggleEnabled: state.toggles?.[server.id] === true,
      pendingOperation,
    });
  }

  if (backendStatus === "disabled") {
    return false;
  }

  if (backendStatus && backendStatus !== "not_configured" && backendStatus !== "unknown") {
    if (state.toggles?.[server.id] !== true) {
      window.__mcpToggleHealthMismatchLogged = window.__mcpToggleHealthMismatchLogged || new Set();
      const key = `${server.id}:${backendStatus}`;
      if (!window.__mcpToggleHealthMismatchLogged.has(key)) {
        window.__mcpToggleHealthMismatchLogged.add(key);
        console.warn(
          `[MCP] Reconciling enabled state from health for ${server.id} (toggle=${state.toggles?.[server.id]}, health=${backendStatus})`,
        );
      }
    }
    return true;
  }

  return state.toggles?.[server.id] === true;
}

function isHostModeMissingSetup(server, state) {
  const deploymentType = server?.deploymentType || "docker";
  return deploymentType === "host" && !state?.hostModeSupported;
}

function isMacPlatform() {
  const platform = String(navigator?.platform || "").toLowerCase();
  return platform.includes("mac");
}

function isSelectionModifierPressed(event) {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function isServerConfiguredForUi(server, state) {
  if (!server) return false;
  if (resolveServerSetupAction(server) === "configure") {
    return false;
  }
  const healthInfo = state?.healthStatus?.servers?.[server.id];
  const backendStatus = normalizeBackendHealthStatusForUi(healthInfo);
  const progressApi = getMcpOperationProgressApi();
  if (progressApi?.resolveEffectiveConfigured) {
    return progressApi.resolveEffectiveConfigured({
      serverConfigured: Boolean(server.isConfigured),
      backendConfigured: healthInfo?.configured,
      backendStatus,
      backendError: getDisplayHealthError(backendStatus, healthInfo),
      pendingOperation: getPendingServerOperation(server.id),
      expectsOAuth: serverExpectsOAuth(server, healthInfo),
      allowNotConfiguredOverride: Boolean(server?.isConfigured),
    });
  }
  if (typeof healthInfo?.configured === "boolean") {
    return healthInfo.configured;
  }
  if (backendStatus && backendStatus !== "not_configured") {
    return true;
  }
  return Boolean(server.isConfigured);
}

function isServerToggleable(server, state) {
  if (!server || !isServerConfiguredForUi(server, state) || server.isCore) {
    return false;
  }
  if (isHostModeMissingSetup(server, state)) {
    return false;
  }
  return true;
}

function isServerBulkSelectable(server, state) {
  if (!server || server.isCore) {
    return false;
  }
  if (isHostModeMissingSetup(server, state)) {
    return false;
  }
  return true;
}

function isServerDesiredEnabled(server, state) {
  if (!server) return false;
  if (server.isCore) return true;
  const pendingOperation = getPendingServerOperation(server.id);
  if (pendingOperation) {
    return pendingOperation.targetEnabled !== false;
  }
  return state?.toggles?.[server.id] === true;
}

function isServerBulkEnableTarget(server, state) {
  return isServerBulkSelectable(server, state) && !isServerEnabled(server, state);
}

function isServerBulkDisableTarget(server, state) {
  return isServerBulkSelectable(server, state) && isServerEnabled(server, state);
}

function getSelectedServers(state) {
  const selectedServers = [];
  for (const serverId of selectedServerIds) {
    const server = state.servers.find((s) => s.id === serverId);
    if (server && isServerBulkSelectable(server, state)) {
      selectedServers.push(server);
    }
  }
  return selectedServers;
}

function getSelectedServersForAction(state, enabled) {
  const predicate = enabled ? isServerBulkEnableTarget : isServerBulkDisableTarget;
  return getSelectedServers(state).filter((server) => predicate(server, state));
}

function getVisibleSelectableServers(state) {
  if (!state?.servers?.length) {
    return [];
  }

  return getFilteredServers(state.servers).filter((server) =>
    isServerBulkSelectable(server, state),
  );
}

function syncSelectedServersWithVisible(visibleServers, state) {
  const visibleIds = new Set(
    visibleServers
      .filter((server) => isServerBulkSelectable(server, state))
      .map((server) => server.id),
  );
  for (const serverId of Array.from(selectedServerIds)) {
    if (!visibleIds.has(serverId)) {
      selectedServerIds.delete(serverId);
    }
  }
}

function updateBulkSelectionUI() {
  const state = window.appState;
  if (!state) return;

  const enableBtn = document.getElementById("enable-selected-btn");
  const disableBtn = document.getElementById("disable-selected-btn");
  const selectAllBtn = document.getElementById("toggle-select-all-servers-btn");
  const list = document.getElementById("mcp-servers-list");

  const selectedServers = getSelectedServers(state);
  const visibleSelectableServers = getVisibleSelectableServers(state);
  const allVisibleSelected =
    visibleSelectableServers.length > 0 &&
    visibleSelectableServers.every((server) => selectedServerIds.has(server.id));
  const enableTargets = selectedServers.filter((server) =>
    isServerBulkEnableTarget(server, state),
  );
  const disableTargets = selectedServers.filter((server) =>
    isServerBulkDisableTarget(server, state),
  );
  const shouldShowBulkActions = selectedServers.length > 0;

  if (enableBtn) {
    enableBtn.classList.toggle("is-hidden", !shouldShowBulkActions);
    enableBtn.disabled = enableTargets.length === 0;
  }
  if (disableBtn) {
    disableBtn.classList.toggle("is-hidden", !shouldShowBulkActions);
    disableBtn.disabled = disableTargets.length === 0;
  }
  if (selectAllBtn) {
    const hasVisibleSelectableServers = visibleSelectableServers.length > 0;
    selectAllBtn.classList.toggle("is-hidden", !hasVisibleSelectableServers);
    selectAllBtn.textContent = allVisibleSelected ? "Deselect all" : "Select all";
    selectAllBtn.title = allVisibleSelected
      ? "Clear the current MCP server bulk selection"
      : "Select all visible MCP servers eligible for bulk actions";
    selectAllBtn.setAttribute("aria-pressed", allVisibleSelected ? "true" : "false");
  }

  if (list) {
    list.querySelectorAll(".mcp-server-card").forEach((card) => {
      const serverId = card.dataset.serverId;
      card.classList.toggle("selected-state", selectedServerIds.has(serverId));
    });
  }
}

function clearBulkSelection() {
  selectedServerIds.clear();
  updateBulkSelectionUI();
}

function initBulkSelectionButtons() {
  if (bulkSelectionButtonsInitialized) return;

  const enableBtn = document.getElementById("enable-selected-btn");
  const disableBtn = document.getElementById("disable-selected-btn");
  const selectAllBtn = document.getElementById("toggle-select-all-servers-btn");
  if (!enableBtn || !disableBtn || !selectAllBtn) return;

  enableBtn.addEventListener("click", () => {
    const state = window.appState;
    const targets = getSelectedServersForAction(state, true);
    if (targets.length === 0) return;
    showBulkToggleConfirmationModal(targets, true);
  });

  disableBtn.addEventListener("click", () => {
    const state = window.appState;
    const targets = getSelectedServersForAction(state, false);
    if (targets.length === 0) return;
    showBulkToggleConfirmationModal(targets, false);
  });

  selectAllBtn.addEventListener("click", () => {
    const state = window.appState;
    const visibleSelectableServers = getVisibleSelectableServers(state);
    if (visibleSelectableServers.length === 0) {
      return;
    }

    const allVisibleSelected = visibleSelectableServers.every((server) =>
      selectedServerIds.has(server.id),
    );

    if (allVisibleSelected) {
      clearBulkSelection();
      return;
    }

    visibleSelectableServers.forEach((server) => {
      selectedServerIds.add(server.id);
    });
    updateBulkSelectionUI();
  });

  bulkSelectionButtonsInitialized = true;
}

// Close dropdowns on outside click or Escape
document.addEventListener("click", closeAllDropdowns);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllDropdowns();
});

// NOTE: openMcpDebugger is defined in chat-tab.js and exported to window
// Do NOT define a stub here

function openServiceLogsPanel(service) {
  console.log(`Opening logs panel for service: ${service}`);
  // This would open the logs panel - handled by logs-panel.js if present
  if (
    window.openServiceLogsPanel &&
    window.openServiceLogsPanel !== openServiceLogsPanel
  ) {
    window.openServiceLogsPanel(service);
  }
}

// NOTE: runOAuthFlowForSingleServer is provided by oauth-modal-shared.js
// which is loaded before this script in index.html

async function showServerLogs(serverId, deploymentType, isCore = false) {
  const healthStatus = getServerHealthStatus(serverId);
  const healthInfo = getServerHealthInfo(serverId);
  if (
    hasStartupFailureState(healthStatus, healthInfo, serverId) &&
    isConfigStartupFailure(healthInfo, serverId)
  ) {
    showStartupFailureModal(serverId);
    return;
  }

  openServerLogViewer(serverId, deploymentType, isCore);
}

function openServerLogViewer(serverId, deploymentType, isCore = false) {
  // Determine which service to show logs for
  let service;
  const server = window.appState?.servers?.find((s) => s.id === serverId);
  if (isCore) {
    service = server?.runtimeContainerName || `mcpo-core-${serverId}`;
  } else if (deploymentType === "host") {
    service = "host-mcpo";
  } else {
    // Per-server MCP runtime containers use the format mcpo-{serverId}
    service = server?.runtimeContainerName || `mcpo-${serverId}`;
  }

  // Use the new log viewer modal
  if (window.openLogViewerModal) {
    // Find server info for display
    const logProvider = window.electronAPI?.getSingleMcpServerLogs
      ? () => window.electronAPI.getSingleMcpServerLogs(serverId, 500)
      : null;
    window.openLogViewerModal(serverId, service, {
      name: server?.display_name || server?.name,
      icon: server?.icon,
      server: server,
      logProvider,
    });
  } else {
    console.error("openLogViewerModal is not available");
  }
}

let startupFailureModalInitialized = false;
let startupFailureModalDetails = "";
let startupFailureModalServerId = null;

function buildStartupFailureDetails(serverId) {
  const state = window.appState || {};
  const server = state.servers?.find((entry) => entry.id === serverId) || null;
  const healthInfo = state.healthStatus?.servers?.[serverId] || {};
  const failure = getStartupFailureInfo(healthInfo, serverId) || {
    serverId,
    operation: "enable",
    stage: healthInfo.status || "startup",
    error: healthInfo.error || "Startup failed",
    source: "runtime",
    deploymentType: healthInfo.deployment || server?.deploymentType,
  };
  const displayName = server?.display_name || server?.name || serverId;
  return {
    serverId,
    displayName,
    failure: {
      ...failure,
      serverId: failure.serverId || serverId,
      deploymentType:
        failure.deploymentType ||
        healthInfo.deployment ||
        server?.deploymentType ||
        "docker",
      error: failure.error || healthInfo.error || "Startup failed",
    },
  };
}

function formatStartupFailureDetails(details) {
  const failure = details.failure || {};
  const rows = [
    `Server: ${details.displayName} (${details.serverId})`,
    `Operation: ${failure.operation || "enable"}`,
    `Stage: ${failure.stage || "startup"}`,
    `Source: ${failure.source || "runtime"}`,
    `Deployment: ${failure.deploymentType || "unknown"}`,
  ];
  if (failure.containerName) {
    rows.push(`Container: ${failure.containerName}`);
  }
  if (failure.configPath) {
    rows.push(`Config path: ${failure.configPath}`);
  }
  if (failure.timestamp) {
    rows.push(`Time: ${failure.timestamp}`);
  }
  rows.push("", "Error:", failure.error || "Startup failed");
  return rows.join("\n");
}

function hideStartupFailureModal() {
  const modal = document.getElementById("startup-failure-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
}

function initializeStartupFailureModal() {
  if (startupFailureModalInitialized) {
    return;
  }
  startupFailureModalInitialized = true;

  const modal = document.getElementById("startup-failure-modal");
  const closeBtn = document.getElementById("startup-failure-close-btn");
  const copyBtn = document.getElementById("startup-failure-copy-btn");
  const logsBtn = document.getElementById("startup-failure-logs-btn");

  if (closeBtn) {
    closeBtn.addEventListener("click", hideStartupFailureModal);
  }
  if (logsBtn) {
    logsBtn.addEventListener("click", () => {
      const serverId = startupFailureModalServerId;
      if (!serverId) {
        return;
      }
      const server = window.appState?.servers?.find((s) => s.id === serverId);
      hideStartupFailureModal();
      openServerLogViewer(
        serverId,
        server?.deploymentType || "docker",
        Boolean(server?.isCore),
      );
    });
  }
  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        hideStartupFailureModal();
      }
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const originalHTML = copyBtn.innerHTML;
      try {
        if (window.electronAPI?.copyToClipboard) {
          await window.electronAPI.copyToClipboard(startupFailureModalDetails);
        } else {
          await navigator.clipboard.writeText(startupFailureModalDetails);
        }
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
        if (window.showNotification) {
          window.showNotification("Startup failure details copied", "success");
        }
      } catch (error) {
        console.error("[Startup Failure] Could not copy details:", error);
        if (window.showNotification) {
          window.showNotification("Could not copy startup failure details", "error");
        }
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideStartupFailureModal();
    }
  });
}

function showStartupFailureModal(serverId) {
  initializeStartupFailureModal();
  const modal = document.getElementById("startup-failure-modal");
  if (!modal) {
    console.error("[Startup Failure] Modal is not available");
    return;
  }

  const details = buildStartupFailureDetails(serverId);
  const failure = details.failure;
  startupFailureModalDetails = formatStartupFailureDetails(details);
  startupFailureModalServerId = serverId;

  const title = document.getElementById("startup-failure-title");
  const subtitle = document.getElementById("startup-failure-subtitle");
  const serverIdEl = document.getElementById("startup-failure-server-id");
  const stageEl = document.getElementById("startup-failure-stage");
  const sourceEl = document.getElementById("startup-failure-source");
  const configPathEl = document.getElementById("startup-failure-config-path");
  const errorEl = document.getElementById("startup-failure-error");

  if (title) {
    title.textContent = "Startup Failure";
  }
  if (subtitle) {
    subtitle.textContent = details.displayName;
  }
  if (serverIdEl) {
    serverIdEl.textContent = details.serverId;
  }
  if (stageEl) {
    stageEl.textContent = failure.stage || "startup";
  }
  if (sourceEl) {
    sourceEl.textContent = failure.source || "runtime";
  }
  if (configPathEl) {
    configPathEl.textContent = failure.configPath || "Not available";
  }
  if (errorEl) {
    errorEl.textContent = failure.error || "Startup failed";
  }

  modal.classList.add("visible");
}

window.showStartupFailureModal = showStartupFailureModal;

/**
 * Find all servers that need OAuth authorization
 * @param {Object} options
 * @returns {Array<Object>} Array of server objects needing OAuth
 */
function findAllServersNeedingOAuth(options = {}) {
  const state = window.appState || {};
  const servers = [];
  const requestedServerId = String(options.requestedServerId || "").trim();
  const healthServers = state.healthStatus?.servers || {};
  const candidateServerIds = new Set([
    ...(state.servers || []).map((server) => server?.id).filter(Boolean),
    ...Object.keys(healthServers),
  ]);

  for (const serverId of candidateServerIds) {
    const serverConfig = state.servers?.find((s) => s.id === serverId);
    if (!serverConfig) {
      continue;
    }

    const healthInfo = healthServers[serverId] || {};
    const healthStatus = healthInfo?.status || "unknown";
    const backendNeedsAuth = shouldShowNeedsAuth(healthStatus, healthInfo);
    const metadataRequiresOAuth = serverRequiresOAuth(serverConfig);
    if (!metadataRequiresOAuth && !backendNeedsAuth) {
      continue;
    }

    const setupAction = resolveServerSetupAction(serverConfig);
    const isRequestedServer = serverId === requestedServerId;
    const needsAuthByMetadata =
      setupAction === "authenticate" &&
      (isRequestedServer || isServerEnabled(serverConfig, state));
    if (!backendNeedsAuth && !needsAuthByMetadata) {
      continue;
    }

    const actionableOauthStates = ["active", "waiting_callback"];
    const oauthState = healthInfo?.oauth_state || "unknown";
    const errorMessage = healthInfo?.error || null;
    let reason = "unknown";
    if (healthStatus === "needs_oauth") {
      reason = "status_needs_oauth";
    } else if (
      actionableOauthStates.includes(oauthState) &&
      hasAuthorizationUrlAvailable(healthInfo)
    ) {
      reason = `oauth_state_${oauthState}`;
    }

    console.log(
      `[OAuth] ${serverId} needs auth (reason=${reason}, status=${healthStatus}, oauth_state=${oauthState}, error=${errorMessage || "none"})`,
    );

    // This list represents servers that currently need OAuth per control-plane logic.
    // Keep forceAuth true so the OAuth modal does not short-circuit on token files
    // and can always run a re-auth flow when explicitly invoked.
    const forceAuth = true;

    servers.push({
      id: serverId,
      server_name: serverId,
      name: serverConfig?.name || serverId,
      display_name: serverConfig?.display_name || serverConfig?.name || serverId,
      description: serverConfig?.description,
      icon: serverConfig?.icon,
      forceAuth,
      health_status: healthStatus,
      oauth_state: healthInfo?.oauth_state || null,
      health_error: errorMessage,
      configurationPending:
        serverRequiresConfig(serverConfig) &&
        serverConfig.isConfigured !== true,
    });
  }

  console.log(`[OAuth] Found ${servers.length} server(s) needing OAuth:`, servers.map(s => s.id));
  return servers;
}

function buildServerForReauth(serverId) {
  const state = window.appState || {};
  const server = state.servers?.find((entry) => entry.id === serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const healthInfo = getServerHealthInfo(serverId) || {};
  return {
    ...server,
    id: server.id,
    server_name: server.id,
    name: server.name || server.id,
    display_name: server.display_name || server.name || server.id,
    description: server.description,
    icon: server.icon,
    forceAuth: true,
    health_status: healthInfo.status || null,
    oauth_state: healthInfo.oauth_state || null,
    health_error: healthInfo.error || null,
    configurationPending:
      serverRequiresConfig(server) && server.isConfigured !== true,
  };
}

function markCompletedOAuthServersAuthenticated(result = {}) {
  const completedServerIds = Array.isArray(result.completedServerIds)
    ? result.completedServerIds
    : [];
  for (const completedServerId of completedServerIds) {
    const server = window.appState?.servers?.find(
      (entry) => entry?.id === completedServerId,
    );
    if (!server) {
      continue;
    }
    markMcpServerOAuthAuthenticated(completedServerId, {
      configurationPending:
        serverRequiresConfig(server) && server.isConfigured !== true,
    });
  }
}

async function runReauthFlowForServer(serverId) {
  const serverForReauth = buildServerForReauth(serverId);
  const serverName =
    serverForReauth.display_name || serverForReauth.name || serverId;

  if (window.runOAuthWizard) {
    const result = await window.runOAuthWizard([serverForReauth], {
      preferredServerId: serverId,
      forceAuthServerIds: [serverId],
      flowSource: "manual",
    });
    markCompletedOAuthServersAuthenticated(result);

    if (result.completedCount > 0) {
      window.showNotification(
        `${serverName} re-authenticated successfully!`,
        "success",
      );
      if (window.updateMcpServersList) {
        setTimeout(() => window.updateMcpServersList(), 1000);
      }
    } else if (!result.skipped) {
      window.showNotification(
        `Re-authentication was not completed for ${serverName}`,
        "warning",
      );
    }

    return result;
  }

  const result = await runOAuthFlowForSingleServer(
    serverId,
    (msg) => console.log(`[OAuth Reauth] ${msg}`),
  );

  if (result.completed) {
    window.showNotification(
      `${serverName} re-authenticated successfully!`,
      "success",
    );
    if (window.updateMcpServersList) {
      setTimeout(() => window.updateMcpServersList(), 1000);
    }
  } else {
    window.showNotification(
      `Re-authentication was not completed for ${serverName}`,
      "warning",
    );
  }

  return {
    completedCount: result.completed ? 1 : 0,
    completedServerIds: result.completed ? [serverId] : [],
    skipped: Boolean(result.skipped),
  };
}

async function runOAuthFlowForServer(serverId, options = {}) {
  const flowSource =
    options.flowSource === "backend-requested" ? "backend-requested" : "manual";
  const forceAuth = Boolean(options.forceAuth);
  const resumeExisting = Boolean(options.resumeExisting);
  const showNotifications =
    options.showNotifications !== undefined
      ? Boolean(options.showNotifications)
      : flowSource === "manual";

  try {
    console.log(
      `[OAuth] Starting ${flowSource} OAuth flow triggered by ${serverId}`,
    );

    // Find ALL servers that need OAuth, not just the clicked one.
    // Forced re-auth is targeted to the requested server even if current
    // health state still incorrectly says tool_ready.
    const allServersNeedingOAuth = forceAuth
      ? [buildServerForReauth(serverId)]
      : findAllServersNeedingOAuth({ requestedServerId: serverId });

    if (allServersNeedingOAuth.length === 0) {
      console.log("[OAuth] No servers found needing OAuth");
      if (showNotifications) {
        window.showNotification("No servers need OAuth authorization", "info");
      }
      return { completedCount: 0, completedServerIds: [], skipped: false };
    }

    // Use the new OAuth wizard with full step-by-step progress
    // The wizard uses the single server stack (dynamic host port) for isolation
    // and starts prod recovery in the background after authorization
    if (window.runOAuthWizard) {
      const result = await window.runOAuthWizard(allServersNeedingOAuth, {
        preferredServerId: serverId,
        forceAuthAll: !forceAuth,
        forceAuthServerIds: forceAuth ? [serverId] : [],
        flowSource,
        resumeExisting,
        requestedServerId:
          flowSource === "backend-requested"
            ? options.requestedServerId || serverId
            : undefined,
        backendManagedServerIds:
          flowSource === "backend-requested"
            ? [options.requestedServerId || serverId]
            : [],
      });
      markCompletedOAuthServersAuthenticated(result);

      if (result.completedCount > 0 && showNotifications) {
        window.showNotification(
          `${result.completedCount} server(s) authorized successfully!`,
          "success",
        );

        // Refresh the server list to show updated status
        if (window.updateMcpServersList) {
          setTimeout(() => window.updateMcpServersList(), 1000);
        }
      } else if (!result.skipped && !result.reusedExistingFlow && showNotifications) {
        window.showNotification(
          "OAuth authorization was not completed",
          "warning",
        );
      }
      return result;
    } else {
      // Fallback to old modal if wizard not loaded
      console.warn("[OAuth] OAuth wizard not available, using fallback");
      const result = await runOAuthFlowForSingleServer(serverId, (msg) => {
        console.log(`[OAuth] ${msg}`);
      }, {
        backendManagedFinalization: flowSource === "backend-requested",
        resumeExisting,
        requestedServerId:
          flowSource === "backend-requested"
            ? options.requestedServerId || serverId
            : undefined,
      });

      if (result.completed) {
        const server = window.appState?.servers?.find(
          (entry) => entry?.id === serverId,
        );
        const configurationPending =
          serverRequiresConfig(server) && server?.isConfigured !== true;
        markMcpServerOAuthAuthenticated(serverId, { configurationPending });

        if (configurationPending) {
          if (showNotifications) {
            window.showNotification(
              `${serverId} authorized; configuration required`,
              "success",
            );
          }
        } else {
          if (showNotifications) {
            window.showNotification(
              `${serverId} authorized successfully! Restarting MCP servers...`,
              "success",
            );
          }

          // Call MCP restart endpoint only when no configuration remains.
          window.showLoading("Restarting MCP servers...");
          try {
            const response = await fetch(`${LOCAL_API_BASE_URL}/api/restart-mcp`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });

            if (response.ok && showNotifications) {
              window.showNotification(
                `${serverId} authorized and servers restarted!`,
                "success",
              );
            }
          } catch (error) {
            console.error("[OAuth] Fallback restart failed:", error);
          } finally {
            window.hideLoading();
          }
        }
      } else if (!result.skipped && showNotifications) {
        window.showNotification(
          `${serverId} authorization ${result.error || "failed"}`,
          "error",
        );
      }
      return {
        completedCount: result.completed ? 1 : 0,
        completedServerIds: result.completed ? [serverId] : [],
        skipped: Boolean(result.skipped),
      };
    }
  } catch (error) {
    console.error("OAuth flow error:", error);
    if (showNotifications) {
      window.showNotification(`OAuth error: ${error.message}`, "error");
    }
    throw error;
  }
}

function getServerHealthStatus(serverName) {
  const state = window.appState;
  const server = state.servers?.find((entry) => entry.id === serverName) || null;
  const backendInfo = state.healthStatus?.servers?.[serverName] || null;
  const backendStatus = normalizeBackendHealthStatusForUi(backendInfo);
  const progressApi = getMcpOperationProgressApi();
  const pendingOperation = getPendingServerOperation(serverName);
  if (progressApi) {
    return progressApi.resolveEffectiveHealthStatus(
      backendStatus,
      pendingOperation,
      {
        backendError: getDisplayHealthError(backendStatus, backendInfo),
        expectsOAuth: serverExpectsOAuth(server, backendInfo),
        allowNotConfiguredOverride: Boolean(server?.isConfigured),
      },
    );
  }
  return backendStatus;
}

// Get full health info object for a server (includes oauth_state, error, etc.)
function getServerHealthInfo(serverName) {
  const state = window.appState;
  const server = state.servers?.find((entry) => entry.id === serverName) || null;
  const serverHealth = state.healthStatus?.servers?.[serverName] || null;
  const normalizedStatus = normalizeBackendHealthStatusForUi(serverHealth);
  const normalizedError = getDisplayHealthError(normalizedStatus, serverHealth);
  const pendingOperation = getPendingServerOperation(serverName);
  const progressApi = getMcpOperationProgressApi();
  if (progressApi && pendingOperation) {
    const prefersPendingState =
      pendingOperation.targetEnabled === false ||
      progressApi.shouldPreferPendingStateForEnableBackendStatus(
        normalizedStatus,
        pendingOperation,
        {
          backendError: normalizedError,
          expectsOAuth: serverExpectsOAuth(server, serverHealth),
          allowNotConfiguredOverride: Boolean(server?.isConfigured),
        },
      );
    const resolvedStatus = progressApi.resolveEffectiveHealthStatus(
      normalizedStatus,
      pendingOperation,
      {
        backendError: normalizedError,
        expectsOAuth: serverExpectsOAuth(server, serverHealth),
        allowNotConfiguredOverride: Boolean(server?.isConfigured),
      },
    );
    return {
      ...(serverHealth || {}),
      status: resolvedStatus,
      error:
        resolvedStatus === "needs_oauth"
          ? getDisplayHealthError(resolvedStatus, serverHealth)
          : prefersPendingState
            ? pendingOperation.detail || normalizedError
            : normalizedError,
    };
  }
  if (!serverHealth) {
    return serverHealth;
  }
  return {
    ...serverHealth,
    status: normalizedStatus,
    error: normalizedError,
  };
}

function getServersWithEffectiveHealth(state = window.appState) {
  const serversById = new Map(
    (state?.servers || [])
      .filter((server) => server && server.id)
      .map((server) => [server.id, server]),
  );
  const allServerIds = new Set([
    ...serversById.keys(),
    ...Object.keys(state?.pendingServerOperations || {}).filter((serverId) =>
      serversById.has(serverId),
    ),
  ]);

  return [...allServerIds]
    .map((serverId) => {
      const server = serversById.get(serverId) || null;
      const info = getServerHealthInfo(serverId) || {
        status: getServerHealthStatus(serverId),
      };
      return { name: serverId, info, server };
    })
    .filter(({ server, info }) => {
      if (server && isServerConfiguredForUi(server, state)) {
        return true;
      }
      return false;
    });
}

async function fetchServerReadiness(serverId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POST_OPERATION_READINESS_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${LOCAL_API_BASE_URL}/api/server-readiness/${encodeURIComponent(serverId)}`,
      { signal: controller.signal },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchServerReadinessBulk(serverIds) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    BULK_READINESS_RECONCILE_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${LOCAL_API_BASE_URL}/api/server-readiness/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_ids: serverIds }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function getLaggingReadinessServerIds(state = window.appState) {
  const laggingIds = new Set(
    state?.healthStatus?.sync_diagnostics?.lagging_server_ids || [],
  );
  if (laggingIds.size === 0) {
    return [];
  }

  return (state?.servers || [])
    .filter((server) => server?.id && laggingIds.has(server.id))
    .filter((server) => isServerEnabled(server, state))
    .filter((server) => {
      const status = getServerHealthStatus(server.id);
      return status === "starting" || status === "checking";
    })
    .map((server) => server.id)
    .sort();
}

async function refreshLaggingServerReadiness(options = {}) {
  const state = window.appState;
  const list = document.getElementById("mcp-servers-list");
  const visible =
    options.force === true ||
    (list && state.activeTab === "control" && state.controlPlaneView === "mcp-servers");
  if (!visible || readinessBulkReconcileInProgress) {
    return;
  }

  const serverIds = getLaggingReadinessServerIds(state);
  if (serverIds.length === 0) {
    return;
  }

  const signature = serverIds.join(",");
  const now = Date.now();
  if (
    signature === readinessBulkReconcileLastSignature &&
    now - readinessBulkReconcileLastAt < BULK_READINESS_RECONCILE_MIN_INTERVAL_MS
  ) {
    return;
  }

  readinessBulkReconcileInProgress = true;
  readinessBulkReconcileLastSignature = signature;
  readinessBulkReconcileLastAt = now;
  try {
    const bulk = await fetchServerReadinessBulk(serverIds);
    const results = bulk?.results && typeof bulk.results === "object" ? bulk.results : {};
    for (const [serverId, readiness] of Object.entries(results)) {
      applyReadinessToLocalHealthState(serverId, readiness);
    }
    if (window.updateMcpBadgeWithHealth) {
      window.updateMcpBadgeWithHealth();
    }
    if (window.refreshToolsCountForHealthyServers) {
      window.refreshToolsCountForHealthyServers({
        forceRender: true,
        reason: options.reason || "lagging-readiness-reconcile",
      });
    } else if (window.updateMcpServersList) {
      window.updateMcpServersList();
    }
  } catch (error) {
    console.warn(
      `[Readiness] Bulk reconcile failed (${options.reason || "unknown"}):`,
      error,
    );
  } finally {
    readinessBulkReconcileInProgress = false;
  }
}

function getLocalMcpoPortForDeployment(deploymentType = "docker") {
  if (deploymentType === "host") {
    return 8890;
  }
  if (deploymentType === "core") {
    return 8766;
  }
  return 8765;
}

function recalculateLocalHealthSummary(servers = {}) {
  const summary = {
    total: 0,
    healthy: 0,
    needs_oauth: 0,
    timeout: 0,
    failed: 0,
    not_running: 0,
    not_configured: 0,
    starting: 0,
    disabled: 0,
  };

  Object.values(servers).forEach((server) => {
    if (!server || typeof server !== "object") {
      return;
    }

    summary.total += 1;
    const status = server.status || "failed";
    if (status === "checking") {
      summary.starting += 1;
    } else if (Object.hasOwn(summary, status)) {
      summary[status] += 1;
    } else {
      summary.failed += 1;
    }
  });

  return summary;
}

function applyReadinessToLocalHealthState(serverId, readiness) {
  const state = window.appState;
  const healthStatus = ensureLocalHealthStatusSnapshot(state);
  if (!healthStatus?.servers) {
    return;
  }
  const previousInfo = healthStatus.servers[serverId] || {};
  const previousStatus = previousInfo.status || null;
  const previousError = previousInfo.error || null;
  const previousStartupFailure = JSON.stringify(
    previousInfo.startup_failure || null,
  );
  const server = Array.isArray(state?.servers)
    ? state.servers.find((entry) => entry?.id === serverId) || null
    : null;
  if (server) {
    server.isConfigured = true;
  }

  const readinessPhase =
    readiness?.readiness_phase ||
    readiness?.readinessPhase ||
    readiness?.status ||
    "unknown";
  const oauthState = readiness?.oauth_state ?? readiness?.oauthState ?? null;
  let nextStatus = null;
  let nextError = readiness?.error || null;
  let running = false;
  let host = null;
  let port = null;
  let nextOauthState = oauthState;
  let authorizationUrlAvailable = Boolean(
    readiness?.authorization_url_available ??
      readiness?.authorizationUrlAvailable,
  );
  const readinessStartupFailure =
    readiness?.startup_failure || readiness?.startupFailure || null;

  if (readiness?.healthy || readinessPhase === "tool_ready") {
    nextStatus = "healthy";
    nextError = null;
    running = true;
    host = "localhost";
    port = getLocalMcpoPortForDeployment(
      readiness?.deployment_type || readiness?.deploymentType,
    );
    authorizationUrlAvailable = false;
  } else if (
    readinessPhase === "starting" ||
    readinessPhase === "checking_tokens" ||
    readinessPhase === "checking"
  ) {
    nextStatus = "starting";
    nextError = null;
    nextOauthState = null;
    authorizationUrlAvailable = false;
  } else if (
    readinessPhase === "needs_oauth" ||
    readinessPhase === "waiting_callback"
  ) {
    nextStatus = "needs_oauth";
    nextError =
      nextError || "Server configured but waiting for OAuth authorization";
    authorizationUrlAvailable = true;
  } else if (readinessPhase === "failed") {
    nextStatus = "failed";
  } else if (readinessPhase === "timeout") {
    nextStatus = "timeout";
  } else if (readinessPhase === "disabled") {
    nextStatus = "disabled";
    nextError = null;
    authorizationUrlAvailable = false;
  }

  if (!nextStatus) {
    return;
  }

  const nextInfo = {
    ...previousInfo,
    configured: true,
    status: nextStatus,
    error: nextError,
    running,
    host,
    port,
    oauth_state: nextOauthState,
    authorization_url_available: authorizationUrlAvailable,
    authorizationUrlAvailable: authorizationUrlAvailable,
  };
  if (readinessStartupFailure) {
    const startupFailure = {
      ...readinessStartupFailure,
      serverId: readinessStartupFailure.serverId || serverId,
      error: readinessStartupFailure.error || nextError || "Startup failed",
      stage:
        readinessStartupFailure.stage ||
        readiness?.startup_failure_stage ||
        readiness?.startupFailureStage ||
        readinessPhase,
      source:
        readinessStartupFailure.source ||
        readiness?.startup_failure_source ||
        readiness?.startupFailureSource ||
        "runtime",
      timestamp:
        readinessStartupFailure.timestamp ||
        readiness?.startup_failure_timestamp ||
        readiness?.startupFailureTimestamp,
      deploymentType:
        readinessStartupFailure.deploymentType ||
        readinessStartupFailure.deployment_type ||
        readiness?.deployment_type ||
        readiness?.deploymentType,
      containerName:
        readinessStartupFailure.containerName ||
        readinessStartupFailure.container_name ||
        readiness?.container_name ||
        readiness?.containerName,
      configPath:
        readinessStartupFailure.configPath ||
        readinessStartupFailure.config_path ||
        readiness?.config_path ||
        readiness?.configPath,
    };
    nextInfo.startup_failure = startupFailure;
    nextInfo.startup_failure_source = startupFailure.source;
    nextInfo.startup_failure_stage = startupFailure.stage;
    nextInfo.startup_failure_timestamp = startupFailure.timestamp;
    if (startupFailure.containerName) {
      nextInfo.container_name = startupFailure.containerName;
    }
    if (startupFailure.configPath) {
      nextInfo.config_path = startupFailure.configPath;
    }
  } else {
    delete nextInfo.startup_failure;
    delete nextInfo.startup_failure_source;
    delete nextInfo.startup_failure_stage;
    delete nextInfo.startup_failure_timestamp;
    delete nextInfo.config_path;
    delete nextInfo.container_name;
  }

  healthStatus.servers[serverId] = nextInfo;
  healthStatus.summary = recalculateLocalHealthSummary(
    healthStatus.servers,
  );
  const nextStartupFailure = JSON.stringify(nextInfo.startup_failure || null);
  if (
    previousStatus !== nextStatus ||
    previousError !== nextError ||
    previousStartupFailure !== nextStartupFailure
  ) {
    scheduleMcpServersListRefresh(`readiness:${serverId}:${nextStatus}`);
  }
}

function getMcpServerRequirementsApi() {
  return window.McpServerRequirements || null;
}

function serverRequiresOAuth(server) {
  const requirementsApi = getMcpServerRequirementsApi();
  if (requirementsApi?.serverSupportsOAuth) {
    return requirementsApi.serverSupportsOAuth(server);
  }
  return Boolean(
    server?.oauth &&
      (server.oauth.requires_user_authorization || server.oauth.type),
  );
}

function serverRequiresConfig(server) {
  const requirementsApi = getMcpServerRequirementsApi();
  if (requirementsApi?.serverRequiresConfig) {
    return requirementsApi.serverRequiresConfig(server);
  }
  return Boolean(server?.requiredVars?.length || server?.required_env_vars?.length);
}

function resolveServerSetupAction(server, options = {}) {
  const requirementsApi = getMcpServerRequirementsApi();
  if (requirementsApi?.resolveControlPlaneSetupAction) {
    return requirementsApi.resolveControlPlaneSetupAction(server, options);
  }

  const hasOAuthTokens =
    typeof options.hasOAuthTokens === "boolean"
      ? options.hasOAuthTokens
      : server?.hasOAuthTokens === true;
  const isConfigured =
    typeof options.isConfigured === "boolean"
      ? options.isConfigured
      : server?.isConfigured === true;
  if (serverRequiresOAuth(server) && !hasOAuthTokens) {
    return "authenticate";
  }
  if (serverRequiresConfig(server) && !isConfigured) {
    return "configure";
  }
  return null;
}

function hasAuthorizationUrlAvailable(healthInfo) {
  return Boolean(
    healthInfo?.authorization_url_available ??
      healthInfo?.authorizationUrlAvailable,
  );
}

function isOAuthFailureState(healthStatus, healthInfo) {
  const oauthState = healthInfo?.oauth_state;
  return (
    (healthStatus === "failed" || healthStatus === "timeout") &&
    (oauthState === "failed" || oauthState === "timeout")
  );
}

function shouldShowNeedsAuth(healthStatus, healthInfo) {
  return (
    healthStatus === "needs_oauth" ||
    (hasAuthorizationUrlAvailable(healthInfo) &&
      (healthInfo?.oauth_state === "active" ||
        healthInfo?.oauth_state === "waiting_callback"))
  );
}

function resolveVisibleServerSetupAction(server, options = {}) {
  const state = options.state || window.appState;
  const configured =
    typeof options.configured === "boolean"
      ? options.configured
      : isServerConfiguredForUi(server, state);
  const enabled =
    typeof options.enabled === "boolean"
      ? options.enabled
      : isServerEnabled(server, state);
  const missingSetup =
    typeof options.missingSetup === "boolean"
      ? options.missingSetup
      : isHostModeMissingSetup(server, state);
  if (missingSetup) {
    return null;
  }

  // A HARD-disabled unconfigured integration presents as plain Disabled: no
  // setup CTA, off the Needs-Attention tab. Keyed on the hard-mode entry —
  // the only unambiguous "user deliberately disabled this" signal, because
  // toggle normalization persists an explicit false for EVERY non-enabled
  // server (a bare false is the default state of a fresh unconfigured
  // server, not a user decision).
  if (!configured && state?.disableModes?.[server.id] === "hard") {
    return null;
  }

  const healthStatus =
    options.healthStatus || getServerHealthStatus(server.id);
  const healthInfo =
    options.healthInfo || getServerHealthInfo(server.id);
  let setupAction = resolveServerSetupAction(
    server,
    configured ? {} : { isConfigured: false },
  );

  if (
    setupAction !== "configure" &&
    shouldShowNeedsAuth(healthStatus, healthInfo)
  ) {
    setupAction = "authenticate";
  } else if (!setupAction && healthStatus === "not_configured") {
    setupAction = "configure";
  } else if (!setupAction && !configured) {
    setupAction = "configure";
  }

  return configured && !enabled ? null : setupAction;
}

function buildMcpServerGridEntry(server, state = window.appState) {
  const configured = isServerConfiguredForUi(server, state);
  const enabled = isServerEnabled(server, state);
  const missingSetup = isHostModeMissingSetup(server, state);
  const healthStatus = getServerHealthStatus(server.id);
  const healthInfo = getServerHealthInfo(server.id);
  const setupAction = resolveVisibleServerSetupAction(server, {
    state,
    configured,
    enabled,
    missingSetup,
    healthStatus,
    healthInfo,
  });

  return {
    server,
    configured,
    enabled,
    missingSetup,
    healthStatus,
    healthInfo,
    setupAction,
    isCore: server.isCore,
  };
}

function normalizeBackendHealthStatusForUi(healthInfo) {
  const backendStatus = healthInfo?.status || "unknown";
  if (shouldShowNeedsAuth(backendStatus, healthInfo)) {
    return "needs_oauth";
  }
  return backendStatus;
}

function serverExpectsOAuth(server, healthInfo) {
  const healthError = String(healthInfo?.error || "");
  return (
    serverRequiresOAuth(server) ||
    hasAuthorizationUrlAvailable(healthInfo) ||
    healthInfo?.oauth_state === "active" ||
    healthInfo?.oauth_state === "waiting_callback" ||
    /\/oauth(?:\/|$)|authorization required/i.test(healthError)
  );
}

function getDisplayHealthError(status, healthInfo) {
  if (status === "healthy" || status === "starting" || status === "checking") {
    return null;
  }
  if (status === "needs_oauth") {
    return "Server configured but waiting for OAuth authorization";
  }
  return healthInfo?.error || null;
}

function getHealthStatusColor(status) {
  switch (status) {
    case "healthy":
      return "#9ece6a"; // Green
    case "needs_oauth":
      return "#e0af68"; // Orange/yellow
    case "timeout":
      return "#ff9e64"; // Orange
    case "failed":
      return "#f7768e"; // Red
    case "checking":
      return "#94a3b8"; // Slate grey
    case "starting":
      return "#94a3b8"; // Slate grey
    case "not_running":
      return "#64748b"; // Gray
    case "disabled":
      return "#64748b"; // Gray (user-disabled)
    default:
      return "#64748b"; // Gray
  }
}

// Show the save button with pulsing glow
function showSaveButton() {
  let saveBtn = document.getElementById("save-toggles-btn");
  if (!saveBtn) {
    // Create the save button if it doesn't exist
    // Find the MCP Server Configuration panel specifically
    const mcpPanel = document.querySelector(".mcp-config .panel-header");
    const container = mcpPanel
      ? mcpPanel.querySelector('div[style*="display: flex"]')
      : null;
    if (container) {
      saveBtn = document.createElement("button");
      saveBtn.id = "save-toggles-btn";
      saveBtn.className = "btn-primary pulsing-glow";
      saveBtn.textContent = "Save";
      saveBtn.style.marginRight = "0.5rem";
      saveBtn.onclick = saveMcpToggles;
      container.insertBefore(saveBtn, container.firstChild);
    }
  } else {
    saveBtn.style.display = "inline-block";
  }
}

// Hide the save button
function hideSaveButton() {
  const saveBtn = document.getElementById("save-toggles-btn");
  if (saveBtn) {
    saveBtn.style.display = "none";
  }
}

function getMcpServerFolderMenuLabel() {
  return window.electronAPI.platform === "darwin"
    ? "Open in Finder"
    : "Open Folder";
}

async function openMcpServerFolder(serverPath) {
  try {
    const result = await window.electronAPI.openMcpServerFolder(serverPath);
    if (!result?.success) {
      throw new Error(result?.error || "Failed to open integration folder");
    }
  } catch (error) {
    console.error("[MCP] Error opening integration folder:", error);
    window.showNotification(
      `Failed to open integration folder: ${error.message}`,
      "error",
    );
  }
}

async function exportMcpServer(serverPath) {
  try {
    const result = await window.electronAPI.exportMcpServer(serverPath);
    if (!result?.success) {
      throw new Error(result?.error || "Failed to export integration");
    }
    window.showNotification(
      `Integration archive created: ${result.path}`,
      "success",
    );
  } catch (error) {
    console.error("[MCP] Error exporting integration:", error);
    window.showNotification(
      `Failed to export integration: ${error.message}`,
      "error",
    );
  }
}

// Render a single server card (new card-based UI)
function renderServerCard(server, state, setupActionOverride) {
  const deploymentType = server.deploymentType || "docker";
  const isHostDisabled = isHostModeMissingSetup(server, state);
  const isEnabled = isServerEnabled(server, state);

  // Get display name - use display_name if available, otherwise name
  let displayName = server.display_name || server.name;

  // Create icon HTML and strip emoji from name if we have a custom icon
  let iconHtml = "";
  if (server.icon) {
    // Strip emoji from display name when we have a custom icon
    displayName = displayName.replace(/^[🦊💬📧🔍📋⏰🕐🔌📝🎯🚨🐙]\s*/, "");
    iconHtml = `<img src="${server.icon}" alt="${displayName}" class="mcp-card-icon-img">`;
  } else {
    // Default icon placeholder
    iconHtml = `<div class="mcp-card-icon-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="9" y1="9" x2="15" y2="9"></line>
        <line x1="9" y1="13" x2="15" y2="13"></line>
        <line x1="9" y1="17" x2="12" y2="17"></line>
      </svg>
    </div>`;
  }

  // Get health status for this server
  const healthStatus = getServerHealthStatus(server.id);
  const healthInfo = getServerHealthInfo(server.id);
  const healthColor = getHealthStatusColor(healthStatus);

  const setupAction =
    setupActionOverride === undefined
      ? resolveVisibleServerSetupAction(server, {
          state,
          configured: true,
          enabled: isEnabled,
          healthStatus,
          healthInfo,
        })
      : setupActionOverride;
  const showNeedsAuth = setupAction === "authenticate";
  const needsConfiguration = setupAction === "configure";
  const hasStartupFailure = hasStartupFailureState(
    healthStatus,
    healthInfo,
    server.id,
  );
  const showErrorState =
    isEnabled &&
    (healthStatus === "failed" ||
      healthStatus === "timeout" ||
      healthStatus === "not_running" ||
      hasStartupFailure);
  const oauthFailureState = isOAuthFailureState(healthStatus, healthInfo);
  const errorMessage = String(healthInfo?.error || "").trim();
  const escapedErrorTitle = errorMessage
    ? ` title="${escapeHtml(errorMessage)}"`
    : "";
  const errorMessageHtml =
    showErrorState && errorMessage
      ? `<div class="mcp-card-error-message"${escapedErrorTitle}>${escapeHtml(truncateText(errorMessage, 120))}</div>`
      : "";

  // Determine status dot color
  let statusDotColor;
  if (!isEnabled && healthStatus === "disabled") {
    statusDotColor = "#64748b";
  } else if (!isEnabled) {
    statusDotColor = "#64748b";
  } else if (showNeedsAuth) {
    statusDotColor = getHealthStatusColor("needs_oauth");
  } else if (needsConfiguration) {
    statusDotColor = "var(--badge-host-text)";
  } else {
    statusDotColor = healthColor;
  }

  // Card attention styling
  const needsAttention =
    (showNeedsAuth ||
      healthStatus === "failed" ||
      healthStatus === "timeout" ||
      healthStatus === "not_running" ||
      hasStartupFailure) &&
    isEnabled;
  const cardClasses = ["mcp-server-card"];
  if (needsAttention) {
    cardClasses.push("needs-attention");
  }
  if (showErrorState) {
    cardClasses.push("error-state");
  }
  if (needsConfiguration) {
    cardClasses.push("needs-config-state");
  }
  if (!isEnabled && !setupAction) {
    cardClasses.push("disabled-state");
  }
  if (isHostDisabled) {
    cardClasses.push("missing-setup-state");
  }
  if (selectedServerIds.has(server.id)) {
    cardClasses.push("selected-state");
  }
  const cardClass = cardClasses.join(" ");
  const attentionColor = showNeedsAuth
    ? getHealthStatusColor("needs_oauth")
    : healthColor;
  const cardStyle = needsAttention
    ? `--attention-color: ${attentionColor};`
    : "";

  // Status dot - use pulsing dot for starting servers
  const statusDot =
    (healthStatus === "starting" || healthStatus === "checking") && isEnabled
      ? `<div class="mcp-card-status-dot starting"></div>`
      : `<div class="mcp-card-status-dot" style="background: ${statusDotColor};"></div>`;

  // Build badges HTML - tools badge first, then other badges
  let badgesHtml = "";

  // Add tools badge FIRST for healthy servers (most important info)
  if (healthStatus === "healthy" && isEnabled) {
    const toolsInfo = state.serverToolsCache?.[server.id];
    if (toolsInfo) {
      const { enabledCount, totalCount } = toolsInfo;
      const hasDisabled = enabledCount < totalCount;
      badgesHtml += `<span class="mcp-card-badge badge-tools ${hasDisabled ? "has-disabled" : ""}"
                          data-server-id="${server.id}">
                      ${enabledCount}/${totalCount} tools
                    </span>`;
    }
  }

  // Then add other badges (CORE, USER, HOST only - no DOCKER badge)
  if (server.isCore) {
    badgesHtml += '<span class="mcp-card-badge badge-core">CORE</span>';
  }
  if (server.userInstalled) {
    badgesHtml += '<span class="mcp-card-badge badge-user">USER</span>';
  }
  // Only show HOST badge for host servers (don't show DOCKER badge)
  if (deploymentType === "host") {
    badgesHtml += '<span class="mcp-card-badge badge-host">HOST</span>';
  }
  if (isHostDisabled) {
    badgesHtml += '<span class="mcp-card-badge badge-missing">Missing Setup</span>';
  }
  // Deprecated integrations keep working but are on the way out; the badge is
  // state-independent (shows enabled or disabled, alongside SOFT/HARD).
  if (server.deprecated) {
    badgesHtml +=
      '<span class="mcp-card-badge badge-deprecated">DEPRECATED</span>';
  }
  // PORTICO-410: disabled cards show their disable mode — orange SOFT (the AI may
  // re-enable it) or red HARD (opaque to the AI; Control Plane only).
  const cardDisableMode =
    state?.disableModes?.[server.id] === "hard" ? "hard" : "soft";
  if (!isEnabled && !setupAction && !isHostDisabled) {
    badgesHtml +=
      cardDisableMode === "hard"
        ? '<span class="mcp-card-badge badge-hard-disabled">HARD</span>'
        : '<span class="mcp-card-badge badge-soft-disabled">SOFT</span>';
  }

  // Status text
  let statusText = "";
  if (showNeedsAuth) {
    const logKey = `${server.id}:${healthStatus}:${healthInfo?.oauth_state || "none"}:${healthInfo?.error || "none"}`;
    window.__oauthNeedsAuthLogged = window.__oauthNeedsAuthLogged || new Set();
    if (!window.__oauthNeedsAuthLogged.has(logKey)) {
      window.__oauthNeedsAuthLogged.add(logKey);
      console.log(
        `[OAuth] Needs auth badge for ${server.id} (status=${healthStatus}, oauth_state=${healthInfo?.oauth_state || "none"}, requires_oauth=${serverRequiresOAuth(server)}, error=${healthInfo?.error || "none"})`,
      );
    }
  }

  // Check disabled FIRST - user-disabled servers should show "Disabled" regardless of health status
  if (!isEnabled) {
    statusText = '<span class="mcp-card-status-text disabled">Disabled</span>';
  } else if (oauthFailureState) {
    statusText = `<span class="mcp-card-status-text failed"${escapedErrorTitle}>Auth Failed</span>`;
  } else if (showNeedsAuth) {
    statusText =
      '<span class="mcp-card-status-text needs-oauth">Needs Auth</span>';
  } else if (needsConfiguration) {
    statusText =
      '<span class="mcp-card-status-text needs-config">Needs Config</span>';
  } else if (healthStatus === "starting" || healthStatus === "checking") {
    statusText = `<span class="mcp-card-status-text starting">
      <span class="starting-spinner">
        <svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="starting-label">${healthStatus === "checking" ? "Checking..." : formatStartingLabel(healthInfo)}</span>
    </span>`;
  } else if (healthStatus === "failed" || healthStatus === "not_running") {
    statusText = `<span class="mcp-card-status-text failed"${escapedErrorTitle}>Failed</span>`;
  } else if (healthStatus === "timeout") {
    statusText = `<span class="mcp-card-status-text failed"${escapedErrorTitle}>Timed Out</span>`;
  } else if (healthStatus === "healthy") {
    statusText = `<span class="mcp-card-status-text healthy">${formatRunningLabel(healthInfo)}</span>`;
  } else if (healthStatus === "not_configured") {
    statusText =
      '<span class="mcp-card-status-text needs-config">Needs Config</span>';
  } else {
    statusText = '<span class="mcp-card-status-text starting">Checking...</span>';
  }

  const showAuthenticateButton = isEnabled && showNeedsAuth;
  const showConfigureButton = isEnabled && needsConfiguration;
  const showReauthMenuItem =
    serverRequiresOAuth(server) && !showAuthenticateButton;

  // Dropdown menu items
  const dropdownItems = [];

  if (isEnabled) {
    dropdownItems.push(`
      <button class="mcp-dropdown-item mcp-logs-btn" data-server-id="${server.id}" data-deployment-type="${deploymentType}" data-is-core="${server.isCore}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        View Logs
      </button>
    `);

    // Add Configuration item for servers with config options (required vars or setup markdown)
    const hasConfigOptions =
      (server.requiredVars && server.requiredVars.length > 0) ||
      server.setupMarkdown;
    if (hasConfigOptions && setupAction !== "authenticate") {
      dropdownItems.push(`
        <button class="mcp-dropdown-item mcp-configure-menu-btn" data-server-id="${server.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Configuration
        </button>
      `);
    }

    dropdownItems.push(`
      <button class="mcp-dropdown-item mcp-restart-btn" data-server-id="${server.id}" data-server-name="${displayName}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 4v6h-6"></path>
          <path d="M1 20v-6h6"></path>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
          <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path>
        </svg>
        Restart
      </button>
    `);

    if (showReauthMenuItem) {
      dropdownItems.push(`
        <button class="mcp-dropdown-item mcp-reauth-btn" data-server-id="${server.id}" data-server-name="${displayName}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          Re-auth
        </button>
      `);
    }

    if (isEnabled && RESYNCABLE_DATA_SERVERS[server.id]) {
      dropdownItems.push(`
        <button class="mcp-dropdown-item mcp-resync-btn" data-server-id="${server.id}" data-server-name="${displayName}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
            <path d="M21 3v6h-6"></path>
          </svg>
          ${RESYNCABLE_DATA_SERVERS[server.id].menuLabel}
        </button>
      `);
    }

    // Add Tools item if tools info is available for this server
    const toolsInfo = state.serverToolsCache?.[server.id];
    if (healthStatus === "healthy" && toolsInfo) {
      dropdownItems.push(`
        <button class="mcp-dropdown-item mcp-tools-btn" data-server-id="${server.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
          Tools
        </button>
      `);
    }
  }

  dropdownItems.push(`
      ${dropdownItems.length > 0 ? '<div class="mcp-dropdown-divider" role="separator"></div>' : ""}
      <button class="mcp-dropdown-item mcp-open-folder-btn" data-server-id="${server.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        ${getMcpServerFolderMenuLabel()}
      </button>
    `);

  dropdownItems.push(`
      <button class="mcp-dropdown-item mcp-export-btn" data-server-id="${server.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Export Integration
      </button>
    `);

  // Add Delete item for user-installed servers only
  if (server.userInstalled) {
    dropdownItems.push(`
      <div class="mcp-dropdown-divider" role="separator"></div>
      <button class="mcp-dropdown-item mcp-delete-btn delete-action" data-server-id="${server.id}" data-server-name="${displayName}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        Delete
      </button>
    `);
  }

  const canToggleFromMenu = !server.isCore && !isHostDisabled;
  const hasMenuActions = dropdownItems.length > 0 || canToggleFromMenu;

  // Render exactly one primary setup action, with OAuth taking precedence.
  let setupButton = "";
  if (showAuthenticateButton) {
    setupButton = `
      <button class="mcp-card-oauth-btn authenticate-btn" data-server-id="${server.id}" title="Authenticate ${displayName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        Authenticate
      </button>
    `;
  } else if (showConfigureButton) {
    setupButton = `
      <button class="mcp-card-configure-btn configure-btn" data-server-id="${server.id}" title="Configure ${displayName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0-.33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        Configure
      </button>
    `;
  }

  // Power toggle
  const powerBtnClass = `mcp-card-power-btn ${isEnabled ? "power-enabled" : "power-disabled"} ${server.isCore || isHostDisabled ? "power-locked" : ""}`;
  const powerBtnDisabled = server.isCore || isHostDisabled ? "disabled" : "";

  return `
    <div class="${cardClass}" style="${cardStyle}" data-server-id="${server.id}" data-enabled="${isEnabled}" data-needs-auth="${showAuthenticateButton}" data-setup-action="${setupAction || ""}">
      <div class="mcp-card-header">
        <div class="mcp-card-icon-wrapper">
          ${iconHtml}
          ${statusDot}
        </div>
        <div class="mcp-card-title-info">
          <h3 class="mcp-card-name ${!isEnabled && !setupAction ? "disabled" : ""}">${displayName}</h3>
          ${statusText}
        </div>
        ${
          hasMenuActions
            ? `<div class="mcp-card-menu-wrapper">
          <button class="mcp-card-menu-trigger" data-menu-server-id="${server.id}" aria-label="Server options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"></circle>
              <circle cx="12" cy="12" r="2"></circle>
              <circle cx="12" cy="19" r="2"></circle>
            </svg>
          </button>
          <div class="mcp-card-dropdown" data-dropdown-id="${server.id}">
            ${dropdownItems.join("")}
            ${
              canToggleFromMenu
                ? `${!server.userInstalled ? '<div class="mcp-dropdown-divider" role="separator"></div>' : ""}${
                    isEnabled
                      ? `<button class="mcp-dropdown-item mcp-power-toggle-item disable-soft-action"
                            data-server-id="${server.id}" data-enabled="true" data-disable-mode="soft">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Disable (Soft)
                    </button>
                    <button class="mcp-dropdown-item mcp-power-toggle-item disable-action"
                            data-server-id="${server.id}" data-enabled="true" data-disable-mode="hard">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Disable (Hard)
                    </button>`
                      : `<button class="mcp-dropdown-item mcp-power-toggle-item enable-action"
                            data-server-id="${server.id}" data-enabled="false">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Enable Integration
                    </button>
                    <button class="mcp-dropdown-item mcp-disable-mode-switch-item ${cardDisableMode === "hard" ? "disable-soft-action" : "disable-action"}"
                            data-server-id="${server.id}" data-target-mode="${cardDisableMode === "hard" ? "soft" : "hard"}">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                      </svg>
                      ${cardDisableMode === "hard" ? "Switch to Soft Disable" : "Switch to Hard Disable"}
                    </button>`
                  }`
                : ""
            }
          </div>
        </div>`
            : ""
        }
      </div>
      <div class="mcp-card-body">
        <div class="mcp-card-badges">${badgesHtml}</div>
        ${errorMessageHtml}
        <div class="mcp-card-footer">
          ${setupButton}
        </div>
      </div>
    </div>
  `;
}

// Render unconfigured server card
function renderUnconfiguredCard(
  server,
  state = window.appState,
  setupActionOverride,
) {
  let displayName = server.display_name || server.name;

  let iconHtml = "";
  if (server.icon) {
    displayName = displayName.replace(/^[🦊💬📧🔍📋⏰🕐🔌📝🎯🚨🐙]\s*/, "");
    iconHtml = `<img src="${server.icon}" alt="${displayName}" class="mcp-card-icon-img">`;
  } else {
    iconHtml = `<div class="mcp-card-icon-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="9" y1="9" x2="15" y2="9"></line>
        <line x1="9" y1="13" x2="15" y2="13"></line>
        <line x1="9" y1="17" x2="12" y2="17"></line>
      </svg>
    </div>`;
  }

  const deploymentType = server.deploymentType || "docker";
  // Only show HOST badge for host servers - don't show DOCKER badge
  const deploymentBadge =
    deploymentType === "host"
      ? '<span class="mcp-card-badge badge-host">HOST</span>'
      : "";
  const deprecatedBadge = server.deprecated
    ? '<span class="mcp-card-badge badge-deprecated">DEPRECATED</span>'
    : "";
  // Null resolution means "explicitly toggled off" (the resolver's only null
  // case for unconfigured servers) — do NOT resurrect a setup CTA for it.
  const setupAction =
    setupActionOverride === undefined
      ? resolveVisibleServerSetupAction(server, {
          state,
          configured: false,
          enabled: false,
        })
      : setupActionOverride;
  const needsAuthentication = setupAction === "authenticate";
  const needsConfiguration = setupAction === "configure";
  const isEnabled = isServerEnabled(server, state);
  // Menu semantics: `isEnabled` is unconditionally false while unconfigured,
  // and toggle normalization writes an explicit false for every non-enabled
  // server, so a bare false is NOT a user decision. The hard-mode entry is
  // the only deliberate-disable signal; soft-disabling is only meaningful
  // when the server is explicitly toggled ON (it then leaves the model's
  // needs-config/needs-auth guidance for the disabled listing).
  const isHardDisabled = state?.disableModes?.[server.id] === "hard";
  const isDesiredOn = state?.toggles?.[server.id] === true;
  const modeBadge = isHardDisabled
    ? '<span class="mcp-card-badge badge-hard-disabled">HARD</span>'
    : "";
  const statusText = needsAuthentication
    ? '<span class="mcp-card-status-text needs-oauth">Needs Auth</span>'
    : needsConfiguration
      ? '<span class="mcp-card-status-text needs-config">Needs Config</span>'
      : '<span class="mcp-card-status-text disabled">Disabled</span>';

  let setupButton = "";
  if (needsAuthentication) {
    setupButton = `
      <button class="mcp-card-oauth-btn authenticate-btn" data-server-id="${server.id}" title="Authenticate ${displayName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        Authenticate
      </button>
    `;
  } else if (needsConfiguration) {
    setupButton = `
      <button class="mcp-card-configure-btn configure-btn" data-server-id="${server.id}" title="Configure ${displayName}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        Configure
      </button>
    `;
  }

  const cardStateClass = needsAuthentication
    ? "needs-attention"
    : needsConfiguration
      ? "needs-config-state"
      : "disabled-state";
  const statusDotColor = needsAuthentication
    ? getHealthStatusColor("needs_oauth")
    : needsConfiguration
      ? "var(--badge-host-text)"
      : "#64748b";

  // Kebab menu: same markup/classes as renderServerCard so the grid-level
  // selector handlers bind unchanged. State-independent actions plus the
  // desired-state toggle block (Disable Soft/Hard, or Enable + mode switch).
  const dropdownItems = [];
  dropdownItems.push(`
      <button class="mcp-dropdown-item mcp-open-folder-btn" data-server-id="${server.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        ${getMcpServerFolderMenuLabel()}
      </button>
    `);
  dropdownItems.push(`
      <button class="mcp-dropdown-item mcp-export-btn" data-server-id="${server.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Export Integration
      </button>
    `);
  if (server.userInstalled) {
    dropdownItems.push(`
      <div class="mcp-dropdown-divider" role="separator"></div>
      <button class="mcp-dropdown-item mcp-delete-btn delete-action" data-server-id="${server.id}" data-server-name="${displayName}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        Delete
      </button>
    `);
  }

  const canToggleFromMenu =
    !server.isCore && !isHostModeMissingSetup(server, state);
  const menuHtml = `<div class="mcp-card-menu-wrapper">
          <button class="mcp-card-menu-trigger" data-menu-server-id="${server.id}" aria-label="Server options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"></circle>
              <circle cx="12" cy="12" r="2"></circle>
              <circle cx="12" cy="19" r="2"></circle>
            </svg>
          </button>
          <div class="mcp-card-dropdown" data-dropdown-id="${server.id}">
            ${dropdownItems.join("")}
            ${
              canToggleFromMenu
                ? `${!server.userInstalled ? '<div class="mcp-dropdown-divider" role="separator"></div>' : ""}${
                    !isHardDisabled
                      ? `${
                          isDesiredOn
                            ? `<button class="mcp-dropdown-item mcp-power-toggle-item disable-soft-action"
                            data-server-id="${server.id}" data-enabled="true" data-disable-mode="soft">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Disable (Soft)
                    </button>`
                            : ""
                        }<button class="mcp-dropdown-item mcp-power-toggle-item disable-action"
                            data-server-id="${server.id}" data-enabled="true" data-disable-mode="hard">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Disable (Hard)
                    </button>`
                      : `<button class="mcp-dropdown-item mcp-power-toggle-item enable-action"
                            data-server-id="${server.id}" data-enabled="false">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                        <line x1="12" y1="2" x2="12" y2="12"></line>
                      </svg>
                      Enable Integration
                    </button>
                    <button class="mcp-dropdown-item mcp-disable-mode-switch-item disable-soft-action"
                            data-server-id="${server.id}" data-target-mode="soft">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                      </svg>
                      Switch to Soft Disable
                    </button>`
                  }`
                : ""
            }
          </div>
        </div>`;

  return `
    <div class="mcp-server-card unconfigured ${cardStateClass}" data-server-id="${server.id}" data-enabled="${isEnabled}" data-needs-auth="${needsAuthentication}" data-setup-action="${setupAction || ""}">
      <div class="mcp-card-header">
        <div class="mcp-card-icon-wrapper">
          ${iconHtml}
          <div class="mcp-card-status-dot" style="background: ${statusDotColor};"></div>
        </div>
        <div class="mcp-card-title-info">
          <h3 class="mcp-card-name ${!setupAction ? "disabled" : ""}">${displayName}</h3>
          ${statusText}
        </div>
        ${menuHtml}
      </div>
      <div class="mcp-card-body">
        <div class="mcp-card-badges">
          ${deploymentBadge}${deprecatedBadge}${modeBadge}
        </div>
        <div class="mcp-card-footer">
          ${setupButton}
        </div>
      </div>
    </div>
  `;
}

// Save MCP toggle state to mcp_toggles.json
async function saveMcpToggles() {
  const state = window.appState;
  try {
    const result = await window.electronAPI.saveMcpToggles(state.toggles);
    if (result.success) {
      state.togglesModified = false;
      hideSaveButton();

      // Show loading indicator
      window.showLoading("Reloading MCP servers (partial restart)...");

      try {
        // Call the partial MCP restart API (preserves chat sessions!)
        // This only restarts: mcpo, host-mcpo, health-check
        // Preserves: mcpo-core, llm-gateway, open-webui
        const response = await fetch(`${LOCAL_API_BASE_URL}/api/restart-mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Restart API returned ${response.status}`);
        }

        const restartResult = await response.json();

        if (restartResult.success) {
          window.showNotification(
            "MCP servers reloaded successfully! (~1 minute)",
            "success",
          );

          // Reload MCP servers after restart
          const serversResult = await window.electronAPI.loadMcpServers();
          if (serversResult.success) {
            state.servers = serversResult.data;
            updateMcpServersList();
          }
        } else {
          window.showNotification(
            `MCP reload failed: ${restartResult.error}`,
            "error",
          );
          console.error("Restart logs:", restartResult.logs);
        }
      } catch (error) {
        console.error("Failed to call restart API:", error);

        // Fallback: Prompt user for manual restart
        const restart = confirm(
          "MCP server configuration saved!\n\n" +
            "Could not automatically restart MCP services.\n" +
            "Would you like to manually restart all services now?",
        );
        if (restart && window.restartServices) {
          await window.restartServices();
        }
      }

      window.hideLoading();
    } else {
      window.showNotification("Failed to save MCP toggles", "error");
    }
  } catch (error) {
    console.error("Failed to save MCP toggles:", error);
    window.showNotification("Failed to save MCP toggles", "error");
  }
}

function toggleMcpServer(serverId, enabled) {
  const state = window.appState;

  // Find the server to check if it's core or disabled HOST server
  const server = state.servers.find((s) => s.id === serverId);

  if (server && server.isCore) {
    // Should never happen due to disabled attribute, but safety check
    return;
  }

  // Check if it's a HOST server when HOST_MODE is not supported
  const isHostDisabled = isHostModeMissingSetup(server, state);

  if (isHostDisabled) {
    // Cannot toggle HOST servers when HOST_MODE is not supported
    return;
  }

  state.toggles[serverId] = enabled;
  state.togglesModified = true;
  showSaveButton();

  // Update badge count - core servers always count
  const configuredServers = state.servers.filter((s) =>
    isServerConfiguredForUi(s, state),
  );
  let enabledServers = configuredServers.filter((s) =>
    isServerEnabled(s, state),
  );

  // Filter out HOST servers if HOST_MODE is not supported
  if (!state.hostModeSupported) {
    enabledServers = enabledServers.filter(
      (s) => (s.deploymentType || "docker") !== "host",
    );
  }

  updateMcpBadge(enabledServers);
}

async function updateMcpServersList() {
  const state = window.appState;
  const list = document.getElementById("mcp-servers-list");
  initBulkSelectionButtons();

  // NOTE: We do NOT reload MCP servers from disk here on every UI update.
  // MCP servers are loaded:
  // 1. On app initialization
  // 2. After explicit server add/remove/modify operations
  // 3. After MCP infrastructure restarts
  // This prevents unnecessary disk I/O and log spam during continuous health checks.

  // Early return if the element doesn't exist yet (e.g., Control Plane tab not rendered)
  if (!list) {
    // Still update the badge count even if the list isn't visible
    if (state.healthStatus) {
      updateMcpBadgeWithHealth();
    } else {
      const configuredServers = state.servers.filter((s) =>
        isServerConfiguredForUi(s, state),
      );
      let enabledServers = configuredServers.filter((s) =>
        isServerEnabled(s, state),
      );

      // Filter out HOST servers if HOST_MODE is not supported
      if (!state.hostModeSupported) {
        enabledServers = enabledServers.filter(
          (s) => (s.deploymentType || "docker") !== "host",
        );
      }

      updateMcpBadge(enabledServers);
    }
    return;
  }

  const filteredGridEntries = getFilteredMcpServerGridEntries(
    state.servers.map((server) => buildMcpServerGridEntry(server, state)),
  );
  const { ordered: orderedGridEntries } =
    partitionMcpServerGridEntries(filteredGridEntries);
  syncSelectedServersWithVisible(
    filteredGridEntries.map((entry) => entry.server),
    state,
  );

  // Render card-based grid layout
  // Order: auth, configuration, other enabled, disabled, then missing setup.
  list.innerHTML = `
    ${orderedGridEntries
      .map((entry) =>
        entry.configured || entry.missingSetup
          ? renderServerCard(entry.server, state, entry.setupAction)
          : renderUnconfiguredCard(entry.server, state, entry.setupAction),
      )
      .join("")}
    ${
      orderedGridEntries.length === 0
        ? `
      <div class="mcp-no-results">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <p>No servers match your search</p>
      </div>
    `
        : ""
    }
  `;
  updateBulkSelectionUI();

  // Add event listeners to all power buttons (skip if disabled)
  const powerButtons = list.querySelectorAll(".mcp-power-btn:not([disabled])");
  powerButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const button = e.currentTarget;
      const serverId = button.dataset.serverId;
      const currentlyEnabled = button.dataset.enabled === "true";
      const newState = !currentlyEnabled;

      // Find the server to get its name and deployment type
      const server = state.servers.find((s) => s.id === serverId);
      const serverName = server?.name || serverId;
      const deploymentType = server?.deploymentType || "docker";

      // Show confirmation modal instead of immediately toggling
      showToggleConfirmationModal(
        serverId,
        serverName,
        newState,
        deploymentType,
      );
    });
  });

  // Add event listeners to menu trigger buttons (ellipsis menu)
  const menuTriggers = list.querySelectorAll(".mcp-card-menu-trigger");
  menuTriggers.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const trigger = e.currentTarget;
      const serverId = trigger.dataset.menuServerId;
      // Find the dropdown that's a sibling of this trigger (inside same wrapper)
      const dropdown =
        trigger.parentElement.querySelector(".mcp-card-dropdown");
      const wasOpen = dropdown?.classList.contains("visible");

      closeAllDropdowns();
      if (!wasOpen && dropdown) {
        // Store original parent so we can move it back later
        dropdown._originalParent = dropdown.parentElement;

        // Move dropdown to body to escape overflow clipping
        document.body.appendChild(dropdown);

        // Position dropdown using fixed positioning
        const btnRect = trigger.getBoundingClientRect();
        // Temporarily show dropdown to measure its height
        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropdownWidth = dropdown.offsetWidth;
        const dropdownHeight = dropdown.offsetHeight;
        dropdown.style.visibility = "";
        dropdown.style.display = "";

        // Match the OWUI chat-row menu: open below the ellipsis and extend to
        // its right. The viewport clamps below remain the only reason a menu
        // should shift leftward.
        let left = btnRect.left;
        let top = btnRect.bottom + 4;
        let openUpward = false;

        // Check if dropdown would go off the bottom edge
        if (top + dropdownHeight > window.innerHeight - 8) {
          // Open upward instead
          top = btnRect.top - dropdownHeight - 4;
          openUpward = true;
        }

        // Ensure dropdown doesn't go off the top edge when opening upward
        if (openUpward && top < 8) {
          top = 8;
        }

        // Ensure dropdown doesn't go off the left edge
        if (left < 8) left = 8;

        // Ensure dropdown doesn't go off the right edge
        if (left + dropdownWidth > window.innerWidth - 8) {
          left = window.innerWidth - dropdownWidth - 8;
        }

        dropdown.style.top = `${top}px`;
        dropdown.style.left = `${left}px`;

        // Add class for upward opening animation if needed
        dropdown.classList.toggle("open-upward", openUpward);

        dropdown.classList.add("visible");
        openDropdownId = serverId;
      }
    });
  });

  // Add event listeners to health action buttons
  const viewLogsButtons = list.querySelectorAll(".mcp-logs-btn");
  viewLogsButtons.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const deploymentType = e.currentTarget.dataset.deploymentType;
      const isCore = e.currentTarget.dataset.isCore === "true";
      await showServerLogs(serverId, deploymentType, isCore);
    });
  });

  const openFolderButtons = list.querySelectorAll(".mcp-open-folder-btn");
  openFolderButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const server = state.servers.find((entry) => entry.id === serverId);
      if (server?.server_path) {
        void openMcpServerFolder(server.server_path);
      }
    });
  });

  const exportButtons = list.querySelectorAll(".mcp-export-btn");
  exportButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const server = state.servers.find((entry) => entry.id === serverId);
      if (server?.server_path) {
        void exportMcpServer(server.server_path);
      }
    });
  });

  const authenticateButtons = list.querySelectorAll(".authenticate-btn");
  authenticateButtons.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const serverId = e.currentTarget.dataset.serverId;
      await runOAuthFlowForServer(serverId);
    });
  });

  // Add event listeners to tools badges
  const toolsBadges = list.querySelectorAll(".badge-tools");
  toolsBadges.forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const serverId = e.currentTarget.dataset.serverId;
      if (window.openToolsModal) {
        window.openToolsModal(serverId, e);
      } else {
        console.error("[Tools Badge] openToolsModal is not available");
      }
    });
  });

  // Per-card click handlers (matching agent-skills.js and marketplaces.js pattern)
  list.querySelectorAll(".mcp-server-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Don't trigger if clicking on menu wrapper or dropdown (same pattern as agent-skills.js)
        if (
          e.target.closest(".mcp-card-menu-wrapper") ||
          e.target.closest(".mcp-card-menu-trigger") ||
          e.target.closest(".mcp-card-dropdown")
        ) {
          return;
        }

        const serverId = card.dataset.serverId;
        if (!serverId) return;

        const server = state.servers.find((s) => s.id === serverId);
        const selectionModifierPressed = isSelectionModifierPressed(e);
        if (selectionModifierPressed) {
          e.preventDefault();
          e.stopPropagation();
          if (!isServerBulkSelectable(server, state)) {
            return;
          }
          if (selectedServerIds.has(serverId)) {
            selectedServerIds.delete(serverId);
          } else {
            selectedServerIds.add(serverId);
          }
          updateBulkSelectionUI();
          return;
        }

        const healthStatus = getServerHealthStatus(serverId);
        const healthInfo = getServerHealthInfo(serverId);
        // Don't open tools or failure modals for disabled servers.
        if (card.dataset.enabled === "false") {
          return;
        }

        if (hasStartupFailureState(healthStatus, healthInfo, serverId)) {
          if (isConfigStartupFailure(healthInfo, serverId)) {
            showStartupFailureModal(serverId);
          } else {
            const deploymentType =
              healthInfo?.deployment || server?.deploymentType || "docker";
            void showServerLogs(serverId, deploymentType, Boolean(server?.isCore));
          }
          return;
        }

        // Don't open tools modal for servers that need authentication
        if (card.dataset.needsAuth === "true") {
          return;
        }

        if (serverId && window.openToolsModal) {
          window.openToolsModal(serverId, e);
        }
      });
    });

  // Add event listeners to tools dropdown menu items
  const toolsButtons = list.querySelectorAll(".mcp-tools-btn");
  toolsButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      if (window.openToolsModal) {
        window.openToolsModal(serverId, e);
      } else {
        console.error("[Tools Menu] openToolsModal is not available");
      }
    });
  });

  // Add event listeners to configure buttons (unconfigured cards)
  const configureButtons = list.querySelectorAll(".configure-btn");
  configureButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const serverId = e.currentTarget.dataset.serverId;
      if (window.openMcpConfigModal) {
        window.openMcpConfigModal(serverId, e);
      } else {
        console.error("[Configure] openMcpConfigModal is not available");
      }
    });
  });

  // Add event listeners to configuration dropdown menu items
  const configDropdownItems = list.querySelectorAll(".mcp-configure-menu-btn");
  configDropdownItems.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      if (window.openMcpConfigModal) {
        window.openMcpConfigModal(serverId, e);
      } else {
        console.error(
          "[Configuration Menu] openMcpConfigModal is not available",
        );
      }
    });
  });

  // Add event listeners to delete buttons (user-installed servers only)
  const deleteButtons = list.querySelectorAll(".mcp-delete-btn");
  deleteButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const serverName = e.currentTarget.dataset.serverName;
      showDeleteConfirmationModal(serverId, serverName);
    });
  });

  // Add event listeners to restart buttons
  const restartButtons = list.querySelectorAll(".mcp-restart-btn");
  restartButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const serverName = e.currentTarget.dataset.serverName;

      // Show restart confirmation modal instead of confirm()
      showRestartConfirmationModal(serverId, serverName);
    });
  });

  const reauthButtons = list.querySelectorAll(".mcp-reauth-btn");
  reauthButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const serverName = e.currentTarget.dataset.serverName;
      showReauthConfirmationModal(serverId, serverName);
    });
  });

  const resyncButtons = list.querySelectorAll(".mcp-resync-btn");
  resyncButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const serverName = e.currentTarget.dataset.serverName;
      showResyncConfirmationModal(serverId, serverName);
    });
  });

  // Add event listeners to power toggle dropdown items
  const powerToggleItems = list.querySelectorAll(".mcp-power-toggle-item");
  powerToggleItems.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const currentlyEnabled = e.currentTarget.dataset.enabled === "true";
      const newState = !currentlyEnabled;
      const disableMode =
        e.currentTarget.dataset.disableMode === "hard" ? "hard" : "soft";

      // Find the server to get its name and deployment type
      const server = state.servers.find((s) => s.id === serverId);
      const serverName = server?.name || serverId;
      const deploymentType = server?.deploymentType || "docker";

      // Show confirmation modal instead of immediately toggling
      showToggleConfirmationModal(
        serverId,
        serverName,
        newState,
        deploymentType,
        disableMode,
      );
    });
  });

  // PORTICO-410: switch an already-disabled server between soft and hard without
  // re-enabling it (metadata-only; no container lifecycle).
  const disableModeSwitchItems = list.querySelectorAll(
    ".mcp-disable-mode-switch-item",
  );
  disableModeSwitchItems.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const serverId = e.currentTarget.dataset.serverId;
      const targetMode =
        e.currentTarget.dataset.targetMode === "hard" ? "hard" : "soft";
      void handleDisableModeSwitch(serverId, targetMode);
    });
  });

  // Update MCP badge - use health status if available
  if (state.healthStatus) {
    updateMcpBadgeWithHealth();
  } else {
    // Fallback to count enabled servers (core servers always count)
    const configuredServers = state.servers.filter((s) =>
      isServerConfiguredForUi(s, state),
    );
    let enabledServers = configuredServers.filter((s) =>
      isServerEnabled(s, state),
    );

    // Filter out HOST servers if HOST_MODE is not supported
    if (!state.hostModeSupported) {
      enabledServers = enabledServers.filter(
        (s) => (s.deploymentType || "docker") !== "host",
      );
    }

    updateMcpBadge(enabledServers);
  }
  void refreshLaggingServerReadiness({ reason: "control-plane-render" });
}

const CONTROL_PLANE_ATTENTION_FAILURE_STATUSES = new Set([
  "failed",
  "timeout",
  "not_running",
]);

function calculateMcpAttentionCount(state = window.appState) {
  if (!state) {
    return 0;
  }

  return getServersWithEffectiveHealth(state).filter(({ name, info, server }) => {
    if (!server || !isServerEnabled(server, state)) {
      return false;
    }

    const healthStatus = String(info?.status || "")
      .trim()
      .toLowerCase();
    if (healthStatus === "disabled" || info?.disabled_by_user === true) {
      return false;
    }

    const serverId = server?.id || name;
    return (
      shouldShowNeedsAuth(healthStatus, info) ||
      hasStartupFailureState(healthStatus, info, serverId) ||
      CONTROL_PLANE_ATTENTION_FAILURE_STATUSES.has(healthStatus)
    );
  }).length;
}

function updateControlPlaneAttentionBadge(count) {
  const badge = document.getElementById("control-plane-attention-badge");
  const button = document.getElementById("control-plane-toggle");
  const normalizedCount = Math.max(0, Math.trunc(Number(count) || 0));
  const hasAttention = normalizedCount > 0;
  const buttonLabel = hasAttention
    ? `Control Plane, ${normalizedCount} MCP ${normalizedCount === 1 ? "server needs" : "servers need"} attention`
    : "Control Plane";

  if (button) {
    button.setAttribute("aria-label", buttonLabel);
    button.setAttribute("title", buttonLabel);
  }

  if (!badge) {
    return;
  }

  badge.textContent = normalizedCount > 99 ? "99+" : String(normalizedCount);
  badge.classList.toggle("hidden", !hasAttention);
  badge.setAttribute("aria-hidden", "true");
}

function updateMcpBadge(configuredServers) {
  const badgeCount = document.querySelector(".mcp-badge-count");
  const tooltipContent = document.getElementById("mcp-tooltip-content");
  const badge = document.getElementById("mcp-badge");
  const badgeDot = document.querySelector(".mcp-badge-dot");
  const attentionCount = window.appState?.healthStatus?.servers
    ? calculateMcpAttentionCount(window.appState)
    : 0;

  updateControlPlaneAttentionBadge(attentionCount);

  if (badgeCount) {
    badgeCount.textContent = configuredServers.length;
  }

  const sortServers = (servers) =>
    [...servers].sort((a, b) => {
      const nameA = a.display_name || a.name || "";
      const nameB = b.display_name || b.name || "";
      return nameA.localeCompare(nameB);
    });

  const renderInitializingServerCard = (server) => {
    let displayName = server.display_name || server.name || "Unknown";
    displayName = displayName.replace(/^[🦊💬📧🔍📋⏰🕐🔌📝🎯🚨🐙]\s*/, "");

    const iconHtml = server.icon
      ? `<img src="${server.icon}" alt="${displayName}" class="tooltip-server-icon">`
      : `<div class="tooltip-server-icon-placeholder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="20" rx="2" ry="2"></rect>
            <line x1="7" y1="2" x2="7" y2="22"></line>
          </svg>
        </div>`;

    return `
      <div class="tooltip-server-card">
        <div class="tooltip-server-icon-wrapper">
          ${iconHtml}
          <span class="tooltip-status-spinner">
            <svg viewBox="0 0 24 24" width="8" height="8">
              <circle cx="12" cy="12" r="10" stroke="var(--text-tertiary, #94a3b8)" stroke-width="3" fill="none" stroke-dasharray="31.4" stroke-dashoffset="10">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
              </circle>
            </svg>
          </span>
        </div>
        <span class="tooltip-server-name" title="${displayName}">${displayName}</span>
      </div>
    `;
  };

  const renderTooltipSection = ({
    dotClass,
    title,
    count,
    cardsHtml,
  }) => `
    <div class="tooltip-section">
      <div class="tooltip-section-header">
        <span class="${dotClass}"></span>
        <span class="tooltip-section-title">${title}</span>
        <span class="tooltip-column-count">${count}</span>
      </div>
      <div class="tooltip-card-grid">
        ${cardsHtml}
      </div>
    </div>
  `;

  if (tooltipContent) {
    if (configuredServers.length === 0) {
      tooltipContent.innerHTML =
        '<span style="color: #94a3b8; font-size: 13px;">No MCP servers configured</span>';
    } else {
      const coreServers = sortServers(configuredServers.filter((s) => s.isCore));
      const userServers = sortServers(
        configuredServers.filter((s) => !s.isCore),
      );
      const allServers = sortServers(configuredServers);
      const sections = [];

      if (coreServers.length > 0) {
        sections.push(
          renderTooltipSection({
            dotClass: "tooltip-column-dot tooltip-dot-core",
            title: "Core",
            count: coreServers.length,
            cardsHtml: coreServers.map((server) => renderInitializingServerCard(server)).join(""),
          }),
        );
      }

      if (userServers.length > 0) {
        sections.push(
          renderTooltipSection({
            dotClass: "tooltip-column-dot tooltip-dot-user",
            title: "User",
            count: userServers.length,
            cardsHtml: userServers.map((server) => renderInitializingServerCard(server)).join(""),
          }),
        );
      }

      sections.push(
        renderTooltipSection({
          dotClass: "tooltip-section-dot tooltip-dot-starting",
          title: "Initializing",
          count: allServers.length,
          cardsHtml: allServers.map((server) => renderInitializingServerCard(server)).join(""),
        }),
      );

      tooltipContent.innerHTML = `<div class="tooltip-sections">${sections.join("")}</div>`;
    }
  }

  // Initial state style: neutral "initializing" look until health data arrives.
  if (badge) {
    if (configuredServers.length > 0) {
      badge.style.background =
        "linear-gradient(135deg, rgba(148, 163, 184, 0.15), rgba(148, 163, 184, 0.05))";
      badge.style.borderColor = "#94a3b8";
      if (badgeDot) {
        badgeDot.style.background = "#94a3b8";
      }
    } else {
      badge.style.background = "";
      badge.style.borderColor = "";
      if (badgeDot) {
        badgeDot.style.background = "";
      }
    }
  }
}

function updateMcpBadgeWithHealth() {
  const state = window.appState;
  const badgeCount = document.querySelector(".mcp-badge-count");
  const badge = document.getElementById("mcp-badge");
  const tooltipContent = document.getElementById("mcp-tooltip-content");

  if (!state.healthStatus || !state.healthStatus.servers) {
    // Fall back to regular badge update
    const configuredServers = state.servers.filter((s) =>
      isServerConfiguredForUi(s, state),
    );
    let enabledServers = configuredServers.filter((s) =>
      isServerEnabled(s, state),
    );
    if (!state.hostModeSupported) {
      enabledServers = enabledServers.filter(
        (s) => (s.deploymentType || "docker") !== "host",
      );
    }
    updateMcpBadge(enabledServers);
    return;
  }

  const allServersWithHealth = getServersWithEffectiveHealth(state);
  updateControlPlaneAttentionBadge(calculateMcpAttentionCount(state));

  // Separate by status. Failed OAuth flows stay failed unless the server
  // currently has an actionable authorization prompt.
  const healthyServers = allServersWithHealth.filter(
    (s) => s.info.status === "healthy",
  );
  const startingServers = allServersWithHealth.filter(
    (s) => s.info.status === "starting" || s.info.status === "checking",
  );
  const disabledServers = allServersWithHealth.filter(
    (s) => s.info.status === "disabled",
  );
  const notRunningServers = allServersWithHealth.filter(
    (s) => s.info.status === "not_running",
  );

  const needsOAuthServers = allServersWithHealth.filter((s) => {
    return shouldShowNeedsAuth(s.info.status, s.info);
  });
  const timeoutServers = allServersWithHealth.filter(
    (s) => s.info.status === "timeout" && !shouldShowNeedsAuth(s.info.status, s.info),
  );

  const failedServers = allServersWithHealth.filter((s) => {
    if (s.info.status !== "failed") return false;
    return !shouldShowNeedsAuth(s.info.status, s.info);
  });

  const runningCount = healthyServers.length;
  const totalCount = state.healthStatus.summary.total;
  // Use actual re-categorized array lengths (not raw summary counts)
  // because we moved OAuth-related failures to needsOAuthServers
  const needsOAuthCount = needsOAuthServers.length;
  const timeoutCount = timeoutServers.length;
  const failedCount = failedServers.length;
  const disabledCount = disabledServers.length;
  const startingCount = startingServers.length;

  // Update badge count with running servers
  if (badgeCount) {
    badgeCount.textContent = runningCount;
  }

  // Update badge color and dot color based on worst status
  const badgeDot = document.querySelector(".mcp-badge-dot");
  const notRunningCount = notRunningServers.length;

  if (badge) {
    if (failedCount > 0 || timeoutCount > 0 || notRunningCount > 0) {
      // Red for failures
      badge.style.background =
        "linear-gradient(135deg, rgba(247, 118, 142, 0.15), rgba(247, 118, 142, 0.05))";
      badge.style.borderColor = "#f7768e";
      if (badgeDot) {
        badgeDot.style.background = "#f7768e";
      }
    } else if (needsOAuthCount > 0) {
      // Orange for OAuth needed
      badge.style.background =
        "linear-gradient(135deg, rgba(224, 175, 104, 0.15), rgba(224, 175, 104, 0.05))";
      badge.style.borderColor = "#e0af68";
      if (badgeDot) {
        badgeDot.style.background = "#e0af68";
      }
    } else if (startingCount > 0) {
      // Slate grey for starting servers
      badge.style.background =
        "linear-gradient(135deg, rgba(148, 163, 184, 0.15), rgba(148, 163, 184, 0.05))";
      badge.style.borderColor = "#94a3b8";
      if (badgeDot) {
        badgeDot.style.background = "#94a3b8";
      }
    } else {
      // Green for all healthy
      badge.style.background =
        "linear-gradient(135deg, rgba(158, 206, 106, 0.15), rgba(158, 206, 106, 0.05))";
      badge.style.borderColor = "#9ece6a";
      if (badgeDot) {
        badgeDot.style.background = "#9ece6a";
      }
    }
  }

  // Helper function to render server in tooltip as a compact card
  function renderTooltipServer(
    name,
    info,
    server,
    statusColor,
    isStarting = false,
  ) {
    let displayName = server?.display_name || server?.name || name;

    // Clean up emoji prefixes from display name
    displayName = displayName.replace(/^[🦊💬📧🔍📋⏰🕐🔌📝🎯🚨🐙]\s*/, "");

    let iconHtml = "";
    if (server?.icon) {
      iconHtml = `<img src="${server.icon}" alt="${displayName}" class="tooltip-server-icon">`;
    } else {
      // Default icon placeholder
      iconHtml = `<div class="tooltip-server-icon-placeholder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="20" rx="2" ry="2"></rect>
          <line x1="7" y1="2" x2="7" y2="22"></line>
        </svg>
      </div>`;
    }

    // Status dot or spinner
    const statusIndicator = isStarting
      ? `<span class="tooltip-status-spinner">
        <svg viewBox="0 0 24 24" width="8" height="8">
          <circle cx="12" cy="12" r="10" stroke="${statusColor}" stroke-width="3" fill="none" stroke-dasharray="31.4" stroke-dashoffset="10">
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
          </circle>
        </svg>
      </span>`
      : `<span class="tooltip-status-dot" style="background: ${statusColor};"></span>`;

    return `
      <div class="tooltip-server-card">
        <div class="tooltip-server-icon-wrapper">
          ${iconHtml}
          ${statusIndicator}
        </div>
        <span class="tooltip-server-name" title="${displayName}">${displayName}</span>
      </div>
    `;
  }

  const renderTooltipSection = ({
    dotClass,
    title,
    count,
    cardsHtml,
  }) => `
    <div class="tooltip-section">
      <div class="tooltip-section-header">
        <span class="${dotClass}"></span>
        <span class="tooltip-section-title">${title}</span>
        <span class="tooltip-column-count">${count}</span>
      </div>
      <div class="tooltip-card-grid">
        ${cardsHtml}
      </div>
    </div>
  `;

  // Sort servers alphabetically by display name
  const sortServerList = (serverList) => {
    return serverList.sort((a, b) => {
      const displayNameA = a.server?.display_name || a.server?.name || a.name;
      const displayNameB = b.server?.display_name || b.server?.name || b.name;
      return displayNameA.localeCompare(displayNameB);
    });
  };

  // Separate healthy servers into Core and User categories
  const coreHealthyServers = healthyServers.filter(
    (s) => s.server?.isCore === true,
  );
  const userHealthyServers = healthyServers.filter(
    (s) => s.server?.isCore !== true,
  );

  const sections = [];

  if (healthyServers.length > 0) {
    const sortedCore = sortServerList(coreHealthyServers);
    const sortedUser = sortServerList(userHealthyServers);

    if (sortedCore.length > 0) {
      sections.push(
        renderTooltipSection({
          dotClass: "tooltip-column-dot tooltip-dot-core",
          title: "Core",
          count: sortedCore.length,
          cardsHtml: sortedCore
            .map((s) =>
              renderTooltipServer(
                s.name,
                s.info,
                s.server,
                "var(--tooltip-status-healthy, var(--status-success, #4ade80))",
              ),
            )
            .join(""),
        }),
      );
    }

    if (sortedUser.length > 0) {
      sections.push(
        renderTooltipSection({
          dotClass: "tooltip-column-dot tooltip-dot-user",
          title: "User",
          count: sortedUser.length,
          cardsHtml: sortedUser
            .map((s) =>
              renderTooltipServer(
                s.name,
                s.info,
                s.server,
                "var(--tooltip-status-healthy, var(--status-success, #4ade80))",
              ),
            )
            .join(""),
        }),
      );
    }
  }

  if (startingServers.length > 0) {
    const sortedStarting = sortServerList(startingServers);
    sections.push(
      renderTooltipSection({
        dotClass: "tooltip-section-dot tooltip-dot-starting",
        title: "Starting",
        count: startingCount,
        cardsHtml: sortedStarting
          .map((s) =>
            renderTooltipServer(
              s.name,
              s.info,
              s.server,
              "var(--text-tertiary, #94a3b8)",
              true,
            ),
          )
          .join(""),
      }),
    );
  }

  if (needsOAuthServers.length > 0 || timeoutServers.length > 0) {
    const sortedNeedsOAuth = sortServerList(needsOAuthServers);
    const sortedTimeout = sortServerList(timeoutServers);
    const allNeedsAuth = [...sortedTimeout, ...sortedNeedsOAuth];
    sections.push(
      renderTooltipSection({
        dotClass: "tooltip-section-dot tooltip-dot-warning",
        title: "Need OAuth",
        count: allNeedsAuth.length,
        cardsHtml: allNeedsAuth
          .map((s) =>
            renderTooltipServer(
              s.name,
              s.info,
              s.server,
              "var(--status-warning, #fbbf24)",
            ),
          )
          .join(""),
      }),
    );
  }

  if (failedServers.length > 0 || notRunningServers.length > 0) {
    const sortedFailed = sortServerList(failedServers);
    const sortedNotRunning = sortServerList(notRunningServers);
    const allFailed = [...sortedFailed, ...sortedNotRunning];
    sections.push(
      renderTooltipSection({
        dotClass: "tooltip-section-dot tooltip-dot-error",
        title: "Failed",
        count: allFailed.length,
        cardsHtml: allFailed
          .map((s) =>
            renderTooltipServer(
              s.name,
              s.info,
              s.server,
              "var(--status-error, #f87171)",
            ),
          )
          .join(""),
      }),
    );
  }

  if (disabledServers.length > 0) {
    const sortedDisabled = sortServerList(disabledServers);
    sections.push(
      renderTooltipSection({
        dotClass: "tooltip-section-dot tooltip-dot-disabled",
        title: "Disabled",
        count: disabledCount,
        cardsHtml: sortedDisabled
          .map((s) =>
            renderTooltipServer(
              s.name,
              s.info,
              s.server,
              "var(--tooltip-status-disabled, var(--text-tertiary, #64748b))",
            ),
          )
          .join(""),
      }),
    );
  }

  if (tooltipContent) {
    if (sections.length > 0) {
      tooltipContent.innerHTML = `<div class="tooltip-sections">${sections.join("")}</div>`;
    } else {
      tooltipContent.innerHTML =
        '<span style="color: #94a3b8; font-size: 13px;">No MCP servers available</span>';
    }
  }
}

function setupMcpBadgeHover() {
  ensureMcpBadgePointerTracking();

  function shouldUseNativeTooltip() {
    return Boolean(window.electronAPI?.mcpTooltip?.show);
  }

  function showDomTooltip(layout, tooltip) {
    if (!layout || !tooltip) {
      return;
    }

    tooltip.style.left = `${layout.left}px`;
    tooltip.style.top = `${layout.top}px`;
    tooltip.style.display = "block";
    tooltip.style.opacity = "1";
    tooltip.style.visibility = "visible";
    tooltip.style.pointerEvents = "none";
  }

  function hideNativeTooltip() {
    mcpBadgeTooltipRequestId += 1;
    window.electronAPI?.mcpTooltip?.hide?.().catch(() => {});
  }

  function showNativeTooltip(layout, tooltip) {
    if (!layout || !tooltip) {
      return;
    }

    // The Chat tab's OWUI BrowserView can own focus while the parent window is
    // still active, so renderer-level focus is not a reliable gate here.
    // The main process already checks parentWindow.isFocused() before showing.
    if (document.hidden) {
      return;
    }

    const requestId = ++mcpBadgeTooltipRequestId;
    const theme =
      document.documentElement.getAttribute("data-theme") ||
      localStorage.getItem("theme") ||
      "dark";

    void window.electronAPI?.mcpTooltip
      ?.show({
        x: layout.left,
        y: layout.top,
        width: layout.width,
        height: layout.height,
        html: tooltip.innerHTML,
        theme,
      })
      ?.then(() => {
        if (requestId !== mcpBadgeTooltipRequestId || !mcpBadgeTooltipVisible) {
          hideNativeTooltip();
        }
      })
      .catch((error) => {
        console.warn("[MCP] Failed to show native tooltip:", error);
      });
  }

  function setTooltipVisible(visible, options = {}) {
    const tooltip = document.getElementById("mcp-tooltip");
    if (!tooltip) {
      return;
    }

    if (visible && shouldBlockMcpBadgeTooltipShow()) {
      return;
    }

    if (mcpBadgeTooltipVisible === visible) {
      return;
    }

    if (visible) {
      mcpBadgeHoverState = true;
      mcpBadgeTooltipVisible = true;
      if (shouldUseNativeTooltip()) {
        hideMcpBadgeTooltipShell();
        showNativeTooltip(options.layout, tooltip);
      } else {
        hideNativeTooltip();
        showDomTooltip(options.layout, tooltip);
      }
      return;
    }

    mcpBadgeHoverState = false;
    mcpBadgeTooltipVisible = false;
    hideMcpBadgeTooltipShell();
    hideNativeTooltip();
  }

  // Helper function to position tooltip
  function positionTooltip(badge, tooltip) {
    const rect = badge.getBoundingClientRect();

    // Temporarily show tooltip to get its dimensions
    const originalDisplay = tooltip.style.display;
    const originalVisibility = tooltip.style.visibility;
    tooltip.style.visibility = "hidden";
    tooltip.style.display = "block";

    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    // Align tooltip left edge with badge left edge
    let left = rect.left;

    // Ensure tooltip doesn't go off screen
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10;
    }

    tooltip.style.left = left + "px";
    tooltip.style.top = rect.bottom + 8 + "px";

    // Restore visibility
    tooltip.style.display = originalDisplay;
    tooltip.style.visibility = originalVisibility;

    return {
      left,
      top: rect.bottom + 8,
      width: tooltipWidth,
      height: tooltipHeight,
    };
  }

  // Use proper mouse events instead of polling
  const badge = document.getElementById("mcp-badge");
  const tooltip = document.getElementById("mcp-tooltip");

  if (badge && tooltip && !mcpBadgeHoverBound) {
    mcpBadgeHoverBound = true;
    badge.addEventListener("mouseenter", () => {
      if (shouldBlockMcpBadgeTooltipShow()) {
        return;
      }

      // Small delay to prevent accidental triggers
      mcpBadgeHoverDelayTimeout = setTimeout(() => {
        if (shouldBlockMcpBadgeTooltipShow()) {
          mcpBadgeHoverDelayTimeout = null;
          return;
        }

        const layout = positionTooltip(badge, tooltip);
        setTooltipVisible(true, { layout });
        mcpBadgeHoverDelayTimeout = null;
      }, MCP_TOOLTIP_SHOW_DELAY_MS);
    });

    badge.addEventListener("mouseleave", () => {
      if (mcpBadgeHoverDelayTimeout) {
        clearTimeout(mcpBadgeHoverDelayTimeout);
        mcpBadgeHoverDelayTimeout = null;
      }
      setTooltipVisible(false);
    });
  }

  // Click outside to close (only add once)
  if (!mcpClickListenerAdded) {
    mcpClickListenerAdded = true;
    document.addEventListener("click", (e) => {
      const badge = document.getElementById("mcp-badge");
      const tooltip = document.getElementById("mcp-tooltip");
      if (
        badge &&
        tooltip &&
        !badge.contains(e.target) &&
        !tooltip.contains(e.target)
      ) {
        setTooltipVisible(false);
      }
    });
  }

  if (!mcpTooltipVisibilityListenersAdded) {
    mcpTooltipVisibilityListenersAdded = true;
    window.addEventListener("blur", () => {
      setTooltipVisible(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        setTooltipVisible(false);
      }
    });
  }
}

// Fetch tools count for a specific server
async function fetchToolsCountForServer(serverId, options = {}) {
  const { forceRefresh = false } = options;
  const state = window.appState;
  try {
    const result = await window.electronAPI.getServerTools(serverId, {
      forceRefresh,
    });
    if (result.success) {
      if (!state.serverToolsCache) {
        state.serverToolsCache = {};
      }
      state.serverToolsCache[serverId] = {
        enabledCount: result.enabledCount,
        totalCount: result.totalCount,
      };
      console.log(
        `[Tools] Cached tools for ${serverId}: ${result.enabledCount}/${result.totalCount}`,
      );
      return true;
    }
  } catch (e) {
    console.warn(`[Tools] Failed to fetch tools for ${serverId}:`, e);
  }
  return false;
}

// Fetch tools count for all healthy servers
async function refreshToolsCountForHealthyServers(options = {}) {
  const { forceRender = false, forceRefresh = false, reason = "unknown" } = options;
  const state = window.appState;
  if (!state.healthStatus?.servers) return;
  const logToMain = window.electronAPI?.logToMain;
  const shouldRender =
    forceRender ||
    (state.activeTab === "control" && state.controlPlaneView === "mcp-servers");

  const healthyServerIds = (state.servers || [])
    .filter((server) => server && server.id)
    .filter((server) => isServerEnabled(server, state))
    .filter((server) => getServerHealthStatus(server.id) === "healthy")
    .map((server) => server.id)
    .sort();

  const healthySignature = healthyServerIds.join(",");
  const previousSignature = state.lastToolsRefreshHealthySignature || "";
  const signatureChanged = healthySignature !== previousSignature;
  const hasMissingCache = healthyServerIds.some(
    (serverId) => !state.serverToolsCache?.[serverId],
  );

  if (healthyServerIds.length === 0) {
    state.lastToolsRefreshHealthySignature = "";
    state.lastToolsRefreshAt = Date.now();
    return;
  }

  if (!shouldRender && !signatureChanged && !hasMissingCache && !forceRefresh) {
    return;
  }

  const now = Date.now();
  const lastRefreshAt = Number(state.lastToolsRefreshAt || 0);
  const minIntervalMs = shouldRender
    ? TOOLS_REFRESH_MIN_INTERVAL_MS
    : TOOLS_BACKGROUND_REFRESH_MIN_INTERVAL_MS;
  const elapsedMs = now - lastRefreshAt;
  if (!forceRefresh && !signatureChanged && elapsedMs < minIntervalMs) {
    if (logToMain) {
      logToMain("info", "[Tools] Skipping refresh (throttled)", {
        reason,
        healthyServers: healthyServerIds.length,
        elapsedMs,
        minIntervalMs,
      });
    }
    return;
  }

  if (state.toolsRefreshInProgress) {
    console.log("[Tools] Refresh already in progress, skipping");
    if (logToMain) {
      logToMain("info", "[Tools] Refresh already in progress, skipping");
    }
    return;
  }

  console.log(
    `[Tools] Refreshing tools count for ${healthyServerIds.length} healthy server(s)`,
  );
  if (logToMain) {
    logToMain("info", "[Tools] Refreshing tools count", {
      healthyServers: healthyServerIds.length,
      reason,
      signatureChanged,
      forceRefresh,
    });
  }

  const refreshStart = Date.now();
  state.toolsRefreshInProgress = true;
  try {
    const serverForceRefresh = forceRefresh || signatureChanged || hasMissingCache;
    const promises = healthyServerIds.map((serverId) =>
      fetchToolsCountForServer(serverId, { forceRefresh: serverForceRefresh }),
    );
    await Promise.all(promises);
    state.lastToolsRefreshAt = Date.now();
    state.lastToolsRefreshHealthySignature = healthySignature;
  } finally {
    state.toolsRefreshInProgress = false;
  }

  if (shouldRender) {
    updateMcpServersList();
  }
  const refreshMs = Date.now() - refreshStart;
  if (logToMain) {
    logToMain("info", "[Tools] Tools refresh completed", {
      durationMs: refreshMs,
      rendered: shouldRender,
      reason,
    });
  }
}

function getPostOperationReadinessStage(progressApi, readiness = {}) {
  if (!progressApi) {
    return String(readiness?.readiness_phase || readiness?.status || "waiting");
  }

  return progressApi.stageFromReadiness(readiness);
}

function shouldContinueWaitingForPostOperationReadiness(
  server,
  readinessPhase,
  readinessError,
  progressApi,
  pendingOperation,
) {
  const normalizedPhase = String(readinessPhase || "").trim().toLowerCase();

  if (
    !normalizedPhase ||
    normalizedPhase === "unknown" ||
    normalizedPhase === "starting" ||
    normalizedPhase === "checking" ||
    normalizedPhase === "checking_tokens"
  ) {
    return true;
  }

  if (POST_OPERATION_STABLE_READINESS_PHASES.has(normalizedPhase)) {
    return false;
  }

  if (!progressApi) {
    return false;
  }

  return progressApi.shouldPreferPendingStateForEnableBackendStatus(
    normalizedPhase,
    pendingOperation,
    {
      backendError: readinessError,
      expectsOAuth: serverExpectsOAuth(server, { error: readinessError }),
      allowNotConfiguredOverride: Boolean(server?.isConfigured),
    },
  );
}

/**
 * Refresh a single server's tool cache after an operation.
 * Health status itself is backend-authoritative via health-status-update events.
 * @param {string} serverId - The server ID to refresh
 * @param {object} options - Options: { waitForHealthy: boolean, maxWait: number }
 */
async function refreshServerAfterOperation(serverId, options = {}) {
  const {
    waitForHealthy = true,
    maxWait = 30000,
    onProgress = null,
  } = options;
  const state = window.appState;
  const progressApi = getMcpOperationProgressApi();
  let enabledCount = 0;
  let totalCount = 0;
  let lastReadinessPhase = "unknown";
  let lastReadinessError = null;
  const configuredServer = Array.isArray(state?.servers)
    ? state.servers.find((server) => server.id === serverId) || null
    : null;
  const serverLabel =
    configuredServer?.display_name || configuredServer?.name || serverId;
  const configuredDeploymentType = configuredServer?.deploymentType || "docker";
  const pendingOperation = getPendingServerOperation(serverId) || {
    targetEnabled: true,
    stage: "waiting",
    detail: "Waiting for readiness...",
  };

  console.log(`[Refresh] Starting post-operation refresh for ${serverId}`);

  try {
    // Step 1: Poll the canonical readiness endpoint first so we don't hammer
    // raw OpenAPI routes for servers that are still starting or waiting on OAuth.
    let healthy = false;
    let reachedStableReadiness = false;
    let reachedHardFailure = false;
    let lastTerminalStage = "waiting";
    let lastTerminalDetail = "Waiting for readiness...";
    const startTime = Date.now();
    if (typeof onProgress === "function") {
      onProgress({
        stage: "waiting",
        detail: "Waiting for readiness...",
      });
    }

    // Event-driven early wake: lifecycle transitions from the main process
    // can wake the polling loop immediately instead of waiting for the next
    // 2s tick.  This is the primary mechanism; the poll is the safety net.
    let lifecycleWakeResolve = null;
    let lifecycleUnsubscribe = null;
    const lifecycleHandler = (event) => {
      if (event.serverId === serverId && lifecycleWakeResolve) {
        lifecycleWakeResolve();
      }
    };
    if (window.electronAPI?.onServerLifecycleTransition) {
      const maybeUnsubscribe =
        window.electronAPI.onServerLifecycleTransition(lifecycleHandler);
      if (typeof maybeUnsubscribe === "function") {
        lifecycleUnsubscribe = maybeUnsubscribe;
      }
    }

    try {
      while (Date.now() - startTime < maxWait) {
        try {
          const readiness = await fetchServerReadiness(serverId);
          lastReadinessPhase =
            readiness?.readiness_phase || readiness?.status || "unknown";
          lastReadinessError = readiness?.error || null;
          applyReadinessToLocalHealthState(serverId, readiness);
          const nextStage = getPostOperationReadinessStage(progressApi, readiness);
          const nextDetail =
            lastReadinessError ||
            (progressApi
              ? progressApi.getStageMeta(nextStage).label
              : "Waiting for readiness...");
          if (typeof onProgress === "function") {
            onProgress({
              stage: nextStage,
              detail: nextDetail,
            });
          }

          const shouldProbeTools =
            !POST_OPERATION_NON_PROBE_READINESS_PHASES.has(lastReadinessPhase) &&
            lastReadinessPhase !== "disabled";
          if (shouldProbeTools) {
            const result = await window.electronAPI.getServerTools(serverId, {
              forceRefresh: true,
              deploymentType:
                readiness?.deployment_type || configuredDeploymentType,
            });

            if (result.success && result.totalCount > 0) {
              enabledCount = result.enabledCount || 0;
              totalCount = result.totalCount || 0;
              if (!state.serverToolsCache) {
                state.serverToolsCache = {};
              }
              state.serverToolsCache[serverId] = {
                enabledCount: result.enabledCount,
                totalCount: result.totalCount,
              };
              if (readiness?.healthy || lastReadinessPhase === "tool_ready") {
                healthy = true;
                lastTerminalStage = "healthy";
                lastTerminalDetail = `${result.enabledCount}/${result.totalCount} tools available`;
                setPendingServerOperation(serverId, {
                  serverId,
                  label: serverLabel,
                  targetEnabled: true,
                  stage: "healthy",
                  detail: lastTerminalDetail,
                });
                if (typeof onProgress === "function") {
                  onProgress({
                    stage: "healthy",
                    detail: lastTerminalDetail,
                  });
                }
                console.log(
                  `[Refresh] Server ${serverId} is healthy with ${result.enabledCount}/${result.totalCount} tools`,
                );
                break;
              }
              console.log(
                `[Refresh] ${serverId} reported ${result.enabledCount}/${result.totalCount} tools before readiness phase ${lastReadinessPhase}; waiting for canonical readiness...`,
              );
            }

            if (result.success && result.totalCount === 0) {
              console.log(
                `[Refresh] ${serverId} responded but has no tools yet; retrying...`,
              );
            } else if (!result.success) {
              console.log(
                `[Refresh] ${serverId} tool probe failed (${result.error || "unknown error"}); retrying...`,
              );
            }
          }

          const currentPendingOperation =
            getPendingServerOperation(serverId) || pendingOperation;
          const shouldContinueWaiting =
            shouldContinueWaitingForPostOperationReadiness(
              configuredServer,
              lastReadinessPhase,
              lastReadinessError,
              progressApi,
              currentPendingOperation,
            );

          if (
            POST_OPERATION_STABLE_READINESS_PHASES.has(lastReadinessPhase) &&
            !shouldContinueWaiting
          ) {
            reachedStableReadiness = true;
            lastTerminalStage = nextStage;
            lastTerminalDetail = nextDetail;
            setPendingServerOperation(serverId, {
              serverId,
              label: serverLabel,
              targetEnabled: true,
              stage: nextStage,
              detail: nextDetail,
            });
            console.log(
              `[Refresh] Server ${serverId} reached stable readiness phase ${lastReadinessPhase}; stopping refresh polling`,
            );
            break;
          }

          if (shouldContinueWaiting) {
            console.log(
              `[Refresh] Server ${serverId} readiness phase ${lastReadinessPhase}; waiting...`,
            );
          } else {
            reachedHardFailure = true;
            lastTerminalStage = nextStage;
            lastTerminalDetail = nextDetail;
            console.log(
              `[Refresh] Server ${serverId} reached hard readiness failure phase ${lastReadinessPhase}; stopping refresh polling`,
            );
            break;
          }
        } catch (e) {
          lastReadinessError = e?.message || String(e);
          if (typeof onProgress === "function") {
            onProgress({
              stage: "checking",
              detail: `Readiness probe failed: ${lastReadinessError}`,
            });
          }
          console.log(
            `[Refresh] Server ${serverId} readiness probe failed (${lastReadinessError}); retrying...`,
          );
        }

        if (!waitForHealthy) break;

        // Sleep for poll interval, but wake early on lifecycle transition
        await new Promise((resolve) => {
          lifecycleWakeResolve = resolve;
          setTimeout(resolve, POST_OPERATION_POLL_INTERVAL_MS);
        });
        lifecycleWakeResolve = null;
      }
    } finally {
      lifecycleWakeResolve = null;
      lifecycleUnsubscribe?.();
    }

    if (!healthy && waitForHealthy) {
      if (reachedStableReadiness) {
        console.log(
          `[Refresh] Server ${serverId} settled at readiness phase ${lastReadinessPhase} without becoming healthy`,
        );
      } else {
        console.warn(
          `[Refresh] Server ${serverId} did not become tool-ready within ${maxWait}ms (phase=${lastReadinessPhase}, error=${lastReadinessError || "none"})`,
        );
      }
      if (reachedStableReadiness) {
        if (typeof onProgress === "function") {
          onProgress({
            stage: lastTerminalStage,
            detail: lastTerminalDetail,
          });
        }
      } else if (!reachedHardFailure) {
        if (state?.healthStatus?.servers) {
          state.healthStatus.servers[serverId] = {
            ...(state.healthStatus.servers[serverId] || {}),
            configured: true,
            status: "starting",
            error: null,
            running: false,
            host: null,
            port: null,
          };
          state.healthStatus.summary = recalculateLocalHealthSummary(
            state.healthStatus.servers,
          );
        }
        setPendingServerOperation(serverId, {
          serverId,
          label: serverLabel,
          targetEnabled: true,
          stage: "continuing",
          detail: POST_OPERATION_BACKGROUND_CONTINUE_DETAIL,
        });
        if (typeof onProgress === "function") {
          onProgress({
            stage: "continuing",
            detail: POST_OPERATION_BACKGROUND_CONTINUE_DETAIL,
          });
        }
      } else if (state?.healthStatus?.servers) {
        const finalStatus = lastTerminalStage === "timeout" ? "timeout" : "failed";
        state.healthStatus.servers[serverId] = {
          ...(state.healthStatus.servers[serverId] || {}),
          configured: true,
          status: finalStatus,
          error:
            lastTerminalDetail ||
            lastReadinessError ||
            `Server did not become ready within ${Math.round(maxWait / 1000)} seconds`,
          running: false,
          host: null,
          port: null,
        };
        state.healthStatus.summary = recalculateLocalHealthSummary(
          state.healthStatus.servers,
        );
        if (typeof onProgress === "function") {
          onProgress({
            stage: lastTerminalStage,
            detail:
              lastTerminalDetail ||
              lastReadinessError ||
              `Server did not become ready within ${Math.round(maxWait / 1000)} seconds`,
          });
        }
      }
    }

    // Step 2: Update UI (status text still comes from backend health events)
    if (window.updateMcpServersList) window.updateMcpServersList();
    if (window.updateMcpBadgeWithHealth) window.updateMcpBadgeWithHealth();

    console.log(`[Refresh] Completed post-operation refresh for ${serverId}`);
    return { success: true, healthy, enabledCount, totalCount };
  } catch (error) {
    console.error(`[Refresh] Error refreshing ${serverId}:`, error);
    return { success: false, error: error.message };
  }
}

// Export all functions
window.updateMcpServersList = updateMcpServersList;
window.updateMcpBadge = updateMcpBadge;
window.updateMcpBadgeWithHealth = updateMcpBadgeWithHealth;
window.toggleMcpServer = toggleMcpServer;
window.getServerHealthStatus = getServerHealthStatus;
window.getHealthStatusColor = getHealthStatusColor;
window.setupMcpBadgeHover = setupMcpBadgeHover;
window.suppressMcpBadgeTooltip = suppressMcpBadgeTooltip;
window.showSaveButton = showSaveButton;
window.hideSaveButton = hideSaveButton;
window.saveMcpToggles = saveMcpToggles;
window.runOAuthFlowForSingleServer = runOAuthFlowForSingleServer;
window.runOAuthFlowForServer = runOAuthFlowForServer;
window.openServiceLogsPanel = openServiceLogsPanel;
window.showMcpServerLogs = showServerLogs;
window.markMcpServerPostSuccessStarting = markMcpServerPostSuccessStarting;
window.markMcpServerEnableAttemptStarted = markMcpServerEnableAttemptStarted;
window.markMcpServerOAuthAuthenticated = markMcpServerOAuthAuthenticated;
window.markMcpServerOAuthUnauthenticated = markMcpServerOAuthUnauthenticated;
window.reconcileMcpEnableTerminalState = reconcileEnableTerminalOperationState;
window.refreshServerAfterOperation = refreshServerAfterOperation;
window.applyLocalMcpToggleState = applyLocalToggleState;
// New V2 functions
window.initMcpSearchFilter = initMcpSearchFilter;
window.toggleServerDropdown = toggleServerDropdown;
window.closeAllDropdowns = closeAllDropdowns;
// Tool configuration functions
window.fetchToolsCountForServer = fetchToolsCountForServer;
window.refreshToolsCountForHealthyServers = refreshToolsCountForHealthyServers;
window.refreshLaggingServerReadiness = refreshLaggingServerReadiness;
window.syncPendingMcpOperationsFromHealthStatus =
  syncPendingMcpOperationsFromHealthStatus;
