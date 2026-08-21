// Updates component: background preparation + prompt-on-ready flow.

(function() {
  const state = window.appState;
  let prepListenersRegistered = false;
  let menuUpdateListenerRegistered = false;
  let forcedPreparationUpdateKey = null;
  let pendingManualUpdateAction = null;
  let autoInstallInFlightUpdateKey = null;
  let updateTooltipListenersRegistered = false;
  let updateTooltipShowTimeout = null;
  let updateTooltipVisible = false;
  let updateTooltipRequestId = 0;

  function normalizeChecksumValue(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  function getChecksumIdentity(checksum) {
    if (!checksum || typeof checksum !== "object") return null;
    const priority = ["sha256", "sha512", "sha1", "md5"];
    for (const algorithm of priority) {
      const value = normalizeChecksumValue(checksum[algorithm]);
      if (value) return { algorithm, value };
    }
    return null;
  }

  function buildUpdateKey(updateInfo) {
    if (!updateInfo || !updateInfo.latestBuildNumber) return null;
    if (typeof updateInfo.updateKey === "string" && updateInfo.updateKey.trim()) {
      return updateInfo.updateKey.trim();
    }

    const channel = updateInfo.updateChannel || "unknown";
    const checksumIdentity = getChecksumIdentity(updateInfo.checksum);
    if (checksumIdentity) {
      return `${updateInfo.latestBuildNumber}|${checksumIdentity.algorithm}:${checksumIdentity.value}|${channel}`;
    }

    const lastModified = updateInfo.lastModified || "unknown";
    return `${updateInfo.latestBuildNumber}|legacy-lastModified:${lastModified}|${channel}`;
  }

  function getCurrentUpdateKey() {
    return buildUpdateKey(state.updateInfo);
  }

  function resolveBuildNumber(updateInfo) {
    if (!updateInfo || typeof updateInfo.latestBuildNumber !== "string") return null;
    const buildNumber = updateInfo.latestBuildNumber.trim();
    return buildNumber || null;
  }

  function buildUpdateToken(updateKey, updateInfo) {
    if (updateKey) return `key:${updateKey}`;
    const buildNumber = resolveBuildNumber(updateInfo);
    if (!buildNumber) return null;
    return `build:${buildNumber}`;
  }

  function isPendingManualActionForCurrentUpdate(updateKey, updateInfo) {
    if (!pendingManualUpdateAction) return false;
    if (pendingManualUpdateAction.updateKey && updateKey) {
      return pendingManualUpdateAction.updateKey === updateKey;
    }
    const pendingBuildNumber = pendingManualUpdateAction.latestBuildNumber || null;
    const currentBuildNumber = resolveBuildNumber(updateInfo);
    return Boolean(
      pendingBuildNumber &&
      currentBuildNumber &&
      pendingBuildNumber === currentBuildNumber,
    );
  }

  function normalizePrepStatus(status) {
    return {
      state: status?.state || "idle",
      updateKey: status?.updateKey || null,
      phase: status?.phase || "idle",
      message: status?.message || "",
      phasePercent: Number.isFinite(status?.phasePercent)
        ? status.phasePercent
        : Number.isFinite(status?.overallPercent)
          ? status.overallPercent
          : 0,
      phaseDetail: status?.phaseDetail || "",
      overallPercent: Number.isFinite(status?.overallPercent)
        ? status.overallPercent
        : 0,
      error: status?.error || null,
      logPath: status?.logPath || null,
      download: {
        totalBytes: Number(status?.download?.totalBytes || 0),
        downloadedBytes: Number(status?.download?.downloadedBytes || 0),
        percent: Number(status?.download?.percent || 0),
      },
      docker: {
        manifestCount: Number(status?.docker?.manifestCount || 0),
        sourceManifestPath: status?.docker?.sourceManifestPath || null,
        totalImages: Number(status?.docker?.totalImages || 0),
        completed: Number(status?.docker?.completed || 0),
        pulled: Number(status?.docker?.pulled || 0),
        failed: Number(status?.docker?.failed || 0),
        failedImages: Array.isArray(status?.docker?.failedImages)
          ? status.docker.failedImages
          : [],
        preparedAt: status?.docker?.preparedAt || null,
        images: status?.docker?.images || {},
      },
      prepared: status?.prepared || null,
    };
  }

  function isPrepForCurrentUpdate() {
    const updateKey = getCurrentUpdateKey();
    return Boolean(
      updateKey &&
      state.updatePrep &&
      state.updatePrep.updateKey === updateKey,
    );
  }

  function isPrepReadyForCurrentUpdate() {
    return Boolean(
      isPrepForCurrentUpdate() &&
      state.updatePrep.state === "ready" &&
      state.updatePrep.prepared &&
      state.updatePrep.prepared.ready === true,
    );
  }

  function attachPreparedArtifactsIfReady() {
    if (!state.updateInfo || !isPrepReadyForCurrentUpdate()) {
      return;
    }
    state.updateInfo.prepared = {
      ...state.updatePrep.prepared,
      ready: true,
    };
  }

  function getDisplayChannel(updateInfo) {
    if (["stable", "beta", "dev", "custom"].includes(updateInfo?.updateChannelDisplay)) {
      return updateInfo.updateChannelDisplay;
    }

    if (updateInfo?.updateChannel) {
      const channelInfo = window.releaseChannelHelpers?.resolveReleaseChannelPackage?.(
        updateInfo.updateChannel,
        { allowLegacy: true },
      );
      return channelInfo?.kind || "stable";
    }

    return "stable";
  }

  function setButtonChannelClass(updateButton) {
    if (!updateButton) return;

    const displayChannel = getDisplayChannel(state.updateInfo);
    updateButton.classList.remove(
      "channel-stable",
      "channel-beta",
      "channel-dev",
      "channel-custom",
    );
    updateButton.classList.add(`channel-${displayChannel}`);
  }

  function getTooltipTheme() {
    return (
      document.documentElement.getAttribute("data-theme") ||
      localStorage.getItem("theme") ||
      "dark"
    );
  }

  function getPrepPhasePercent(prep) {
    const rawPercent = Number.isFinite(prep?.phasePercent)
      ? prep.phasePercent
      : Number.isFinite(prep?.overallPercent)
        ? prep.overallPercent
        : 0;
    return Math.max(0, Math.min(100, Math.round(rawPercent)));
  }

  function getPrepDetailText(prep) {
    if (!prep || typeof prep !== "object") {
      return "Waiting to start...";
    }
    if (prep.error) {
      return prep.logPath
        ? `See logs: ${prep.logPath}`
        : "Update preparation failed";
    }
    if (typeof prep.phaseDetail === "string" && prep.phaseDetail.trim()) {
      return prep.phaseDetail.trim();
    }
    if (prep.phase === "docker" && Number(prep?.docker?.totalImages) > 0) {
      return `${Number(prep.docker.completed || 0)}/${Number(prep.docker.totalImages || 0)} images prepared`;
    }
    if (prep.phase === "download" && Number(prep?.download?.totalBytes) > 0) {
      return `${Number(prep.download.percent || 0)}% of payload downloaded`;
    }
    return prep.message || "Preparing update...";
  }

  function getPrepHeaderText(prep) {
    const percent = getPrepPhasePercent(prep);
    if (percent > 0 && percent < 100) {
      return `Preparing ${percent}%`;
    }
    if (prep?.state === "ready") {
      return "Update ready";
    }
    return "Preparing update...";
  }

  function getPrepHeaderDescription(prep) {
    const message = typeof prep?.message === "string" ? prep.message.trim() : "";
    const detail = getPrepDetailText(prep);
    if (message && detail && detail !== message) {
      return `${message} ${detail}`;
    }
    return message || detail || "Preparing update";
  }

  function isMissingChecksumPrepFailure(error) {
    return (
      typeof error === "string" &&
      error.includes("Update payload checksum metadata is missing")
    );
  }

  function shouldSuppressPrepFailureInHeader(prep) {
    return Boolean(
      prep &&
      prep.state === "failed" &&
      isMissingChecksumPrepFailure(prep.error),
    );
  }

  function showDomUpdateTooltip(layout, tooltipEl) {
    if (!layout || !tooltipEl) return;

    tooltipEl.style.left = `${Math.round(layout.left)}px`;
    tooltipEl.style.top = `${Math.round(layout.top)}px`;
    tooltipEl.style.display = "block";
    tooltipEl.style.opacity = "1";
    tooltipEl.style.visibility = "visible";
    tooltipEl.style.pointerEvents = "none";
  }

  function hideUpdateTooltipShell() {
    const tooltipEl = document.getElementById("update-prep-tooltip");
    if (!tooltipEl) return;

    tooltipEl.style.display = "none";
    tooltipEl.style.opacity = "0";
    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.pointerEvents = "none";
  }

  function shouldUseNativeUpdateTooltip() {
    return Boolean(window.electronAPI?.updatePrepTooltip?.show);
  }

  function hideNativeUpdateTooltip() {
    updateTooltipRequestId += 1;
    window.electronAPI?.updatePrepTooltip?.hide?.().catch(() => {});
  }

  function showNativeUpdateTooltip(layout, tooltipEl) {
    if (!layout || !tooltipEl) return;

    // The Chat tab's OWUI BrowserView can own focus while the parent window is
    // still active, so renderer-level focus is not a reliable gate here.
    // The main process already checks parentWindow.isFocused() before showing.
    if (document.hidden) return;

    const requestId = ++updateTooltipRequestId;
    void window.electronAPI?.updatePrepTooltip
      ?.show({
        x: layout.left,
        y: layout.top,
        width: layout.width,
        height: layout.height,
        html: tooltipEl.innerHTML,
        theme: getTooltipTheme(),
      })
      ?.then(() => {
        if (requestId !== updateTooltipRequestId || !updateTooltipVisible) return;
      })
      .catch((error) => {
        console.warn("[Update] Failed to show native prep tooltip:", error);
      });
  }

  function clearUpdateTooltipTimer() {
    if (updateTooltipShowTimeout) {
      clearTimeout(updateTooltipShowTimeout);
      updateTooltipShowTimeout = null;
    }
  }

  function positionUpdateTooltip(updateButton, tooltipEl) {
    const rect = updateButton.getBoundingClientRect();
    const originalVisibility = tooltipEl.style.visibility;
    const originalDisplay = tooltipEl.style.display;

    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.display = "block";

    const tooltipRect = tooltipEl.getBoundingClientRect();
    const tooltipWidth = Math.max(
      280,
      Math.round(tooltipRect.width || 0),
      Math.round(tooltipEl.offsetWidth || 0),
      Math.round(tooltipEl.scrollWidth || 0),
      360,
    );
    const tooltipHeight = Math.max(
      1,
      Math.round(tooltipRect.height || 0),
      Math.round(tooltipEl.offsetHeight || 0),
      Math.round(tooltipEl.scrollHeight || 0),
    );
    const margin = 10;

    let left = rect.left;
    if (left < margin) left = margin;
    if (left + tooltipWidth > window.innerWidth - margin) {
      left = window.innerWidth - tooltipWidth - margin;
    }

    let top = rect.bottom + 8;
    if (top + tooltipHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - tooltipHeight - 8);
    }

    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;

    tooltipEl.style.display = originalDisplay;
    tooltipEl.style.visibility = originalVisibility;
    return {
      left,
      top,
      width: tooltipWidth,
      height: tooltipHeight,
    };
  }

  function hideUpdateTooltip() {
    clearUpdateTooltipTimer();
    updateTooltipVisible = false;
    hideUpdateTooltipShell();
    hideNativeUpdateTooltip();
  }

  function showUpdateTooltip() {
    const updateButton = document.getElementById("update-button");
    const tooltipEl = document.getElementById("update-prep-tooltip");
    if (!updateButton || !tooltipEl) return;
    if (tooltipEl.classList.contains("hidden")) return;
    if (!updateButton.classList.contains("preparing")) return;

    const layout = positionUpdateTooltip(updateButton, tooltipEl);
    if (shouldUseNativeUpdateTooltip()) {
      hideUpdateTooltipShell();
      showNativeUpdateTooltip(layout, tooltipEl);
    } else {
      hideNativeUpdateTooltip();
      showDomUpdateTooltip(layout, tooltipEl);
      tooltipEl.style.zIndex = "10000";
    }
    updateTooltipVisible = true;
  }

  function scheduleShowUpdateTooltip() {
    clearUpdateTooltipTimer();
    updateTooltipShowTimeout = setTimeout(() => {
      showUpdateTooltip();
    }, 200);
  }

  function registerUpdateTooltipListeners() {
    if (updateTooltipListenersRegistered) return;
    const updateButton = document.getElementById("update-button");
    const tooltipEl = document.getElementById("update-prep-tooltip");
    if (!updateButton || !tooltipEl) return;

    updateTooltipListenersRegistered = true;

    updateButton.addEventListener("mouseenter", () => {
      scheduleShowUpdateTooltip();
    });
    updateButton.addEventListener("mouseleave", () => {
      hideUpdateTooltip();
    });
    updateButton.addEventListener("focusin", () => {
      scheduleShowUpdateTooltip();
    });
    updateButton.addEventListener("focusout", () => {
      hideUpdateTooltip();
    });

    window.addEventListener("resize", () => {
      if (updateTooltipVisible) {
        showUpdateTooltip();
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        if (updateTooltipVisible) {
          showUpdateTooltip();
        }
      },
      true,
    );

    document.addEventListener("click", (event) => {
      if (!updateButton.contains(event.target)) {
        hideUpdateTooltip();
      }
    });

    window.addEventListener("blur", () => {
      hideUpdateTooltip();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hideUpdateTooltip();
      }
    });
  }

  function renderPreparationTooltip() {
    const tooltip = document.getElementById("update-prep-tooltip");
    const progressFill = document.getElementById("update-prep-overall-progress");
    const phaseText = document.getElementById("update-prep-phase-text");
    const percentText = document.getElementById("update-prep-percent-text");
    const detailText = document.getElementById("update-prep-detail-text");
    if (!tooltip || !progressFill || !phaseText || !percentText || !detailText) return;

    const prep = state.updatePrep || {};
    const percent = getPrepPhasePercent(prep);

    progressFill.style.width = `${percent}%`;
    phaseText.textContent = prep.error
      ? `Failed: ${prep.error}`
      : prep.message || "Preparing update...";
    percentText.textContent = `${percent}%`;
    detailText.textContent = getPrepDetailText(prep);

    if (updateTooltipVisible) {
      showUpdateTooltip();
    }
  }

  function showUpdateButton() {
    const updateButton = document.getElementById("update-button");
    if (!updateButton) return;
    const updateButtonShell = updateButton.closest(".update-button-shell");
    if (updateButtonShell) {
      updateButtonShell.classList.remove("hidden");
    }
    setButtonChannelClass(updateButton);
    updateButton.classList.remove("hidden");
  }

  function hideUpdateButton() {
    const updateButton = document.getElementById("update-button");
    if (!updateButton) return;
    const updateButtonShell = updateButton.closest(".update-button-shell");
    if (updateButtonShell) {
      updateButtonShell.classList.add("hidden");
    }
    updateButton.classList.add("hidden");
    hideUpdateTooltip();
  }

  function renderUpdateButton() {
    const updateButton = document.getElementById("update-button");
    const labelEl = document.getElementById("update-button-label");
    const spinnerEl = document.getElementById("update-prep-spinner");
    const tooltipEl = document.getElementById("update-prep-tooltip");
    if (!updateButton || !labelEl || !spinnerEl || !tooltipEl) return;

    registerUpdateTooltipListeners();

    if (!state.updateAvailable || !state.updateInfo) {
      hideUpdateButton();
      return;
    }

    showUpdateButton();
    renderPreparationTooltip();

    const prep = state.updatePrep || {};
    const prepForThisUpdate = isPrepForCurrentUpdate();
    updateButton.classList.remove("prep-status-preparing", "prep-status-failed");

    if (prepForThisUpdate && shouldSuppressPrepFailureInHeader(prep)) {
      updateButton.classList.remove("pulsing-glow", "preparing");
      spinnerEl.classList.add("hidden");
      tooltipEl.classList.add("hidden");
      hideUpdateButton();
      return;
    }

    if (prepForThisUpdate && prep.state === "preparing") {
      updateButton.classList.remove("pulsing-glow");
      updateButton.classList.add("preparing");
      updateButton.classList.add("prep-status-preparing");
      spinnerEl.classList.remove("hidden");
      tooltipEl.classList.remove("hidden");
      labelEl.textContent = getPrepHeaderText(prep);
      const headerDescription = getPrepHeaderDescription(prep);
      updateButton.setAttribute("aria-label", headerDescription);
      updateButton.title = headerDescription;
      if (updateButton.matches(":hover") || updateButton.matches(":focus-within")) {
        showUpdateTooltip();
      } else {
        hideUpdateTooltip();
      }
      return;
    }

    if (prepForThisUpdate && prep.state === "failed") {
      updateButton.classList.remove("pulsing-glow");
      updateButton.classList.add("preparing");
      updateButton.classList.add("prep-status-failed");
      spinnerEl.classList.remove("hidden");
      tooltipEl.classList.remove("hidden");
      labelEl.textContent = "Update preparation failed";
      updateButton.setAttribute("aria-label", getPrepHeaderDescription(prep));
      updateButton.title = getPrepHeaderDescription(prep);
      if (updateButton.matches(":hover") || updateButton.matches(":focus-within")) {
        showUpdateTooltip();
      } else {
        hideUpdateTooltip();
      }
      return;
    }

    updateButton.classList.add("pulsing-glow");
    updateButton.classList.remove("preparing");
    spinnerEl.classList.add("hidden");
    tooltipEl.classList.add("hidden");
    labelEl.textContent = "New Update Available!";
    updateButton.setAttribute("aria-label", "New update available");
    updateButton.removeAttribute("title");
    hideUpdateTooltip();
  }

  function setPrepStatus(status) {
    state.updatePrep = normalizePrepStatus(status);
    attachPreparedArtifactsIfReady();
    renderUpdateButton();
    maybeHandleReadyUpdateAction();
  }

  function setupPreparationListeners() {
    if (prepListenersRegistered || !window.electronAPI) return;
    prepListenersRegistered = true;

    if (typeof window.electronAPI.onUpdatePreparationStatus === "function") {
      window.electronAPI.onUpdatePreparationStatus((status) => {
        setPrepStatus(status);
      });
    }

    // Optional direct channels for richer live updates.
    if (typeof window.electronAPI.onUpdatePreparationDockerPull === "function") {
      window.electronAPI.onUpdatePreparationDockerPull((data) => {
        if (!isPrepForCurrentUpdate()) return;
        const prep = state.updatePrep || normalizePrepStatus({});
        const imageKey = data?.image || data?.label;
        if (!imageKey) return;
        prep.docker.images[imageKey] = {
          ...(prep.docker.images[imageKey] || {}),
          ...data,
        };
        state.updatePrep = prep;
        renderUpdateButton();
      });
    }

    if (typeof window.electronAPI.onUpdatePreparationBuildProgress === "function") {
      window.electronAPI.onUpdatePreparationBuildProgress((data) => {
        if (!isPrepForCurrentUpdate()) return;
        if (data?.message) {
          state.updatePrep.message = data.message;
        }
        renderUpdateButton();
      });
    }
  }

  async function hydratePreparationStatus() {
    if (!window.electronAPI?.getUpdatePreparationStatus) return;
    try {
      const result = await window.electronAPI.getUpdatePreparationStatus();
      if (result?.success && result.status) {
        setPrepStatus(result.status);
      }
    } catch (error) {
      console.warn("[Update] Failed to hydrate preparation status:", error.message);
    }
  }

  async function startPreparationForUpdate(updateInfo, options = {}) {
    if (!window.electronAPI?.startUpdatePreparation || !updateInfo) return;

    try {
      const prepResult = await window.electronAPI.startUpdatePreparation(updateInfo, options);
      if (prepResult?.success === false) {
        const prepError = prepResult.error || "Unknown error";
        if (isMissingChecksumPrepFailure(prepError)) {
          console.info("[Update] Background preparation deferred:", prepError);
        } else {
          console.error("[Update] Failed to start background preparation:", prepError);
        }
        setPrepStatus({
          state: "failed",
          updateKey: buildUpdateKey(updateInfo),
          phase: "idle",
          message: "Update preparation failed",
          phasePercent: 0,
          phaseDetail: "Update preparation failed",
          overallPercent: 0,
          error: prepError,
          logPath: state.updatePrep?.logPath || null,
          download: state.updatePrep?.download || {
            totalBytes: 0,
            downloadedBytes: 0,
            percent: 0,
          },
          docker: state.updatePrep?.docker || {
            manifestCount: 0,
            sourceManifestPath: null,
            totalImages: 0,
            completed: 0,
            pulled: 0,
            failed: 0,
            failedImages: [],
            preparedAt: null,
            images: {},
          },
          prepared: null,
        });
        return;
      }
      if (prepResult?.status) {
        setPrepStatus(prepResult.status);
      }
    } catch (error) {
      console.error("[Update] Failed to start background preparation:", error);
    }
  }

  function setupMenuUpdateListener() {
    if (menuUpdateListenerRegistered || !window.electronAPI?.onMenuUpdateRequested) return;
    menuUpdateListenerRegistered = true;

    window.electronAPI.onMenuUpdateRequested(async (payload) => {
      const updateInfo = payload?.updateInfo;
      if (!updateInfo) {
        console.warn("[Update] Ignoring menu update request with missing update metadata");
        return;
      }

      const updateKey = buildUpdateKey(updateInfo);
      const forcePreparation = payload?.forcePreparation === true;
      const postPreparationAction =
        payload?.postPreparationAction === "auto-install" ? "auto-install" : "prompt";

      state.updateAvailable = true;
      state.updateInfo = updateInfo;
      state.updatePromptedKey = null;
      pendingManualUpdateAction = {
        updateKey: updateKey || null,
        latestBuildNumber: resolveBuildNumber(updateInfo),
        postPreparationAction,
        started: false,
      };
      if (updateKey) {
        forcedPreparationUpdateKey = updateKey;
      }

      markPreparingForUpdate(updateInfo);
      setButtonChannelClass(document.getElementById("update-button"));
      renderUpdateButton();

      await startPreparationForUpdate(updateInfo, { force: forcePreparation });
      attachPreparedArtifactsIfReady();
      renderUpdateButton();
      maybeHandleReadyUpdateAction();
    });
  }

  function markPreparingForUpdate(updateInfo) {
    const updateKey = buildUpdateKey(updateInfo);
    if (!updateKey) return;

    state.updatePrep = normalizePrepStatus({
      state: "preparing",
      updateKey,
      phase: "queued",
      message: "Preparing update...",
      phasePercent: 1,
      phaseDetail: "Preparing update...",
      overallPercent: 1,
      error: null,
      logPath: null,
      download: {
        totalBytes: 0,
        downloadedBytes: 0,
        percent: 0,
      },
      docker: {
        manifestCount: 0,
        sourceManifestPath: null,
        totalImages: 0,
        completed: 0,
        pulled: 0,
        failed: 0,
        failedImages: [],
        preparedAt: null,
        images: {},
      },
      prepared: null,
    });
  }

  async function resumeSuppressedAutoInstall(result) {
    if (
      result?.suppressed !== true ||
      result?.reason !== "manual-auto-install"
    ) {
      return false;
    }

    const updateKey = getCurrentUpdateKey();
    const currentUpdateToken = buildUpdateToken(updateKey, state.updateInfo);
    try {
      const startResult = await window.electronAPI.startUpdateFromMainWindow(state.updateInfo);
      if (!startResult?.success) {
        console.error(
          "[Update] Failed to resume suppressed auto-install:",
          startResult?.error || "Unknown error",
        );
        return false;
      }

      autoInstallInFlightUpdateKey = currentUpdateToken;
      if (updateKey) {
        state.updatePromptedKey = updateKey;
      }
      if (isPendingManualActionForCurrentUpdate(updateKey, state.updateInfo)) {
        pendingManualUpdateAction = null;
      }
      if (forcedPreparationUpdateKey === updateKey) {
        forcedPreparationUpdateKey = null;
      }
      return true;
    } catch (error) {
      console.error("[Update] Failed to resume suppressed auto-install:", error);
      return false;
    }
  }

  async function maybeHandleReadyUpdateAction() {
    if (!state.updateInfo || !isPrepReadyForCurrentUpdate()) return;

    const updateKey = getCurrentUpdateKey();
    const currentUpdateToken = buildUpdateToken(updateKey, state.updateInfo);
    if (!currentUpdateToken) return;
    if (autoInstallInFlightUpdateKey === currentUpdateToken) return;

    attachPreparedArtifactsIfReady();
    const isManualActionForCurrentUpdate = isPendingManualActionForCurrentUpdate(
      updateKey,
      state.updateInfo,
    );
    if (!isManualActionForCurrentUpdate) {
      if (state.updateInfo?.forceUpdate === true) {
        try {
          const result = await window.electronAPI.startUpdateFromMainWindow(state.updateInfo);
          if (!result?.success) {
            autoInstallInFlightUpdateKey = null;
            console.error(
              "[Update] Failed to auto-start required background update:",
              result?.error || "Unknown error",
            );
          } else {
            autoInstallInFlightUpdateKey = currentUpdateToken;
            if (updateKey) {
              state.updatePromptedKey = updateKey;
            }
          }
        } catch (error) {
          autoInstallInFlightUpdateKey = null;
          console.error("[Update] Failed to auto-start required background update:", error);
        }
        return;
      }

      if (state.updatePromptedKey === updateKey) return;
      state.updatePromptedKey = updateKey;

      try {
        const result = await window.electronAPI.showUpdateDialog(state.updateInfo);
        if (await resumeSuppressedAutoInstall(result)) return;
        if (!result?.accepted && !result?.deferred && !result?.quit && !result?.success) {
          state.updatePromptedKey = null;
        }
      } catch (error) {
        state.updatePromptedKey = null;
        console.error("[Update] Failed to show prepared background update dialog:", error);
      }
      return;
    }

    if (pendingManualUpdateAction.started) {
      return;
    }
    pendingManualUpdateAction.started = true;

    if (pendingManualUpdateAction.postPreparationAction === "auto-install") {
      try {
        const result = await window.electronAPI.startUpdateFromMainWindow(state.updateInfo);
        if (!result?.success) {
          pendingManualUpdateAction.started = false;
          autoInstallInFlightUpdateKey = null;
          console.error(
            "[Update] Failed to auto-start update from menu flow:",
            result?.error || "Unknown error",
          );
        } else {
          autoInstallInFlightUpdateKey = currentUpdateToken;
          if (updateKey) {
            state.updatePromptedKey = updateKey;
          }
          pendingManualUpdateAction = null;
          if (forcedPreparationUpdateKey === updateKey) {
            forcedPreparationUpdateKey = null;
          }
        }
      } catch (error) {
        pendingManualUpdateAction.started = false;
        autoInstallInFlightUpdateKey = null;
        console.error("[Update] Failed to auto-start update from menu flow:", error);
      }
      return;
    }

    if (state.updatePromptedKey === updateKey) return;
    state.updatePromptedKey = updateKey;

    try {
      const result = await window.electronAPI.showUpdateDialog(state.updateInfo);
      if (await resumeSuppressedAutoInstall(result)) return;
      if (!result?.accepted && !result?.deferred && !result?.quit && !result?.success) {
        state.updatePromptedKey = null;
        if (isManualActionForCurrentUpdate) {
          pendingManualUpdateAction.started = false;
        }
      }
      if (result?.success && forcedPreparationUpdateKey === updateKey) {
        forcedPreparationUpdateKey = null;
      }
      if (result?.success && isManualActionForCurrentUpdate) {
        pendingManualUpdateAction = null;
      }
    } catch (error) {
      state.updatePromptedKey = null;
      if (isManualActionForCurrentUpdate) {
        pendingManualUpdateAction.started = false;
      }
      console.error("[Update] Failed to show prepared update dialog:", error);
    }
  }

  async function checkForAppUpdates() {
    try {
      const updateResult = await window.electronAPI.checkForUpdates();
      if (updateResult.success && updateResult.updateAvailable) {
        const incomingKey = buildUpdateKey(updateResult);
        const incomingToken = buildUpdateToken(incomingKey, updateResult);
        const previousKey = getCurrentUpdateKey();
        const keyChanged = incomingKey && incomingKey !== previousKey;
        if (
          incomingKey &&
          forcedPreparationUpdateKey &&
          incomingKey !== forcedPreparationUpdateKey
        ) {
          forcedPreparationUpdateKey = null;
        }
        if (
          incomingToken &&
          autoInstallInFlightUpdateKey &&
          incomingToken !== autoInstallInFlightUpdateKey
        ) {
          autoInstallInFlightUpdateKey = null;
        }
        if (
          pendingManualUpdateAction &&
          !isPendingManualActionForCurrentUpdate(incomingKey, updateResult)
        ) {
          pendingManualUpdateAction = null;
        }

        state.updateAvailable = true;
        state.updateInfo = updateResult;
        if (keyChanged) {
          state.updatePromptedKey = null;
        }

        const prepReadyForCurrentUpdate = isPrepReadyForCurrentUpdate();
        const prepForCurrentUpdate = isPrepForCurrentUpdate();
        if (!prepReadyForCurrentUpdate && !prepForCurrentUpdate) {
          markPreparingForUpdate(updateResult);
        }

        setButtonChannelClass(document.getElementById("update-button"));
        renderUpdateButton();
        if (!prepReadyForCurrentUpdate) {
          await startPreparationForUpdate(updateResult);
        }
        attachPreparedArtifactsIfReady();
        renderUpdateButton();
        maybeHandleReadyUpdateAction();
      } else {
        const currentUpdateKey = getCurrentUpdateKey();
        const shouldKeepPendingManualFlow = Boolean(
          pendingManualUpdateAction &&
          isPendingManualActionForCurrentUpdate(currentUpdateKey, state.updateInfo) &&
          (state.updatePrep?.state === "preparing" || state.updatePrep?.state === "ready"),
        );
        if (shouldKeepPendingManualFlow) {
          renderUpdateButton();
          maybeHandleReadyUpdateAction();
          return;
        }

        forcedPreparationUpdateKey = null;
        autoInstallInFlightUpdateKey = null;
        pendingManualUpdateAction = null;
        state.updateAvailable = false;
        state.updateInfo = null;
        state.updatePromptedKey = null;
        if (state.updatePrep?.state === "preparing" && window.electronAPI?.cancelUpdatePreparation) {
          window.electronAPI.cancelUpdatePreparation().catch((error) => {
            console.warn("[Update] Failed to cancel stale preparation:", error.message);
          });
        }
        renderUpdateButton();
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    }
  }

  function startUpdateChecking() {
    const logToMain = window.electronAPI?.logToMain;
    setupPreparationListeners();
    setupMenuUpdateListener();
    hydratePreparationStatus();
    checkForAppUpdates();

    state.updateCheckInterval = setInterval(() => {
      checkForAppUpdates();
    }, 120000);

    if (logToMain) {
      logToMain("info", "[Update] Background update checks scheduled", {
        intervalMs: 120000,
      });
    }
  }

  async function handleUpdateClick() {
    if (!state.updateInfo) return;

    if (!isPrepReadyForCurrentUpdate()) {
      console.log("[Update] Click ignored while preparation is still running");
      return;
    }

    // Re-check to catch newly published updates before prompting.
    const freshUpdateCheck = await window.electronAPI.checkForUpdates();
    if (freshUpdateCheck?.success && freshUpdateCheck?.updateAvailable) {
      const currentKey = getCurrentUpdateKey();
      const freshKey = buildUpdateKey(freshUpdateCheck);
      if (freshKey && freshKey !== currentKey) {
        state.updateAvailable = true;
        state.updateInfo = freshUpdateCheck;
        state.updatePromptedKey = null;
        markPreparingForUpdate(freshUpdateCheck);
        setButtonChannelClass(document.getElementById("update-button"));
        renderUpdateButton();
        await startPreparationForUpdate(freshUpdateCheck);
        return;
      }
    }

    attachPreparedArtifactsIfReady();
    const result = await window.electronAPI.showUpdateDialog(state.updateInfo);
    if (await resumeSuppressedAutoInstall(result)) return;
    if (!result?.success && result?.error) {
      console.error("[Update] Failed to show update dialog:", result.error);
    }
  }

  window.checkForAppUpdates = checkForAppUpdates;
  window.startUpdateChecking = startUpdateChecking;
  window.showUpdateButton = showUpdateButton;
  window.hideUpdateButton = hideUpdateButton;
  window.handleUpdateClick = handleUpdateClick;

  // ---- Update Install Modal ----
  let updateModalListenersRegistered = false;

  function revealUpdateModal(modal) {
    if (!modal) return;

    const reveal =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => setTimeout(callback, 0);

    reveal(() => {
      modal.classList.add("visible");
    });
  }

  function showUpdateModal(updateInfo) {
    const modal = document.getElementById("update-install-modal");
    if (!modal) return;

    const versionEl = document.getElementById("update-modal-version");
    if (versionEl) {
      versionEl.textContent = `Updating from ${updateInfo.currentBuildNumber || "?"} → ${updateInfo.latestBuildNumber || "?"}`;
    }

    const progressEl = document.getElementById("update-modal-progress");
    if (progressEl) progressEl.style.width = "0%";
    const statusEl = document.getElementById("update-modal-status");
    if (statusEl) statusEl.textContent = "Starting update...";
    const logEl = document.getElementById("update-modal-log");
    if (logEl) logEl.textContent = "";

    const taskList = document.getElementById("update-modal-task-list");
    if (taskList) {
      const isPrepared = Boolean(updateInfo?.prepared?.ready);
      taskList.classList.toggle("prepared-update-task-list", isPrepared);
      taskList.innerHTML = isPrepared
        ? `<div class="task-item" id="umodal-task-validate"><div class="task-icon"></div><div class="task-text">Validating prepared update</div></div>
           <div class="task-item" id="umodal-task-install"><div class="task-icon"></div><div class="task-text">Installing prepared files</div></div>
           <div class="task-item" id="umodal-task-restart"><div class="task-icon"></div><div class="task-text">Restarting application</div></div>`
        : `<div class="task-item" id="umodal-task-download"><div class="task-icon"></div><div class="task-text">Downloading update</div></div>
           <div class="task-item" id="umodal-task-extract"><div class="task-icon"></div><div class="task-text">Extracting files</div></div>
           <div class="task-item" id="umodal-task-build"><div class="task-icon"></div><div class="task-text">Building application</div></div>
           <div class="task-item" id="umodal-task-restart"><div class="task-icon"></div><div class="task-text">Restarting application</div></div>`;
    }

    window.ensureControlPlaneTabActive?.();
    revealUpdateModal(modal);
  }

  function appendUpdateLog(text) {
    const logEl = document.getElementById("update-modal-log");
    if (!logEl) return;
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setUpdateModalProgress(pct) {
    const el = document.getElementById("update-modal-progress");
    if (el) el.style.width = `${pct}%`;
  }

  function setUpdateModalStatus(text) {
    const el = document.getElementById("update-modal-status");
    if (el) el.textContent = text;
  }

  function registerUpdateModalListeners() {
    if (updateModalListenersRegistered) return;
    updateModalListenersRegistered = true;

    window.electronAPI.onUpdateOutput((data) => {
      if (!document.getElementById("update-install-modal")?.classList.contains("visible")) return;
      const lines = (data.data || "").split("\n");
      lines.forEach((line) => {
        if (!line.trim()) return;
        appendUpdateLog(line + "\n");
        if (line.includes("Step 1: Validating") || line.includes("Step 1:")) {
          setUpdateModalStatus("Validating prepared update...");
          setUpdateModalProgress(22);
          document.getElementById("umodal-task-validate")?.classList.add("active");
        } else if (line.includes("Step 2: Installing") || line.includes("Step 2:")) {
          setUpdateModalStatus("Installing files...");
          setUpdateModalProgress(50);
          const validateEl = document.getElementById("umodal-task-validate");
          if (validateEl) { validateEl.classList.remove("active"); validateEl.classList.add("completed"); }
          document.getElementById("umodal-task-install")?.classList.add("active");
        } else if (line.includes("Step 3:") || line.includes("READY_FOR_RESTART")) {
          setUpdateModalProgress(90);
          const installEl = document.getElementById("umodal-task-install");
          if (installEl) { installEl.classList.remove("active"); installEl.classList.add("completed"); }
          document.getElementById("umodal-task-restart")?.classList.add("active");
        }
      });
    });

    window.electronAPI.onUpdateComplete(async (data) => {
      if (!document.getElementById("update-install-modal")?.classList.contains("visible")) return;
      if (data.success && data.readyForRestart) {
        setUpdateModalProgress(100);
        setUpdateModalStatus("Update complete! Restarting...");
        appendUpdateLog("\n✅ Update completed successfully!\n🔄 Restarting application...\n");
        setTimeout(async () => {
          await window.electronAPI.restartAfterUpdate();
        }, 2000);
      } else {
        setUpdateModalStatus("Update failed.");
        appendUpdateLog("\n❌ Update failed: " + (data.error || "Unknown error") + "\n");
      }
    });
  }

  if (typeof window.electronAPI?.onStartUpdate === "function") {
    window.electronAPI.onStartUpdate(async (updateInfo) => {
      registerUpdateModalListeners();
      showUpdateModal(updateInfo);
      setUpdateModalStatus("Starting update...");

      const result = await window.electronAPI.executeUpdate(updateInfo);
      if (result && result.success === false && typeof result.code === "undefined") {
        setUpdateModalStatus("Update failed to start.");
        appendUpdateLog("❌ " + (result.error || "Failed to start update") + "\n");
      }
    });
  }
})();
