const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

const TERMINAL_SERVER_STATUSES = new Set([
  "succeeded",
  "failed",
  "attention_required",
  "interrupted",
  "timed_out",
]);

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_RETENTION_MS = 15 * 60 * 1000;
// An external mutation lease held longer than this is treated as orphaned and
// evicted the next time something contends for the lock. Deliberately generous:
// this is a self-heal backstop, not the fix for a leak, and the only plausible
// false positive is a very cold first-run bring-up. Long-lived holders re-stamp
// via renewMutationLease, which keeps them well inside the window.
const DEFAULT_EXTERNAL_MUTATION_MAX_AGE_MS = 30 * 60 * 1000;

function formatMutationAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function normalizeServer(server) {
  if (typeof server === "string") {
    return { serverId: server, label: server };
  }
  if (!server || typeof server !== "object") {
    return null;
  }
  const serverId = String(server.serverId || server.id || "").trim();
  if (!serverId) {
    return null;
  }
  return {
    serverId,
    label: String(server.label || server.name || serverId),
    deploymentType: server.deploymentType || server.deployment_type || null,
  };
}

function cloneSnapshot(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeOperationError(error, fallbackCode = "MCP_OPERATION_FAILED") {
  if (!error) return null;
  if (typeof error === "object" && typeof error.message === "string") {
    return {
      code: error.code || fallbackCode,
      message: error.message,
      source: String(error.source || "runtime"),
      stage: String(error.stage || "unknown"),
      retryable: error.retryable !== false,
      ...(error.details !== undefined ? { details: cloneSnapshot(error.details) } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: String(error),
    source: "runtime",
    stage: "unknown",
    retryable: true,
  };
}

function isTerminalServerStatus(status) {
  return TERMINAL_SERVER_STATUSES.has(status);
}

function inferOperationStatus(servers) {
  const rows = Object.values(servers);
  if (rows.some((row) => !row.terminal)) {
    return "running";
  }
  if (rows.every((row) => row.status === "succeeded")) {
    return "succeeded";
  }
  if (
    rows.some((row) => row.status === "attention_required") &&
    rows.every((row) =>
      ["succeeded", "attention_required"].includes(row.status),
    )
  ) {
    return "attention_required";
  }
  if (rows.every((row) => row.status === "interrupted")) {
    return "interrupted";
  }
  if (rows.every((row) => ["failed", "timed_out"].includes(row.status))) {
    return "failed";
  }
  return "partial";
}

class McpOperationManager {
  constructor(options = {}) {
    this._operations = new Map();
    this._serverOwners = new Map();
    this._events = new EventEmitter();
    this._events.setMaxListeners(options.maxListeners || 100);
    this._historyLimit = options.historyLimit || DEFAULT_HISTORY_LIMIT;
    this._retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;
    this._clock = options.clock || (() => Date.now());
    this._idFactory = options.idFactory || (() => randomUUID());
    this._nextDesiredRevision = 0;
    this._activeOperationId = null;
    this._externalMutation = null;
    this._clientRequests = new Map();
    this._lifecycleUpdater = options.lifecycleUpdater || null;
    this._auditLogger = options.auditLogger || console;
    this._externalMutationMaxAgeMs =
      options.externalMutationMaxAgeMs || DEFAULT_EXTERNAL_MUTATION_MAX_AGE_MS;
  }

  /**
   * Drop an external mutation lease that has aged past the staleness window.
   *
   * Deliberately lazy: this is only ever called from the two paths that are
   * about to throw MCP_OPERATION_BUSY, never on a timer and never from
   * _pruneHistory (which also runs on uncontended paths and would evict live
   * leases). Only touches _externalMutation -- operations have their own
   * lifecycle and are never evicted here.
   */
  _evictStaleExternalMutation() {
    const mutation = this._externalMutation;
    if (!mutation) return null;
    const ageMs = this._clock() - (mutation.startedAt || 0);
    if (ageMs < this._externalMutationMaxAgeMs) return null;

    this._externalMutation = null;
    // Identifiers and timings only -- never mutation payloads, which can carry
    // .env content or other secrets.
    const warn =
      typeof this._auditLogger?.warn === "function"
        ? this._auditLogger.warn.bind(this._auditLogger)
        : console.warn;
    warn(
      `[MCP] Evicted stale mutation lease ${mutation.mutationId} (kind=${mutation.kind}, source=${mutation.source}, ageMs=${ageMs}); it was never released`,
    );
    return mutation;
  }

  /**
   * Re-stamp the in-flight external lease so a legitimately long-running holder
   * is not evicted. Keeps the same mutationId so the release closure handed out
   * by acquireMutationLease still matches.
   */
  renewMutationLease(details = {}) {
    if (!this._externalMutation) return false;
    if (details.kind) this._externalMutation.kind = String(details.kind);
    if (details.source) this._externalMutation.source = String(details.source);
    this._externalMutation.startedAt = this._clock();
    return true;
  }

  _mutationBusyError() {
    const activeOperation = this.getActiveMcpOperation();
    const activeMutation = this.getActiveMutation();
    // Describe the holder in terms a user can act on. Only the kind, source and
    // age are interpolated -- all internal identifiers, never payloads, which
    // can carry .env content or other secrets.
    const kind = activeOperation?.kind || activeMutation?.kind || "";
    const source = activeMutation?.source || "";
    const startedAt =
      activeMutation?.startedAt ?? activeOperation?.startedAt ?? null;
    const descriptor = [
      kind ? `${kind}` : "",
      source ? `started by ${source}` : "",
      startedAt ? formatMutationAge(this._clock() - startedAt) : "",
    ]
      .filter(Boolean)
      .join(", ");
    const error = new Error(
      descriptor
        ? `Another MCP change is still running (${descriptor}). Wait for it to finish, or restart Portico if it looks stuck.`
        : "Another MCP change is still running. Wait for it to finish, or restart Portico if it looks stuck.",
    );
    error.code = "MCP_OPERATION_BUSY";
    error.activeOperation = activeOperation;
    error.activeMutation = activeMutation;
    return error;
  }

  getActiveMutation() {
    if (this._activeOperationId) {
      return {
        mutationId: this._activeOperationId,
        kind: "operation",
        operation: this.getActiveMcpOperation(),
      };
    }
    return cloneSnapshot(this._externalMutation);
  }

  acquireMutationLease(details = {}) {
    if (this._activeOperationId || this._externalMutation) {
      this._evictStaleExternalMutation();
      if (this._activeOperationId || this._externalMutation) {
        throw this._mutationBusyError();
      }
    }
    const mutationId = details.mutationId || `external-${this._idFactory()}`;
    this._externalMutation = {
      mutationId,
      kind: String(details.kind || "external"),
      source: String(details.source || "main_process"),
      startedAt: this._clock(),
    };
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      if (this._externalMutation?.mutationId === mutationId) {
        this._externalMutation = null;
        this._notifyMutationIdle();
        return true;
      }
      return false;
    };
  }

  /**
   * One-shot notification that the global mutation lock became free. Emitted
   * from release paths only -- never from _evictStaleExternalMutation, which
   * runs inside a contended acquire gate where the contender is about to take
   * the lock itself; waking waiters there would send them into a guaranteed
   * busy retry.
   */
  _notifyMutationIdle() {
    if (!this._activeOperationId && !this._externalMutation) {
      this._events.emit("mutation:released");
    }
  }

  /**
   * Resolves once the global mutation lock is free. Event-driven -- no timers
   * and no polling (callers own any timeout). Used by guided-setup finalize to
   * absorb the tail of a single-server teardown instead of failing busy.
   */
  whenMutationIdle() {
    if (!this._activeOperationId && !this._externalMutation) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this._events.once("mutation:released", () => resolve(true));
    });
  }

  async runExclusiveMutation(details, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("runExclusiveMutation requires a callback");
    }
    const release = this.acquireMutationLease(details);
    try {
      return await callback();
    } finally {
      release();
    }
  }

  _audit(event, operation, row = null, extra = {}) {
    const now = this._clock();
    const context = operation?.metadata || {};
    const payload = {
      schemaVersion: 1,
      event,
      timestamp: new Date(now).toISOString(),
      operationId: operation?.operationId || null,
      serverId: row?.serverId || null,
      kind: operation?.kind || null,
      status: row?.status || operation?.status || null,
      phase: row?.phase || operation?.phase || null,
      revision: row?.sequence ?? operation?.sequence ?? null,
      desiredRevision: operation?.desiredRevision ?? null,
      targetEnabled: row?.targetEnabled ?? operation?.targetEnabled ?? null,
      source: context.source || "main_process",
      rootClassification:
        context.rootClassification || "active-project-root",
      channel: context.channel || "runtime",
      elapsedMs: Math.max(0, now - (operation?.createdAt || now)),
      safeErrorCode: row?.error?.code || operation?.error?.code || null,
      ...extra,
    };
    this._auditLogger.info?.(
      `[MCP Operation Audit] ${JSON.stringify(payload)}`,
    );
  }

  startMcpOperation(request = {}) {
    this._pruneHistory();
    const clientRequestId =
      typeof request.clientRequestId === "string" && request.clientRequestId.trim()
        ? request.clientRequestId.trim()
        : null;
    if (clientRequestId && this._clientRequests.has(clientRequestId)) {
      const existingOperationId = this._clientRequests.get(clientRequestId);
      const existing = this.getMcpOperation(existingOperationId);
      if (existing) return existing;
      this._clientRequests.delete(clientRequestId);
    }
    const action = request.action || (request.targetEnabled === false ? "disable" : "enable");
    const targetEnabled =
      typeof request.targetEnabled === "boolean"
        ? request.targetEnabled
        : action !== "disable";
    const normalizedServers = (request.servers || request.serverIds || [])
      .map(normalizeServer)
      .filter(Boolean);
    const uniqueServers = Array.from(
      new Map(normalizedServers.map((server) => [server.serverId, server])).values(),
    );
    if (uniqueServers.length === 0) {
      throw new TypeError("startMcpOperation requires at least one server");
    }

    const now = this._clock();
    const operationId = request.operationId || this._idFactory();
    if (this._operations.has(operationId)) {
      throw new Error(`MCP operation ${operationId} already exists`);
    }
    const desiredRevision = Number.isSafeInteger(request.desiredRevision)
      ? request.desiredRevision
      : ++this._nextDesiredRevision;
    this._nextDesiredRevision = Math.max(this._nextDesiredRevision, desiredRevision);

    if (this._activeOperationId || this._externalMutation) {
      this._evictStaleExternalMutation();
      if (this._activeOperationId || this._externalMutation) {
        throw this._mutationBusyError();
      }
    }

    const initialStatus = "queued";
    const initialPhase = "queued";
    const startsImmediately = request.startImmediately !== false;
    const servers = Object.fromEntries(
      uniqueServers.map((server) => [
        server.serverId,
        {
          id: server.serverId,
          serverId: server.serverId,
          label: server.label,
          deploymentType: server.deploymentType,
          targetEnabled,
          desiredRevision,
          sequence: 0,
          revision: 0,
          status: initialStatus,
          phase: initialPhase,
          healthy: false,
          terminal: false,
          success: null,
          progressPercent: 0,
          error: null,
          errorMessage: null,
          requiredAction: null,
          startedAt: startsImmediately ? now : null,
          updatedAt: now,
          completedAt: null,
        },
      ]),
    );
    const operation = {
      schemaVersion: 1,
      kind: request.kind || action,
      operationId,
      clientRequestId,
      action,
      targetEnabled,
      desiredRevision,
      lifecycleSessionId: request.lifecycleSessionId || operationId,
      sequence: 1,
      status: startsImmediately ? "running" : "queued",
      phase: startsImmediately ? "running" : "queued",
      serverIds: uniqueServers.map((server) => server.serverId),
      servers,
      createdAt: now,
      startedAt: startsImmediately ? now : null,
      updatedAt: now,
      completedAt: null,
      error: null,
      metadata: request.metadata ? cloneSnapshot(request.metadata) : {},
      deferRelease: request.deferRelease === true,
      effectsFinalized: false,
      progressPercent: 0,
    };
    this._operations.set(operationId, operation);
    if (clientRequestId) {
      this._clientRequests.set(clientRequestId, operationId);
    }
    this._activeOperationId = operationId;
    for (const server of uniqueServers) {
      this._serverOwners.set(server.serverId, { operationId, desiredRevision });
      this._publishLifecycle(operation, operation.servers[server.serverId]);
    }
    this._emit(operation);
    this._audit("operation_created", operation, null, {
      total: uniqueServers.length,
    });
    this._pruneHistory();
    return this._snapshot(operation);
  }

  updateServer(operationId, serverId, patch = {}) {
    const operation = this._operations.get(operationId);
    if (!operation) {
      return { accepted: false, reason: "operation_not_found" };
    }
    const current = operation.servers[serverId];
    if (!current) {
      return { accepted: false, reason: "server_not_in_operation" };
    }
    if (current.terminal) {
      return { accepted: false, reason: "terminal_row" };
    }
    const owner = this._serverOwners.get(serverId);
    if (
      !owner ||
      owner.operationId !== operationId ||
      owner.desiredRevision !== operation.desiredRevision
    ) {
      return { accepted: false, reason: "stale_operation" };
    }
    if (
      Number.isSafeInteger(patch.desiredRevision) &&
      patch.desiredRevision !== operation.desiredRevision
    ) {
      return { accepted: false, reason: "stale_revision" };
    }
    if (
      Number.isSafeInteger(patch.sequence) &&
      patch.sequence <= current.sequence
    ) {
      return { accepted: false, reason: "stale_sequence" };
    }

    const now = this._clock();
    const nextStatus = patch.status || current.status;
    const terminal = patch.terminal ?? isTerminalServerStatus(nextStatus);
    const success =
      patch.success ??
      (terminal
        ? !["failed", "interrupted", "timed_out"].includes(nextStatus)
        : current.success);
    const structuredError = normalizeOperationError(
      patch.error,
      nextStatus === "timed_out"
        ? "MCP_READINESS_TIMEOUT"
        : "MCP_SERVER_OPERATION_FAILED",
    );
    const next = {
      ...current,
      ...patch,
      id: serverId,
      serverId,
      desiredRevision: operation.desiredRevision,
      sequence: Number.isSafeInteger(patch.sequence)
        ? patch.sequence
        : current.sequence + 1,
      terminal,
      success,
      error: structuredError,
      errorMessage: structuredError?.message || null,
      updatedAt: now,
      completedAt: terminal ? patch.completedAt || now : null,
    };
    next.revision = next.sequence;
    operation.servers[serverId] = next;
    operation.sequence += 1;
    operation.updatedAt = now;
    operation.status = inferOperationStatus(operation.servers);
    operation.phase =
      operation.status === "running" ? operation.phase : operation.status;
    this._updateProgress(operation);
    if (
      !operation.deferRelease &&
      !["queued", "running"].includes(operation.status)
    ) {
      operation.effectsFinalized = true;
      operation.completedAt = now;
      if (this._activeOperationId === operationId) {
        this._activeOperationId = null;
      }
      this._releaseOwners(operation);
    }
    this._publishLifecycle(operation, next);
    this._emit(operation);
    this._audit("server_transition", operation, next);
    return { accepted: true, operation: this._snapshot(operation) };
  }

  completeOperation(operationId, options = {}) {
    const operation = this._operations.get(operationId);
    if (!operation) {
      return null;
    }
    for (const row of Object.values(operation.servers)) {
      if (row.terminal) continue;
      this.updateServer(operationId, row.serverId, {
        status: options.status || "succeeded",
        phase: options.phase || (operation.targetEnabled ? "tool_ready" : "disabled"),
        healthy: options.healthy ?? operation.targetEnabled,
        success: options.success ?? true,
        error: options.error || null,
        terminal: true,
      });
    }
    return this.getMcpOperation(operationId);
  }

  failOperation(operationId, error) {
    const operation = this._operations.get(operationId);
    if (!operation) return null;
    const structuredError = normalizeOperationError(error);
    for (const row of Object.values(operation.servers)) {
      if (row.terminal) continue;
      this.updateServer(operationId, row.serverId, {
        status: "failed",
        phase: "failed",
        outcome: "failed",
        healthy: false,
        success: false,
        error: structuredError,
        terminal: true,
      });
    }
    operation.error = structuredError;
    return this.getMcpOperation(operationId);
  }

  cancelOperation(operationId, options = {}) {
    const operation = this._operations.get(operationId);
    if (!operation || !["queued", "running"].includes(operation.status)) {
      return operation ? this._snapshot(operation) : null;
    }
    const now = this._clock();
    for (const row of Object.values(operation.servers)) {
      if (row.terminal) continue;
      row.status = "interrupted";
      row.phase = "interrupted";
      row.terminal = true;
      row.success = false;
      row.error = normalizeOperationError(
        options.error || "Operation interrupted",
        "MCP_OPERATION_INTERRUPTED",
      );
      row.errorMessage = row.error.message;
      row.sequence += 1;
      row.updatedAt = now;
      row.completedAt = now;
      this._publishLifecycle(operation, row);
    }
    operation.sequence += 1;
    operation.status = "interrupted";
    operation.phase = "interrupted";
    operation.error = normalizeOperationError(
      options.error || "Operation interrupted",
      "MCP_OPERATION_INTERRUPTED",
    );
    operation.updatedAt = now;
    operation.completedAt = now;
    operation.effectsFinalized = true;
    if (this._activeOperationId === operationId) {
      this._activeOperationId = null;
    }
    this._releaseOwners(operation);
    this._updateProgress(operation);
    this._emit(operation);
    this._audit("operation_interrupted", operation, null, {
      total: operation.serverIds.length,
    });
    return this._snapshot(operation);
  }

  ownsServer(operationId, serverId) {
    const operation = this._operations.get(operationId);
    const owner = this._serverOwners.get(serverId);
    return Boolean(
      operation &&
        owner &&
        owner.operationId === operationId &&
        owner.desiredRevision === operation.desiredRevision,
    );
  }

  markOperationRunning(operationId) {
    const operation = this._operations.get(operationId);
    if (!operation) return null;
    if (operation.status !== "queued") return this._snapshot(operation);
    operation.status = "running";
    operation.phase = "running";
    operation.sequence += 1;
    operation.updatedAt = this._clock();
    operation.startedAt ||= operation.updatedAt;
    for (const row of Object.values(operation.servers)) {
      row.startedAt ||= operation.updatedAt;
    }
    this._emit(operation);
    this._audit("operation_phase", operation);
    return this._snapshot(operation);
  }

  setOperationPhase(operationId, phase) {
    const operation = this._operations.get(operationId);
    if (!operation) return null;
    if (!["queued", "running"].includes(operation.status)) {
      return this._snapshot(operation);
    }
    operation.phase = String(phase || "running");
    operation.sequence += 1;
    operation.updatedAt = this._clock();
    this._emit(operation);
    this._audit("operation_phase", operation);
    return this._snapshot(operation);
  }

  updateOperationPhase(operationId, phase) {
    return this.setOperationPhase(operationId, phase);
  }

  finalizeOperationEffects(operationId) {
    const operation = this._operations.get(operationId);
    if (!operation) return null;
    if (["queued", "running"].includes(operation.status)) {
      return this._snapshot(operation);
    }
    operation.completedAt ||= this._clock();
    operation.updatedAt = this._clock();
    operation.sequence += 1;
    operation.effectsFinalized = true;
    for (const row of Object.values(operation.servers)) {
      this._publishLifecycle(operation, row);
    }
    if (this._activeOperationId === operationId) {
      this._activeOperationId = null;
    }
    this._releaseOwners(operation);
    this._emit(operation);
    this._audit("operation_terminal", operation, null, {
      total: operation.serverIds.length,
      succeeded: Object.values(operation.servers).filter(
        (row) => row.status === "succeeded",
      ).length,
      actionRequired: Object.values(operation.servers).filter(
        (row) => row.status === "attention_required",
      ).length,
      failed: Object.values(operation.servers).filter((row) =>
        ["failed", "timed_out"].includes(row.status),
      ).length,
    });
    return this._snapshot(operation);
  }

  getActiveMcpOperation() {
    return this._activeOperationId
      ? this.getMcpOperation(this._activeOperationId)
      : null;
  }

  getMcpOperation(operationId) {
    this._pruneHistory();
    const operation = this._operations.get(operationId);
    return operation ? this._snapshot(operation) : null;
  }

  onMcpOperationUpdated(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("onMcpOperationUpdated requires a listener");
    }
    this._events.on("updated", listener);
    return () => this._events.off("updated", listener);
  }

  _snapshot(operation) {
    const serverRows = operation.serverIds.map((serverId) => operation.servers[serverId]);
    const completed = serverRows.filter((row) => row.terminal).length;
    const failed = serverRows.filter((row) =>
      ["failed", "timed_out"].includes(row.status),
    ).length;
    const attentionRequired = serverRows.filter(
      (row) => row.status === "attention_required",
    ).length;
    const timedOut = serverRows.filter((row) => row.status === "timed_out").length;
    const succeeded = serverRows.filter(
      (row) => row.terminal && row.success === true,
    ).length;
    const interrupted = serverRows.filter(
      (row) => row.status === "interrupted",
    ).length;
    const healthy = serverRows.filter(
      (row) => row.healthy === true || row.phase === "tool_ready",
    ).length;
    const disabled = serverRows.filter((row) => row.phase === "disabled").length;
    const summary = {
      total: serverRows.length,
      completed,
      succeeded,
      attentionRequired,
      failed,
      timedOut,
      interrupted,
      healthy,
      disabled,
      actionRequired: attentionRequired,
      percent: operation.progressPercent || 0,
    };
    const requiredActions = serverRows
      .filter((row) => row.requiredAction)
      .map((row) => row.requiredAction);
    return cloneSnapshot({
      ...operation,
      servers: serverRows,
      rows: serverRows,
      serverMap: operation.servers,
      revision: operation.sequence,
      requestedServerIds: operation.serverIds,
      total: serverRows.length,
      completed,
      succeeded,
      failed,
      attentionRequired,
      timedOut,
      interrupted,
      summary,
      progressPercent: operation.progressPercent || 0,
      requiredAction: requiredActions.length > 0 ? requiredActions : null,
    });
  }

  _emit(operation) {
    this._events.emit("updated", this._snapshot(operation));
  }

  _publishLifecycle(operation, row) {
    if (!this._lifecycleUpdater || !row.phase) return;
    this._lifecycleUpdater(row.serverId, row.phase, {
      healthy: row.healthy,
      deploymentType: row.deploymentType,
      error: row.errorMessage,
      operationId: operation.operationId,
      lifecycleSessionId: operation.lifecycleSessionId,
      desiredRevision: operation.desiredRevision,
      transitionSequence: row.sequence,
      operationStatus: operation.status,
      targetEnabled: operation.targetEnabled,
      source: "mcp-operation-manager",
      observedAt: new Date(row.updatedAt || this._clock()).toISOString(),
    });
  }

  _releaseOwners(operation) {
    for (const serverId of operation.serverIds) {
      const owner = this._serverOwners.get(serverId);
      if (owner?.operationId === operation.operationId) {
        this._serverOwners.delete(serverId);
      }
    }
    // Every operation-terminal path (completion, cancel, deferred finalize)
    // funnels through here immediately after clearing _activeOperationId.
    this._notifyMutationIdle();
  }

  _pruneHistory() {
    const cutoff = this._clock() - this._retentionMs;
    for (const [operationId, operation] of this._operations) {
      if (
        operationId === this._activeOperationId ||
        ["queued", "running"].includes(operation.status)
      ) {
        continue;
      }
      if (
        operation.completedAt &&
        (operation.completedAt < cutoff || this._operations.size > this._historyLimit)
      ) {
        this._operations.delete(operationId);
        if (operation.clientRequestId) {
          this._clientRequests.delete(operation.clientRequestId);
        }
      }
    }
  }

  _updateProgress(operation) {
    const rows = Object.values(operation.servers);
    const calculated =
      rows.length === 0
        ? 0
        : Math.floor(
            rows.reduce(
              (total, row) =>
                total +
                (row.terminal
                  ? 100
                  : Number.isFinite(row.progressPercent)
                    ? Math.max(0, Math.min(99, row.progressPercent))
                    : 0),
              0,
            ) / rows.length,
          );
    operation.progressPercent = Math.max(
      operation.progressPercent || 0,
      calculated,
    );
  }
}

