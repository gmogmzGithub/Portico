(function attachMcpOperationProgress(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.McpOperationProgress = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  const STAGE_META = {
    queued: { label: "Queued", percent: 5, terminal: false, healthStatus: "starting" },
    applying: { label: "Applying change", percent: 18, terminal: false, healthStatus: "starting" },
    restarting: { label: "Restarting runtime", percent: 24, terminal: false, healthStatus: "starting" },
    waiting: { label: "Waiting for readiness", percent: 40, terminal: false, healthStatus: "starting" },
    starting: { label: "Starting", percent: 62, terminal: false, healthStatus: "starting" },
    checking: { label: "Checking", percent: 74, terminal: false, healthStatus: "checking" },
    continuing: { label: "Continuing in background", percent: 100, terminal: true, healthStatus: "starting" },
    healthy: { label: "Running", percent: 100, terminal: true, healthStatus: "healthy" },
    disabled: { label: "Disabled", percent: 100, terminal: true, healthStatus: "disabled" },
    not_configured: {
      label: "Needs configuration",
      percent: 100,
      terminal: true,
      healthStatus: "not_configured",
    },
    needs_oauth: { label: "Needs auth", percent: 100, terminal: true, healthStatus: "needs_oauth" },
    waiting_callback: { label: "Waiting for OAuth callback", percent: 100, terminal: true, healthStatus: "needs_oauth" },
    failed: { label: "Failed", percent: 100, terminal: true, healthStatus: "failed" },
    startup_failed: { label: "Failed to start", percent: 100, terminal: true, healthStatus: "failed" },
    timeout: { label: "Timed out", percent: 100, terminal: true, healthStatus: "timeout" },
    not_running: { label: "Not running", percent: 100, terminal: true, healthStatus: "not_running" },
    error: { label: "Failed", percent: 100, terminal: true, healthStatus: "failed" },
  };

  const TERMINAL_STAGES = new Set(
    Object.entries(STAGE_META)
      .filter(([, meta]) => meta.terminal)
      .map(([stage]) => stage),
  );
  const ENABLE_PENDING_PREFER_MAX_AGE_MS = 3 * 60 * 1000;
  const TRANSIENT_ENABLE_BACKEND_STATUSES = new Set([
    "starting",
    "checking",
    "failed",
    "timeout",
    "not_running",
    "not_configured",
  ]);
  const HARD_ENABLE_FAILURE_PATTERNS = [
    /not configured/i,
    /missing environment/i,
    /no such service/i,
    /not a directory/i,
    /error mounting/i,
    /invalid configuration/i,
    /invalid json/i,
    /trailing comma/i,
    /config regeneration failed/i,
    /permission denied/i,
  ];
  const TRANSIENT_ENABLE_FAILURE_PATTERNS = [
    /exposed no tools/i,
    /bad gateway/i,
    /fetch failed/i,
    /connection refused/i,
    /runtime is still starting/i,
    /not running/i,
    /did not become ready within/i,
    /health check timeout/i,
    /\btimed out\b/i,
  ];
  const RUNNING_OPERATION_STATUSES = new Set([
    "queued",
    "pending",
    "running",
    "in_progress",
    "applying",
    "restarting",
    "waiting",
    "starting",
    "checking",
  ]);
  const SUCCESS_OPERATION_STATUSES = new Set([
    "success",
    "succeeded",
    "complete",
    "completed",
  ]);
  const ATTENTION_OPERATION_STATUSES = new Set([
    "partial",
    "partial_success",
    "failed",
    "error",
    "timeout",
    "timed_out",
    "cancelled",
    "canceled",
    "action_required",
    "attention_required",
    "needs_attention",
    "interrupted",
  ]);
  const ACTION_REQUIRED_OPERATION_STATUSES = new Set([
    "action_required",
    "attention_required",
    "needs_attention",
  ]);
  const ATTENTION_ROW_STAGES = new Set([
    "not_configured",
    "needs_oauth",
    "waiting_callback",
    "failed",
    "startup_failed",
    "timeout",
    "not_running",
    "error",
  ]);
  const SNAPSHOT_PHASE_LABELS = {
    preflight: "Checking prerequisites",
    persisting_toggles: "Saving selection",
    regenerating_config: "Regenerating configuration",
    resolving_runtime_targets: "Resolving runtime targets",
    restarting_host: "Restarting host runtime",
    restarting_docker: "Restarting Docker runtime",
    reloading_routes: "Reloading routes",
    waiting_readiness: "Waiting for readiness",
    runtime_started: "Runtime started",
    tool_ready: "Running",
    disabled: "Disabled",
    startup_failed: "Failed to start",
  };

  // Backend probe results surface machine codes ("http_503", "not_discovered")
  // as row details; translate them so raw codes never reach the modal.
  function humanizeRowDetail(detail) {
    const raw = String(detail || "").trim();
    const httpMatch = /^(?:tool_probe_)?http_(\d{3})$/.exec(raw);
    if (httpMatch) {
      return `Runtime returned HTTP ${httpMatch[1]} while starting`;
    }
    if (raw === "not_discovered") {
      return "Waiting for the runtime to publish this server's routes";
    }
    if (raw === "request_timeout") {
      return "Readiness check timed out while contacting the runtime";
    }
    if (raw === "aggregator_unavailable") {
      return "The MCP runtime is not reachable yet";
    }
    if (raw === "no_callable_tool_paths") {
      return "The server has not exposed any tools yet";
    }
    const timeoutMatch = /^Readiness timed out after (\d+)ms$/.exec(raw);
    if (timeoutMatch) {
      const seconds = Math.round(Number(timeoutMatch[1]) / 1000);
      return `Did not become ready within ${seconds}s — the server may have failed to start; check its logs`;
    }
    return raw;
  }

  function normalizeStage(stage) {
    const normalized = String(stage || "").trim().toLowerCase();
    return Object.hasOwn(STAGE_META, normalized) ? normalized : "queued";
  }

  function getStageMeta(stage) {
    return STAGE_META[normalizeStage(stage)];
  }

  function isTerminalStage(stage) {
    return TERMINAL_STAGES.has(normalizeStage(stage));
  }

  function getPendingOperationAgeMs(pendingOperation, now = Date.now()) {
    if (!pendingOperation || typeof pendingOperation !== "object") {
      return Infinity;
    }

    const rawTimestamp =
      pendingOperation.updatedAt ??
      pendingOperation.startedAt ??
      pendingOperation.createdAt ??
      null;
    const timestamp = Number(rawTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return 0;
    }

    return Math.max(0, now - timestamp);
  }

  function shouldPreferPendingStateForEnableBackendStatus(
    backendStatus,
    pendingOperation,
    options = {},
  ) {
    if (!pendingOperation || pendingOperation.targetEnabled !== true) {
      return false;
    }

    const normalizedStatus = String(backendStatus || "").trim().toLowerCase();
    const isPostAuthRecovery =
      pendingOperation.postAuthRecovery === true ||
      pendingOperation.operationKind === "post_oauth_recovery";
    const canOverridePostAuthNeedsOAuth =
      isPostAuthRecovery &&
      (normalizedStatus === "needs_oauth" ||
        normalizedStatus === "waiting_callback");
    if (
      !TRANSIENT_ENABLE_BACKEND_STATUSES.has(normalizedStatus) &&
      !canOverridePostAuthNeedsOAuth
    ) {
      return false;
    }

    const ageMs = getPendingOperationAgeMs(pendingOperation, options.now);
    if (ageMs > ENABLE_PENDING_PREFER_MAX_AGE_MS) {
      return false;
    }

    if (canOverridePostAuthNeedsOAuth) {
      return true;
    }

    if (normalizedStatus === "not_configured") {
      return options.allowNotConfiguredOverride === true;
    }

    const backendError = String(options.backendError || "").trim();
    if (
      backendError &&
      HARD_ENABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(backendError))
    ) {
      return false;
    }

    if (options.expectsOAuth === true) {
      return true;
    }

    if (normalizedStatus === "starting" || normalizedStatus === "checking") {
      return true;
    }

    if (!backendError) {
      return true;
    }

    return TRANSIENT_ENABLE_FAILURE_PATTERNS.some((pattern) =>
      pattern.test(backendError),
    );
  }

  function resolveEffectiveConfigured(options = {}) {
    const pendingOperation = options.pendingOperation || null;
    const backendConfigured =
      typeof options.backendConfigured === "boolean"
        ? options.backendConfigured
        : null;
    const backendStatus = String(options.backendStatus || "").trim().toLowerCase();
    const backendStatusImpliesConfigured = Boolean(
      backendStatus &&
        backendStatus !== "unknown" &&
        backendStatus !== "not_configured" &&
        backendStatus !== "failed" &&
        backendStatus !== "timeout" &&
        backendStatus !== "not_running" &&
        backendStatus !== "disabled",
    );

    if (
      shouldPreferPendingStateForEnableBackendStatus(
        backendStatus || (backendConfigured === false ? "not_configured" : "unknown"),
        pendingOperation,
        options,
      )
    ) {
      return true;
    }

    if (backendConfigured === true) {
      return true;
    }

    if (backendStatusImpliesConfigured) {
      return true;
    }

    if (backendConfigured === false) {
      return false;
    }

    return Boolean(options.serverConfigured);
  }

  function stageFromReadiness(readiness = {}) {
    if (readiness.healthy || readiness.readiness_phase === "tool_ready") {
      return "healthy";
    }

    const phase = String(
      readiness.readiness_phase || readiness.status || "",
    ).trim().toLowerCase();

    if (Object.hasOwn(STAGE_META, phase)) {
      return phase;
    }

    return "waiting";
  }

  function stageFromHealthStatus(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "unknown" || normalized === "") {
      return "waiting";
    }
    return Object.hasOwn(STAGE_META, normalized) ? normalized : "waiting";
  }

  function createTracker(options = {}) {
    const action = String(options.action || "update").trim().toLowerCase();
    const title = String(options.title || "Updating MCP servers");
    const servers = Array.isArray(options.servers) ? options.servers : [];
    const tracker = {
      action,
      operationId:
        options.operationId ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      title,
      serverOrder: [],
      servers: {},
    };

    for (const server of servers) {
      if (!server || typeof server !== "object" || !server.id) {
        continue;
      }
      const row = {
        id: server.id,
        label: String(server.label || server.name || server.id),
        targetEnabled: server.targetEnabled !== false,
        stage: "queued",
        detail: server.detail || getStageMeta("queued").label,
      };
      tracker.serverOrder.push(server.id);
      tracker.servers[server.id] = row;
    }

    return tracker;
  }

  function updateTrackerServer(tracker, serverId, patch = {}) {
    if (!tracker || !tracker.servers || !tracker.servers[serverId]) {
      return tracker;
    }

    const nextStage = normalizeStage(patch.stage || tracker.servers[serverId].stage);
    tracker.servers[serverId] = {
      ...tracker.servers[serverId],
      ...patch,
      stage: nextStage,
      detail: patch.detail || tracker.servers[serverId].detail || getStageMeta(nextStage).label,
    };
    return tracker;
  }

  function buildTrackerView(tracker) {
    const rows = (tracker?.serverOrder || []).map((serverId) => {
      const row = tracker.servers[serverId];
      const stageMeta = getStageMeta(row.stage);
      return {
        id: row.id,
        label: row.label,
        stage: row.stage,
        stageLabel: stageMeta.label,
        detail: row.detail || stageMeta.label,
        percent: stageMeta.percent,
        terminal: stageMeta.terminal,
        terminalState: stageMeta.healthStatus,
      };
    });

    const total = rows.length;
    const completed = rows.filter((row) => row.terminal).length;
    const overallPercent =
      total > 0
        ? Math.round(
            rows.reduce((sum, row) => sum + row.percent, 0) / total,
          )
        : 100;

    return {
      type: "mcp-operation",
      operationId: tracker?.operationId || null,
      title: tracker?.title || "Updating MCP servers",
      subtitle:
        total > 0
          ? `${completed}/${total} server${total === 1 ? "" : "s"} complete`
          : "No servers selected",
      overallPercent,
      rows,
      completed,
      total,
      terminal: total > 0 && completed === total,
    };
  }

  function extractOperationSnapshot(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const candidates = [
      payload.operation,
      payload.snapshot,
      payload.activeOperation,
      payload.data?.operation,
      payload.data?.snapshot,
      payload,
    ];
    return (
      candidates.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          (candidate.operationId || candidate.id),
      ) || null
    );
  }

  function normalizeOperationStatus(status, rows = []) {
    const normalized = String(status || "").trim().toLowerCase();
    if (
      RUNNING_OPERATION_STATUSES.has(normalized) ||
      SUCCESS_OPERATION_STATUSES.has(normalized) ||
      ATTENTION_OPERATION_STATUSES.has(normalized)
    ) {
      return normalized;
    }

    if (rows.length > 0 && rows.every((row) => row.terminal)) {
      return rows.some((row) => row.attention) ? "partial" : "succeeded";
    }
    return "running";
  }

  function normalizeSnapshotRowStage(row = {}) {
    let rawStage = String(
      row.stage || row.status || row.phase || row.result || "queued",
    )
      .trim()
      .toLowerCase();
    const phase = String(row.phase || "").trim().toLowerCase();
    if (rawStage === "running" && phase) {
      rawStage = phase;
    }
    if (
      rawStage === "attention_required" &&
      ["not_configured", "needs_oauth", "waiting_callback"].includes(phase)
    ) {
      rawStage = phase;
    }
    if (rawStage === "failed" && phase === "startup_failed") {
      rawStage = phase;
    }
    const aliases = {
      success: "healthy",
      succeeded: "healthy",
      complete: "healthy",
      completed: "healthy",
      running: "starting",
      in_progress: "starting",
      pending: "queued",
      preflight: "checking",
      persisting_toggles: "applying",
      regenerating_config: "applying",
      resolving_runtime_targets: "applying",
      restarting_host: "restarting",
      restarting_docker: "restarting",
      reloading_routes: "restarting",
      waiting_readiness: "waiting",
      runtime_started: "starting",
      tool_ready: "healthy",
      disabling: "applying",
      timed_out: "timeout",
      action_required: "not_configured",
      attention_required: "not_configured",
      needs_attention: "not_configured",
      interrupted: "failed",
    };
    if (
      row.targetEnabled === false &&
      ["success", "succeeded", "complete", "completed"].includes(rawStage)
    ) {
      return "disabled";
    }
    return normalizeStage(aliases[rawStage] || rawStage);
  }

  function normalizeSnapshotRows(snapshot = {}) {
    let rawRows = [];
    if (Array.isArray(snapshot.rows)) {
      rawRows = snapshot.rows;
    } else if (Array.isArray(snapshot.servers)) {
      rawRows = snapshot.servers;
    } else if (snapshot.servers && typeof snapshot.servers === "object") {
      rawRows = Object.entries(snapshot.servers).map(([serverId, row]) => ({
        id: serverId,
        ...(row && typeof row === "object" ? row : {}),
      }));
    }

    return rawRows
      .filter((row) => row && typeof row === "object")
      .map((row, index) => {
        const stage = normalizeSnapshotRowStage(row);
        const meta = getStageMeta(stage);
        const terminal =
          typeof row.terminal === "boolean" ? row.terminal : meta.terminal;
        const attention =
          row.attention === true ||
          row.success === false ||
          ATTENTION_ROW_STAGES.has(stage);
        const rawPercent = Number(
          row.percent ?? row.progress ?? row.progressPercent ?? meta.percent,
        );
        const phase = String(row.phase || "").trim().toLowerCase();
        const errorMessage =
          row.errorMessage ||
          (row.error && typeof row.error === "object" ? row.error.message : row.error);
        const requiredActionValue = row.requiredAction || row.required_action || null;
        const requiredAction =
          requiredActionValue && typeof requiredActionValue === "object"
            ? requiredActionValue.type || requiredActionValue.action || null
            : requiredActionValue;
        return {
          id: String(row.id || row.serverId || row.server_id || `server-${index + 1}`),
          label: String(
            row.label ||
              row.displayName ||
              row.display_name ||
              row.name ||
              row.id ||
              row.serverId ||
              row.server_id ||
              `Server ${index + 1}`,
          ),
          stage,
          stageLabel: String(
            row.stageLabel ||
              row.statusLabel ||
              SNAPSHOT_PHASE_LABELS[phase] ||
              meta.label,
          ),
          detail: humanizeRowDetail(
            String(
              // Transient per-probe errors (e.g. http_502 while a server is
              // still starting) are written on every poll tick; they only
              // become the visible detail once the row is terminal or needs
              // attention. Non-terminal rows show the stage label instead.
              row.detail ||
                row.message ||
                row.configurationMessage ||
                row.configuration_message ||
                (terminal || attention ? errorMessage : "") ||
                SNAPSHOT_PHASE_LABELS[phase] ||
                meta.label,
            ),
          ),
          percent: Number.isFinite(rawPercent)
            ? Math.max(0, Math.min(100, rawPercent))
            : meta.percent,
          terminal,
          attention,
          terminalState: String(
            row.terminalState || row.terminal_state || meta.healthStatus,
          ),
          deploymentType:
            row.deploymentType || row.deployment_type || null,
          requiredAction: requiredAction ? String(requiredAction) : null,
        };
      });
  }

  function getOperationTitle(kind, status) {
    const normalizedKind = String(kind || "update").trim().toLowerCase();
    const terminal = !RUNNING_OPERATION_STATUSES.has(status);
    if (normalizedKind === "enable") {
      if (ACTION_REQUIRED_OPERATION_STATUSES.has(status)) {
        return "MCP server enable needs attention";
      }
      return terminal ? "MCP server enable complete" : "Enabling MCP servers";
    }
    if (normalizedKind === "disable") {
      return terminal ? "MCP server disable complete" : "Disabling MCP servers";
    }
    return terminal ? "MCP server update complete" : "Updating MCP servers";
  }

  function getOperationSubtitle(kind, status, total, completed, rows) {
    if (ACTION_REQUIRED_OPERATION_STATUSES.has(status)) {
      const succeeded = rows.filter(
        (row) => row.terminal && row.attention !== true,
      ).length;
      const attention = rows.filter((row) => row.attention === true).length;
      const normalizedKind = String(kind || "update").trim().toLowerCase();
      const action =
        normalizedKind === "enable"
          ? "enabled"
          : normalizedKind === "disable"
            ? "disabled"
            : "updated";
      return `${succeeded} server${succeeded === 1 ? "" : "s"} ${action} · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
    }
    if (total > 0) {
      return `${completed}/${total} server${total === 1 ? "" : "s"} complete`;
    }
    return !RUNNING_OPERATION_STATUSES.has(status)
      ? "Operation complete"
      : "Preparing operation";
  }

  function normalizeOperationSnapshot(payload) {
    const snapshot = extractOperationSnapshot(payload);
    if (!snapshot) {
      return null;
    }

    const operationId = String(snapshot.operationId || snapshot.id || "").trim();
    if (!operationId) {
      return null;
    }

    const rows = normalizeSnapshotRows(snapshot);
    const status = normalizeOperationStatus(snapshot.status, rows);
    const effectsFinalized = snapshot.effectsFinalized !== false;
    const terminal =
      effectsFinalized && !RUNNING_OPERATION_STATUSES.has(status);
    const attention =
      ATTENTION_OPERATION_STATUSES.has(status) ||
      rows.some((row) => row.attention);
    const successful =
      terminal && SUCCESS_OPERATION_STATUSES.has(status) && !attention;
    const summaryInput =
      snapshot.summary && typeof snapshot.summary === "object"
        ? snapshot.summary
        : {};
    const totalRaw = Number(summaryInput.total ?? snapshot.total ?? rows.length);
    const completedRaw = Number(
      summaryInput.completed ??
        snapshot.completed ??
        rows.filter((row) => row.terminal).length,
    );
    const failedRaw = Number(
      summaryInput.failed ??
        summaryInput.failures ??
        snapshot.failed ??
        rows.filter((row) => row.attention).length,
    );
    const total = Number.isFinite(totalRaw) ? Math.max(0, totalRaw) : rows.length;
    const completed = Number.isFinite(completedRaw)
      ? Math.max(0, Math.min(total, completedRaw))
      : 0;
    const failed = Number.isFinite(failedRaw) ? Math.max(0, failedRaw) : 0;
    const computedPercent =
      rows.length > 0
        ? Math.round(
            rows.reduce((sum, row) => sum + row.percent, 0) / rows.length,
          )
        : terminal
          ? 100
          : 0;
    const percentRaw = Number(
      snapshot.overallPercent ??
        snapshot.progress ??
        snapshot.progressPercent ??
        summaryInput.overallPercent ??
        summaryInput.percent ??
        computedPercent,
    );
    const revisionRaw = Number(snapshot.sequence ?? snapshot.revision ?? 0);
    const desiredRevisionRaw = Number(snapshot.desiredRevision);
    const kind = String(
      snapshot.action ||
        (snapshot.kind && snapshot.kind !== "mcp_operation"
          ? snapshot.kind
          : "update"),
    )
      .trim()
      .toLowerCase();

    return {
      type: "mcp-operation",
      operationId,
      clientRequestId: snapshot.clientRequestId || snapshot.client_request_id || null,
      revision: Number.isFinite(revisionRaw) ? Math.max(0, revisionRaw) : 0,
      desiredRevision: Number.isFinite(desiredRevisionRaw)
        ? desiredRevisionRaw
        : null,
      kind,
      status,
      phase: String(
        effectsFinalized === false ? "finalizing" : snapshot.phase || status,
      ),
      title: String(
        snapshot.title || getOperationTitle(kind, terminal ? status : "running"),
      ),
      subtitle: String(
        snapshot.subtitle ||
          getOperationSubtitle(kind, status, total, completed, rows),
      ),
      overallPercent: Number.isFinite(percentRaw)
        ? Math.max(
            computedPercent,
            Math.max(0, Math.min(100, percentRaw)),
          )
        : computedPercent,
      rows,
      summary: {
        ...summaryInput,
        total,
        completed,
        failed,
      },
      total,
      completed,
      terminal,
      effectsFinalized,
      successful,
      attention,
      optimistic: snapshot.optimistic === true,
      metadata:
        snapshot.metadata && typeof snapshot.metadata === "object"
          ? { ...snapshot.metadata }
          : {},
      presentationMode:
        snapshot.metadata?.presentationMode ||
        snapshot.presentationMode ||
        snapshot.presentation_mode ||
        null,
      error: snapshot.error
        ? String(
            typeof snapshot.error === "object"
              ? snapshot.error.message || snapshot.error.code || "Operation failed"
              : snapshot.error,
          )
        : null,
      createdAt: snapshot.createdAt || snapshot.created_at || null,
      updatedAt: snapshot.updatedAt || snapshot.updated_at || null,
    };
  }

  function shouldAcceptOperationSnapshot(current, next) {
    if (!next || !next.operationId) {
      return false;
    }
    if (!current || !current.operationId) {
      return true;
    }
    if (current.operationId !== next.operationId) {
      if (
        Number.isFinite(current.desiredRevision) &&
        Number.isFinite(next.desiredRevision) &&
        next.desiredRevision < current.desiredRevision
      ) {
        return false;
      }
      const currentCreatedAt = Number(current.createdAt);
      const nextCreatedAt = Number(next.createdAt);
      if (
        Number.isFinite(currentCreatedAt) &&
        currentCreatedAt > 0 &&
        Number.isFinite(nextCreatedAt) &&
        nextCreatedAt > 0 &&
        nextCreatedAt < currentCreatedAt
      ) {
        return false;
      }
      return true;
    }
    if (current.optimistic && !next.optimistic) {
      return Number(next.revision || 0) >= Number(current.revision || 0);
    }
    return Number(next.revision || 0) > Number(current.revision || 0);
  }

  function createOptimisticOperationSnapshot(request = {}, servers = []) {
    const operationId = String(
      request.clientRequestId || request.operationId || `pending-${Date.now()}`,
    );
    const kind = String(request.kind || request.action || "update")
      .trim()
      .toLowerCase();
    const serverIds = Array.isArray(request.serverIds) ? request.serverIds : [];
    const labels = new Map(
      (Array.isArray(servers) ? servers : [])
        .filter((server) => server && (server.id || server.serverId))
        .map((server) => [
          String(server.id || server.serverId),
          String(
            server.label ||
              server.display_name ||
              server.displayName ||
              server.name ||
              server.id ||
              server.serverId,
          ),
        ]),
    );
    return normalizeOperationSnapshot({
      operationId,
      revision: 0,
      kind,
      status: "queued",
      phase: "queued",
      optimistic: true,
      rows: serverIds.map((serverId) => ({
        id: serverId,
        label: labels.get(String(serverId)) || String(serverId),
        stage: "queued",
        detail: "Queued",
      })),
    });
  }

  function resolveEffectiveHealthStatus(
    backendStatus,
    pendingOperation,
    options = {},
  ) {
    if (!pendingOperation) {
      return backendStatus || "unknown";
    }

    if (pendingOperation.targetEnabled === false) {
      return getStageMeta(pendingOperation.stage || "disabled").healthStatus;
    }

    if (
      shouldPreferPendingStateForEnableBackendStatus(
        backendStatus,
        pendingOperation,
        options,
      )
    ) {
      return getStageMeta(pendingOperation.stage || "starting").healthStatus;
    }

    if (
      backendStatus &&
      backendStatus !== "disabled" &&
      backendStatus !== "unknown"
    ) {
      return backendStatus;
    }

    return getStageMeta(pendingOperation.stage).healthStatus;
  }

  function resolveEffectiveEnabled(options = {}) {
    if (options.isCore) return true;
    if (options.pendingOperation) {
      return Boolean(options.pendingOperation.targetEnabled);
    }

    if (options.toggleEnabled === false) {
      return false;
    }

    const backendStatus = options.backendStatus;
    if (backendStatus === "disabled") {
      return false;
    }

    if (
      backendStatus &&
      backendStatus !== "not_configured" &&
      backendStatus !== "unknown"
    ) {
      return true;
    }

    return options.toggleEnabled === true;
  }

  function recalculateHealthSummary(servers = {}) {
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

  function applyLocalToggleHealthState(servers, serverId, enabled, options = {}) {
    if (!servers || typeof servers !== "object" || !serverId) {
      return null;
    }

    const current = servers[serverId] || {};
    const nextStatus =
      typeof options.status === "string" && options.status.trim()
        ? options.status.trim()
        : enabled
          ? "starting"
          : "disabled";
    const configured =
      typeof options.configured === "boolean"
        ? options.configured
        : enabled
          ? true
          : typeof current.configured === "boolean"
            ? current.configured
            : true;
    servers[serverId] = {
      ...current,
      status: nextStatus,
      configured,
      error:
        Object.hasOwn(options, "error")
          ? options.error
          : null,
      running:
        typeof options.running === "boolean"
          ? options.running
          : false,
      host:
        Object.hasOwn(options, "host")
          ? options.host
          : null,
      port:
        Object.hasOwn(options, "port")
          ? options.port
          : null,
      disabled_by_user: enabled ? false : true,
      disabled_reason: enabled ? null : "explicit_false",
      authorization_url_available:
        typeof options.authorizationUrlAvailable === "boolean"
          ? options.authorizationUrlAvailable
          : current.authorization_url_available,
      authorizationUrlAvailable:
        typeof options.authorizationUrlAvailable === "boolean"
          ? options.authorizationUrlAvailable
          : current.authorizationUrlAvailable,
      oauth_state:
        Object.hasOwn(options, "oauthState")
          ? options.oauthState
          : current.oauth_state,
    };

    delete servers[serverId].startup_failure;
    delete servers[serverId].startup_failure_source;
    delete servers[serverId].startup_failure_stage;
    delete servers[serverId].startup_failure_timestamp;
    delete servers[serverId].config_path;
    delete servers[serverId].container_name;
    delete servers[serverId].source;
    delete servers[serverId].stage;

    return {
      server: servers[serverId],
      summary: recalculateHealthSummary(servers),
    };
  }

  return {
    applyLocalToggleHealthState,
    buildTrackerView,
    createOptimisticOperationSnapshot,
    createTracker,
    extractOperationSnapshot,
    getStageMeta,
    humanizeRowDetail,
    isTerminalStage,
    normalizeOperationSnapshot,
    normalizeStage,
    recalculateHealthSummary,
    resolveEffectiveEnabled,
    resolveEffectiveConfigured,
    resolveEffectiveHealthStatus,
    shouldPreferPendingStateForEnableBackendStatus,
    stageFromHealthStatus,
    stageFromReadiness,
    shouldAcceptOperationSnapshot,
    updateTrackerServer,
  };
});
