(function () {
  const state = {
    clients: [],
    selectedIds: new Set(),
    results: [],
    busy: false,
    busyAction: "",
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function displayError(value, fallback = "Configuration failed") {
    const message = String(value || fallback)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || fallback;
    return message.length > 320 ? `${message.slice(0, 319)}…` : message;
  }

  function getElements() {
    return {
      modal: document.getElementById("host-mcp-bridge-config-modal"),
      closeBtn: document.getElementById("host-mcp-bridge-config-close-btn"),
      cancelBtn: document.getElementById("host-mcp-config-cancel-btn"),
      grid: document.getElementById("host-mcp-client-grid"),
      selectAllBtn: document.getElementById("host-mcp-config-select-all-btn"),
      configureBtn: document.getElementById("host-mcp-configure-btn"),
      removeBtn: document.getElementById("host-mcp-remove-config-btn"),
      status: document.getElementById("host-mcp-config-status"),
    };
  }

  function selectableClients() {
    return state.clients.filter((client) => client.selectable === true);
  }

  function selectedConfiguredClients() {
    return state.clients.filter((client) => state.selectedIds.has(client.id) && client.configured === true);
  }

  function updateSelectAllButton() {
    const { selectAllBtn } = getElements();
    if (!selectAllBtn) return;
    const selectable = selectableClients();
    const allSelected = selectable.length > 0 && selectable.every((client) => state.selectedIds.has(client.id));
    selectAllBtn.textContent = allSelected ? "Deselect all" : "Select all";
    selectAllBtn.setAttribute("aria-pressed", allSelected ? "true" : "false");
    selectAllBtn.disabled = state.busy || selectable.length === 0;
  }

  function updateConfigureButton() {
    const { configureBtn } = getElements();
    if (!configureBtn) return;
    const selectedCount = state.selectedIds.size;
    configureBtn.disabled = state.busy || selectedCount === 0;
    configureBtn.textContent = state.busyAction === "configure"
      ? "Configuring..."
      : selectedCount === 1
        ? "Configure 1 client"
        : `Configure ${selectedCount} clients`;
  }

  function updateRemoveButton() {
    const { removeBtn } = getElements();
    if (!removeBtn) return;
    const selectedCount = selectedConfiguredClients().length;
    const shouldShow = selectedCount > 0 || state.busyAction === "remove";
    removeBtn.hidden = !shouldShow;
    removeBtn.disabled = state.busy || selectedCount === 0;
    if (!shouldShow) {
      removeBtn.textContent = "Remove configuration";
      return;
    }
    removeBtn.textContent = state.busyAction === "remove"
      ? "Removing..."
      : selectedCount === 1
        ? "Remove 1 configuration"
        : `Remove ${selectedCount} configurations`;
  }

  function resultForClient(clientId) {
    return state.results.find((result) => result.clientId === clientId) || null;
  }

  function getClientInitials(displayName) {
    const parts = String(displayName || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "MC";
    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function renderClientLogo(client) {
    const initials = escapeHtml(getClientInitials(client.displayName));
    if (!client.logo) {
      return `<span class="host-mcp-client-logo-fallback">${initials}</span>`;
    }
    return `
      <img
        class="host-mcp-client-logo-img"
        src="${escapeHtml(client.logo)}"
        alt=""
        aria-hidden="true"
        onerror="this.hidden=true;this.parentElement.classList.add('logo-failed')"
      >
      <span class="host-mcp-client-logo-fallback">${initials}</span>
    `;
  }

  function renderStatusPill(client, statusClass, statusText) {
    if (client.configured === true && statusClass === "is-configured") {
      return `
        <button
          class="host-mcp-client-pill ${statusClass} host-mcp-client-pill-action"
          type="button"
          data-client-config-id="${escapeHtml(client.id)}"
          title="Open configuration file location"
          aria-label="Open ${escapeHtml(client.displayName)} configuration file location"
        >${escapeHtml(statusText)}</button>
      `;
    }
    const repairIndicator = statusClass === "is-repair-needed"
      ? '<span class="host-mcp-client-pill-alert" aria-hidden="true">!</span>'
      : "";
    return `<span class="host-mcp-client-pill ${statusClass}">${repairIndicator}${escapeHtml(statusText)}</span>`;
  }

  function renderCards() {
    const { grid } = getElements();
    if (!grid) return;
    if (!state.clients.length) {
      grid.innerHTML = '<div class="host-mcp-config-empty">No supported MCP clients were found.</div>';
      return;
    }
    grid.innerHTML = state.clients.map((client) => {
      const selected = state.selectedIds.has(client.id);
      const disabled = client.selectable !== true;
      const result = resultForClient(client.id);
      let errorText = client.configError ? displayError(client.configError) : "";
      let statusText = client.statusText || (client.detected ? "Detected" : "Not found");
      let statusClass = client.configured
        ? "is-configured"
        : client.status === "needs_repair"
          ? "is-repair-needed"
          : client.status === "config_error"
            ? "is-error"
            : client.detected ? "is-detected" : "is-missing";
      if (result && result.success !== true) {
        statusText = "Failed";
        statusClass = "is-error";
        errorText = displayError(result.error);
      }
      const repairNeeded = statusClass === "is-repair-needed";
      return `
        <div
          class="host-mcp-client-card ${selected ? "selected" : ""} ${repairNeeded ? "needs-repair" : ""} ${disabled ? "disabled-state" : ""}"
          data-client-id="${escapeHtml(client.id)}"
          role="button"
          tabindex="${disabled ? "-1" : "0"}"
          aria-pressed="${selected ? "true" : "false"}"
          ${disabled ? 'aria-disabled="true"' : ""}
        >
          <span class="host-mcp-client-logo" aria-hidden="true">
            ${renderClientLogo(client)}
          </span>
          <span class="host-mcp-client-copy">
            <span class="host-mcp-client-name">${escapeHtml(client.displayName)}</span>
            <span class="host-mcp-client-meta">
              ${renderStatusPill(client, statusClass, statusText)}
            </span>
            ${errorText ? `<span class="host-mcp-client-error" title="${escapeHtml(errorText)}">${escapeHtml(errorText)}</span>` : ""}
          </span>
          <span class="host-mcp-client-check" aria-hidden="true">
            ${selected ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ""}
          </span>
        </div>
      `;
    }).join("");
    grid.querySelectorAll(".host-mcp-client-card").forEach((card) => {
      const toggleCard = () => {
        const clientId = card.dataset.clientId;
        if (!clientId || card.getAttribute("aria-disabled") === "true" || state.busy) return;
        if (state.selectedIds.has(clientId)) {
          state.selectedIds.delete(clientId);
        } else {
          state.selectedIds.add(clientId);
        }
        render();
      };
      card.addEventListener("click", toggleCard);
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleCard();
      });
    });
    grid.querySelectorAll(".host-mcp-client-pill-action").forEach((pill) => {
      pill.addEventListener("click", (event) => {
        event.stopPropagation();
        const clientId = pill.dataset.clientConfigId;
        if (clientId) {
          void revealClientConfig(clientId);
        }
      });
    });
  }

  function render() {
    renderCards();
    updateSelectAllButton();
    updateConfigureButton();
    updateRemoveButton();
  }

  function setStatus(message, tone = "") {
    const { status } = getElements();
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", tone === "error");
    status.classList.toggle("success", tone === "success");
  }

  async function loadClients(options = {}) {
    const previousSelectedIds = new Set(state.selectedIds);
    state.busy = true;
    state.busyAction = "detect";
    state.results = [];
    setStatus("Detecting MCP clients...");
    render();
    try {
      const result = await window.electronAPI?.hostMcpBridgeConfigDetect?.();
      if (!result || result.success !== true) {
        throw new Error(displayError(result?.error, "Detection failed"));
      }
      state.clients = Array.isArray(result.clients) ? result.clients : [];
      const nextSelected = state.clients
        .filter((client) => client.selectable === true)
        .filter((client) => options.preserveSelection === true ? previousSelectedIds.has(client.id) : true)
        .map((client) => client.id);
      state.selectedIds = new Set(nextSelected);
      setStatus(options.finalStatus || "Select clients to configure or remove.", options.finalTone || "");
    } catch (error) {
      state.clients = [];
      state.selectedIds.clear();
      setStatus(displayError(error?.message, "Detection failed"), "error");
    } finally {
      state.busy = false;
      state.busyAction = "";
      render();
    }
  }

  function closeModal() {
    const { modal } = getElements();
    if (!modal) return;
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
  }

  async function openModal() {
    const { modal } = getElements();
    if (!modal) return;
    modal.classList.add("visible");
    modal.setAttribute("aria-hidden", "false");
    if (state.busy) return;
    await loadClients();
  }

  async function configureSelected() {
    if (state.busy || state.selectedIds.size === 0) return;
    state.busy = true;
    state.busyAction = "configure";
    state.results = [];
    setStatus("Starting bridge and configuring selected clients...");
    render();
    try {
      const result = await window.electronAPI?.hostMcpBridgeConfigureClients?.({
        clientIds: [...state.selectedIds],
      });
      const operationResults = Array.isArray(result?.results) ? result.results : [];
      state.results = operationResults;
      const restartHint = "You may need to restart configured clients for changes to take effect.";
      const successfulRestartRequired = result?.success === true && operationResults.some(
        (item) => item?.success === true && item?.restartRequired === true,
      );
      const failureDetail = displayError(
        result?.error,
        "Some clients could not be configured. Review the errors below.",
      );
      const message = result?.success
        ? `Bridge is running. Configuration complete.${successfulRestartRequired ? ` ${restartHint}` : ""}`
        : `Bridge setup did not complete. ${failureDetail}`;
      const tone = result?.success ? "success" : "error";
      state.busy = false;
      state.busyAction = "";
      await loadClients({ preserveSelection: true, finalStatus: message, finalTone: tone });
      state.results = operationResults.filter((item) => item.success !== true);
    } catch (error) {
      state.results = [];
      setStatus(displayError(error?.message, "Configuration failed"), "error");
    } finally {
      state.busy = false;
      state.busyAction = "";
      render();
    }
  }

  async function removeSelectedConfigurations() {
    if (state.busy) return;
    const configuredClients = selectedConfiguredClients();
    if (configuredClients.length === 0) return;
    state.busy = true;
    state.busyAction = "remove";
    state.results = [];
    setStatus("Removing selected configurations...");
    render();
    try {
      const result = await window.electronAPI?.hostMcpBridgeRemoveClientConfigs?.({
        clientIds: configuredClients.map((client) => client.id),
      });
      const operationResults = Array.isArray(result?.results) ? result.results : [];
      const message = result?.success
        ? "Selected configurations removed."
        : displayError(result?.error, "Some configurations could not be removed.");
      const tone = result?.success ? "success" : "error";
      state.busy = false;
      state.busyAction = "";
      await loadClients({ preserveSelection: true, finalStatus: message, finalTone: tone });
      state.results = operationResults.filter((item) => item.success !== true);
    } catch (error) {
      state.results = [];
      setStatus(displayError(error?.message, "Configuration removal failed"), "error");
    } finally {
      state.busy = false;
      state.busyAction = "";
      render();
    }
  }

  async function revealClientConfig(clientId) {
    if (state.busy) return;
    setStatus("Opening configuration location...");
    try {
      const result = await window.electronAPI?.hostMcpBridgeRevealClientConfig?.({ clientId });
      if (!result || result.success !== true) {
        throw new Error(displayError(result?.error, "Failed to open configuration location"));
      }
      setStatus("Configuration location opened.", "success");
    } catch (error) {
      setStatus(displayError(error?.message, "Failed to open configuration location"), "error");
    }
  }

  function toggleSelectAll() {
    const selectable = selectableClients();
    const allSelected = selectable.length > 0 && selectable.every((client) => state.selectedIds.has(client.id));
    if (allSelected) {
      selectable.forEach((client) => state.selectedIds.delete(client.id));
    } else {
      selectable.forEach((client) => state.selectedIds.add(client.id));
    }
    render();
  }

  function handleDocumentKeydown(event) {
    const { modal } = getElements();
    if (event.key !== "Escape" || !modal?.classList.contains("visible")) {
      return;
    }
    event.preventDefault();
    closeModal();
  }

  function initHostMcpBridgeConfigModal() {
    const { modal, closeBtn, cancelBtn, selectAllBtn, configureBtn, removeBtn } = getElements();
    if (!modal) return;
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);
    selectAllBtn?.addEventListener("click", toggleSelectAll);
    configureBtn?.addEventListener("click", configureSelected);
    removeBtn?.addEventListener("click", removeSelectedConfigurations);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });
    document.addEventListener("keydown", handleDocumentKeydown);
  }

  document.addEventListener("DOMContentLoaded", initHostMcpBridgeConfigModal);
  window.openHostMcpBridgeConfigModal = openModal;
})();