const sharedState = require("./shared-state");
const defaultMcpOperationManager = new McpOperationManager({
  lifecycleUpdater: sharedState.updateServerPhase,
});

module.exports = {
  McpOperationManager,
  defaultMcpOperationManager,
  isTerminalServerStatus,
  startMcpOperation: (request) => defaultMcpOperationManager.startMcpOperation(request),
  getActiveMcpOperation: () => defaultMcpOperationManager.getActiveMcpOperation(),
  getMcpOperation: (operationId) => defaultMcpOperationManager.getMcpOperation(operationId),
  onMcpOperationUpdated: (listener) =>
    defaultMcpOperationManager.onMcpOperationUpdated(listener),
  updateMcpOperationServer: (operationId, serverId, patch) =>
    defaultMcpOperationManager.updateServer(operationId, serverId, patch),
  completeMcpOperation: (operationId, options) =>
    defaultMcpOperationManager.completeOperation(operationId, options),
  failMcpOperation: (operationId, error) =>
    defaultMcpOperationManager.failOperation(operationId, error),
  cancelMcpOperation: (operationId, options) =>
    defaultMcpOperationManager.cancelOperation(operationId, options),
  markMcpOperationRunning: (operationId) =>
    defaultMcpOperationManager.markOperationRunning(operationId),
  setMcpOperationPhase: (operationId, phase) =>
    defaultMcpOperationManager.setOperationPhase(operationId, phase),
  updateMcpOperationPhase: (operationId, phase) =>
    defaultMcpOperationManager.updateOperationPhase(operationId, phase),
  finalizeMcpOperationEffects: (operationId) =>
    defaultMcpOperationManager.finalizeOperationEffects(operationId),
};
