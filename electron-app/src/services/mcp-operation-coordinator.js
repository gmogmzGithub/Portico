const VALID_OPERATION_KINDS = new Set(["enable", "disable", "restart"]);

const PHASE_PROGRESS = Object.freeze({
  queued: 0,
  preflight: 5,
  persisting_toggles: 15,
  regenerating_config: 30,
  resolving_runtime_targets: 45,
  restarting_host: 60,
  restarting_docker: 60,
  reloading_routes: 70,
  waiting_readiness: 80,
});

function normalizeOperationError(error, defaults = {}) {
  if (!error) return null;
  if (typeof error === "object" && error.code && error.message && error.stage) {
    return {
      code: String(error.code),
      message: String(error.message),
      source: String(error.source || defaults.source || "runtime"),
      stage: String(error.stage || defaults.stage || "unknown"),
      retryable: error.retryable !== false,
    };
  }
  return {
    code: String(
      error.errorCode || error.code || defaults.code || "MCP_OPERATION_FAILED",
    ),
    message: String(error.message || error.error || error),
    source: String(error.source || defaults.source || "runtime"),
    stage: String(error.stage || defaults.stage || "unknown"),
    retryable: error.retryable !== false,
  };
}

function normalizeRequestedServers(request = {}) {
  const metadataById = new Map();
  for (const entry of Array.isArray(request.servers) ? request.servers : []) {
    const serverId = String(entry?.serverId || entry?.id || "").trim();
    if (!serverId) continue;
    metadataById.set(serverId, {
      serverId,
      label: String(entry.label || entry.displayName || entry.name || serverId),
      deploymentType:
        entry.deploymentType || entry.deployment_type || null,
    });
  }
  for (const value of Array.isArray(request.serverIds) ? request.serverIds : []) {
    const serverId = String(value || "").trim();
    if (!serverId || metadataById.has(serverId)) continue;
    metadataById.set(serverId, { serverId, label: serverId, deploymentType: null });
  }
  return [...metadataById.values()];
}

function configurationFailureFromResult(result, options = {}) {
  if (!result || typeof result !== "object") return null;
  if (result instanceof Error) return result;
  if (
    options.assumeFailure !== true &&
    result.success !== false &&
    !result.attributedServerId &&
    !result.attributedFailure
  ) {
    return null;
  }

  const attributed =
    result.attributedFailure && typeof result.attributedFailure === "object"
      ? result.attributedFailure
      : null;
  const nestedError = attributed?.error || result.error;
  const message = String(
    attributed?.message ||
      nestedError?.message ||
      nestedError?.error ||
      result.message ||
      nestedError ||
      "Configuration reconciliation failed",
  );
  const error = new Error(message);
  error.code =
    attributed?.code ||
    attributed?.errorCode ||
    result.code ||
    result.errorCode ||
    nestedError?.code ||
    nestedError?.errorCode ||
    "CONFIG_GENERATION_FAILED";
  error.source =
    attributed?.source || nestedError?.source || result.source || "config";
  error.stage =
    attributed?.stage || nestedError?.stage || result.stage || "config_generation";
  error.retryable =
    attributed?.retryable ?? nestedError?.retryable ?? result.retryable ?? true;
  error.serverId =
    attributed?.serverId || result.serverId || result.attributedServerId || null;
  error.attributedServerId =
    result.attributedServerId || attributed?.serverId || result.serverId || null;
  error.configPath =
    attributed?.configPath || nestedError?.configPath || result.configPath || null;
  if (attributed) {
    error.attributedFailure = {
      ...attributed,
      serverId: error.serverId,
      message,
      code: error.code,
      source: error.source,
      stage: error.stage,
      retryable: error.retryable,
      ...(error.configPath ? { configPath: error.configPath } : {}),
    };
  }
  return error;
}

function attributedConfigurationFailure(error, eligibleServerIds) {
  if (!error || typeof error !== "object") return null;
  const attributed =
    error.attributedFailure && typeof error.attributedFailure === "object"
      ? error.attributedFailure
      : error;
  const serverId = String(
    attributed.serverId || error.attributedServerId || error.serverId || "",
  ).trim();
  if (!serverId || !eligibleServerIds.has(serverId)) return null;
  const normalizedError = normalizeOperationError(attributed, {
    code: error.code || "CONFIG_GENERATION_FAILED",
    source: "config",
    stage: "config_generation",
  });
  return {
    serverId,
    error: normalizedError,
    configPath: attributed.configPath || error.configPath || null,
  };
}

class McpOperationCoordinator {
  constructor(options = {}) {
    if (!options.operationManager) {
      throw new TypeError("McpOperationCoordinator requires operationManager");
    }
    if (typeof options.mutateToggles !== "function") {
      throw new TypeError("McpOperationCoordinator requires mutateToggles");
    }
    if (typeof options.restartServers !== "function") {
      throw new TypeError("McpOperationCoordinator requires restartServers");
    }
    if (typeof options.disableServers !== "function") {
      throw new TypeError("McpOperationCoordinator requires disableServers");
    }
    if (typeof options.createReadinessScheduler !== "function") {
      throw new TypeError(
        "McpOperationCoordinator requires createReadinessScheduler",
      );
    }

    this.operationManager = options.operationManager;
    this.mutateToggles = options.mutateToggles;
    // Optional sidecar for PORTICO-410 hard-disable modes; defaults to a no-op so
    // callers that never hard-disable stay unchanged.
    this.mutateDisableModes = options.mutateDisableModes || (async () => {});
    this.restartServers = options.restartServers;
    this.disableServers = options.disableServers;
    this.createReadinessScheduler = options.createReadinessScheduler;
    this.reconcileConfiguration =
      options.reconcileConfiguration || (async () => {});
    this.resolveRuntimeTargets =
      options.resolveRuntimeTargets || (async () => null);
    this.publishTerminalState =
      options.publishTerminalState || (async () => {});
    this.onOperationStarted = options.onOperationStarted || (async () => {});
    this.onOperationEffectsFinalized =
      options.onOperationEffectsFinalized || (async () => {});
    this.operationContextProvider =
      options.operationContextProvider || (() => ({}));
    this.resolveServerLabel = options.resolveServerLabel || (() => null);
    this.inspectServer = options.inspectServer || (async (server) => server);
    this.logger = options.logger || console;
    this.schedule = options.schedule || ((callback) => setImmediate(callback));
    this._scheduledOperationIds = new Set();
  }

  start(request = {}) {
    const kind = String(request.kind || request.action || "").trim();
    if (!VALID_OPERATION_KINDS.has(kind)) {
      throw new TypeError(`Unsupported MCP operation kind: ${kind || "missing"}`);
    }
    const servers = normalizeRequestedServers(request).map((server) => {
      try {
        const resolvedLabel = this.resolveServerLabel(server, request);
        const label = String(resolvedLabel || "").trim();
        return label ? { ...server, label } : server;
      } catch (error) {
        this.logger.warn?.(
          `[MCP Operation] Could not resolve label for ${server.serverId}: ${error.message}`,
        );
        return server;
      }
    });
    if (servers.length === 0) {
      throw new TypeError("At least one MCP server is required");
    }

    const operationContext = this.operationContextProvider(request) || {};
    // PORTICO-410: disable operations may carry a mode ("hard" removes the server
    // from the model's context entirely); enable operations from the UI carry
    // clearDisableMode so a user-initiated enable lifts a hard disable.
    const disableMode =
      kind === "disable" &&
      String(request.disableMode || request.metadata?.disableMode || "")
        .trim()
        .toLowerCase() === "hard"
        ? "hard"
        : null;
    const clearDisableMode =
      kind === "enable" &&
      (request.clearDisableMode === true ||
        request.metadata?.clearDisableMode === true);
    const snapshot = this.operationManager.startMcpOperation({
      ...request,
      metadata: {
        ...operationContext,
        ...(request.metadata || {}),
        ...(disableMode ? { disableMode } : {}),
        ...(clearDisableMode ? { clearDisableMode: true } : {}),
        source:
          request.source ||
          request.metadata?.source ||
          operationContext.source ||
          "main_process",
      },
      action: kind,
      kind,
      targetEnabled: kind !== "disable",
      servers,
      startImmediately: false,
      deferRelease: true,
    });
    if (!this._scheduledOperationIds.has(snapshot.operationId)) {
      this._scheduledOperationIds.add(snapshot.operationId);
      this.schedule(() => {
        void (async () => {
          try {
            await this.onOperationStarted({
              operationId: snapshot.operationId,
              snapshot,
            });
            await this._execute(snapshot.operationId, kind, servers, {
              disableMode,
              clearDisableMode,
            });
          } catch (error) {
            this.logger.error(
              `[MCP Operation] ${snapshot.operationId} failed: ${error.message}`,
            );
            this.operationManager.failOperation(
              snapshot.operationId,
              normalizeOperationError(error, {
                stage: "operation",
                source: "main_process",
              }),
            );
          } finally {
            try {
              await this.onOperationEffectsFinalized({
                operationId: snapshot.operationId,
                snapshot: this.operationManager.getMcpOperation(
                  snapshot.operationId,
                ),
              });
            } catch (error) {
              this.logger.error(
                `[MCP Operation] ${snapshot.operationId} final publication failed: ${error.message}`,
              );
            } finally {
              this.operationManager.finalizeOperationEffects?.(
                snapshot.operationId,
              );
            }
          }
        })();
      });
    }
    return snapshot;
  }

  _activeRows(operationId) {
    const snapshot = this.operationManager.getMcpOperation(operationId);
    return (snapshot?.rows || snapshot?.servers || []).filter(
      (row) => !row.terminal,
    );
  }

  _setPhase(operationId, phase, serverIds = null, extra = {}) {
    const ids = serverIds ? new Set(serverIds) : null;
    if (typeof this.operationManager.updateOperationPhase === "function") {
      this.operationManager.updateOperationPhase(operationId, phase);
    }
    const progressPercent = PHASE_PROGRESS[phase];
    for (const row of this._activeRows(operationId)) {
      if (ids && !ids.has(row.serverId || row.id)) continue;
      this.operationManager.updateServer(operationId, row.serverId || row.id, {
        status: "running",
        phase,
        ...(Number.isFinite(progressPercent) ? { progressPercent } : {}),
        ...extra,
      });
    }
  }

  _terminalize(operationId, serverId, patch) {
    return this.operationManager.updateServer(operationId, serverId, {
      progressPercent: 100,
      terminal: true,
      ...patch,
    });
  }

  async _publishFailure(operationId, server, error, options = {}) {
    if (error?.code === "MCP_SERVER_NOT_FOUND") return;
    await this.publishTerminalState({
      operationId,
      serverId: server.serverId,
      deploymentType: server.deploymentType,
      status: "failed",
      phase: "failed",
      outcome: "failed",
      healthy: false,
      configured: options.configured !== false,
      targetEnabled: options.targetEnabled !== false,
      error,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  }

  async _invokeConfigurationReconciliation(request) {
    try {
      const result = await this.reconcileConfiguration(request);
      return configurationFailureFromResult(result);
    } catch (error) {
      if (error instanceof Error) return error;
      return (
        configurationFailureFromResult(error, { assumeFailure: true }) ||
        new Error(String(error || "Configuration reconciliation failed"))
      );
    }
  }

  async _reconcileConfigurationTargets(operationId, kind, targets) {
    const firstRequest = {
      operationId,
      kind,
      serverIds: targets.map((server) => server.serverId),
      attempt: 1,
      excludedServerIds: [],
    };
    const firstFailure = await this._invokeConfigurationReconciliation(
      firstRequest,
    );
    if (!firstFailure) return targets;

    const eligibleServerIds = new Set(firstRequest.serverIds);
    const attributed = attributedConfigurationFailure(
      firstFailure,
      eligibleServerIds,
    );
    if (!attributed) throw firstFailure;

    const failedTarget = targets.find(
      (server) => server.serverId === attributed.serverId,
    );
    await this.publishTerminalState({
      operationId,
      serverId: attributed.serverId,
      deploymentType: failedTarget?.deploymentType,
      status: "failed",
      phase: "failed",
      outcome: "failed",
      healthy: false,
      configured: false,
      targetEnabled: kind !== "disable",
      error: attributed.error,
      ...(attributed.configPath ? { configPath: attributed.configPath } : {}),
    });
    this._terminalize(operationId, attributed.serverId, {
      status: "failed",
      phase: "failed",
      outcome: "failed",
      healthy: false,
      configured: false,
      success: false,
      error: attributed.error,
      ...(attributed.configPath ? { configPath: attributed.configPath } : {}),
    });

    const remainingTargets = targets.filter(
      (server) => server.serverId !== attributed.serverId,
    );
    if (remainingTargets.length === 0) return remainingTargets;

    const retryFailure = await this._invokeConfigurationReconciliation({
      operationId,
      kind,
      serverIds: remainingTargets.map((server) => server.serverId),
      attempt: 2,
      excludedServerIds: [attributed.serverId],
    });
    if (retryFailure) throw retryFailure;
    return remainingTargets;
  }

  async _execute(operationId, kind, requestedServers, modeOptions = {}) {
    const { disableMode = null, clearDisableMode = false } = modeOptions;
    this.operationManager.markOperationRunning(operationId);
    this._setPhase(operationId, "preflight");

    const inspected = [];
    for (const server of requestedServers) {
      try {
        const inspectedServer = {
          ...server,
          ...(await this.inspectServer(server, {
            kind,
            operationId,
            clearDisableMode,
          })),
        };
        inspected.push(inspectedServer);
        this.operationManager.updateServer(operationId, server.serverId, {
          status: "running",
          phase: "preflight",
          deploymentType: inspectedServer.deploymentType || null,
          label: inspectedServer.label || server.label || server.serverId,
        });
      } catch (error) {
        const normalized = normalizeOperationError(error, {
          code: "MCP_OPERATION_PREFLIGHT_FAILED",
          source: "preflight",
          stage: "preflight",
        });
        await this._publishFailure(operationId, server, normalized, {
          configured: false,
          targetEnabled: kind !== "disable",
        });
        this._terminalize(operationId, server.serverId, {
          status: "failed",
          phase: "failed",
          outcome: "failed",
          success: false,
          error: normalized,
        });
      }
    }

    const actionable = [];
    for (const server of inspected) {
      if (!server.preflightError) {
        actionable.push(server);
        continue;
      }
      const normalized = normalizeOperationError(server.preflightError, {
        source: "preflight",
        stage: "preflight",
      });
      await this._publishFailure(operationId, server, normalized, {
        configured: false,
        targetEnabled: kind !== "disable",
      });
      this._terminalize(operationId, server.serverId, {
        status: "failed",
        phase: "failed",
        outcome: "failed",
        success: false,
        error: normalized,
      });
    }

    if (kind !== "restart" && actionable.length > 0) {
      this._setPhase(
        operationId,
        "persisting_toggles",
        actionable.map((server) => server.serverId),
      );
      // PORTICO-410 ordering keeps every crash window in a safe state: clearing
      // the disable mode BEFORE enabling means an interruption leaves a plain
      // soft-disabled server; setting "hard" AFTER disabling means an
      // interruption leaves a plain soft disable, never an enabled-but-hard
      // contradiction.
      if (kind === "enable" && clearDisableMode) {
        await this.mutateDisableModes(
          (draft) => {
            for (const server of actionable) {
              delete draft[server.serverId];
            }
          },
          { reason: `mcp-operation:${operationId}:clear-disable-mode` },
        );
      }
      await this.mutateToggles(
        (draft) => {
          for (const server of actionable) {
            draft[server.serverId] = kind === "enable";
          }
        },
        {
          reason: `mcp-operation:${operationId}:${kind}`,
          // PORTICO-364: self-heal a malformed mcp_toggles.json instead of
          // dead-ending the enable/disable (applyToggleMutation backs up the
          // invalid file and treats existing state as empty before applying).
          recoverFromParseError: true,
        },
      );
      if (kind === "disable" && disableMode === "hard") {
        await this.mutateDisableModes(
          (draft) => {
            for (const server of actionable) {
              draft[server.serverId] = "hard";
            }
          },
          { reason: `mcp-operation:${operationId}:hard-disable` },
        );
      }
    }

    if (actionable.length === 0) {
      return this.operationManager.getMcpOperation(operationId);
    }

    let configurationRequired = actionable.filter(
      (server) => kind === "enable" && server.requiresConfiguration === true,
    );
    let runtimeTargets = actionable.filter(
      (server) => !configurationRequired.includes(server),
    );

    if (kind === "disable") {
      this._setPhase(
        operationId,
        "regenerating_config",
        runtimeTargets.map((server) => server.serverId),
      );
      const result = await this.disableServers(
        runtimeTargets.map((server) => server.serverId),
        {
          operationId,
          onPhase: (phase, metadata = {}) => {
            this._setPhase(
              operationId,
              phase,
              Array.isArray(metadata.serverIds)
                ? metadata.serverIds
                : runtimeTargets.map((server) => server.serverId),
            );
          },
        },
      );
      await this._applyDisableResults(operationId, runtimeTargets, result);
      return this.operationManager.getMcpOperation(operationId);
    }

    this._setPhase(
      operationId,
      "regenerating_config",
      actionable.map((server) => server.serverId),
    );
    const reconciledTargets = await this._reconcileConfigurationTargets(
      operationId,
      kind,
      actionable,
    );
    configurationRequired = reconciledTargets.filter(
      (server) => kind === "enable" && server.requiresConfiguration === true,
    );
    runtimeTargets = reconciledTargets.filter(
      (server) => !configurationRequired.includes(server),
    );

    for (const server of configurationRequired) {
      const requiredAction = server.requiredAction || "configure";
      await this.publishTerminalState({
        operationId,
        serverId: server.serverId,
        deploymentType: server.deploymentType,
        status: "not_configured",
        phase: "not_configured",
        outcome: "not_configured",
        requiredAction,
        healthy: false,
        configured: false,
        targetEnabled: true,
        configurationIssue: server.configurationIssue || null,
        configurationErrorCode:
          server.configurationErrorCode || "NOT_CONFIGURED",
      });
      this._terminalize(operationId, server.serverId, {
        status: "attention_required",
        phase: "not_configured",
        outcome: "not_configured",
        requiredAction,
        success: true,
        error: null,
        configurationIssue: server.configurationIssue || null,
        configurationErrorCode:
          server.configurationErrorCode || "NOT_CONFIGURED",
        configurationMessage: server.configurationMessage || null,
        requiresSecretReplacement:
          server.requiresSecretReplacement === true,
        recoveryPrompt: server.recoveryPrompt || null,
        recoveryLabel: server.recoveryLabel || null,
      });
    }
    if (runtimeTargets.length === 0) {
      return this.operationManager.getMcpOperation(operationId);
    }

    const composeRuntimeTargets = runtimeTargets.filter(
      (server) => server.deploymentType !== "host",
    );
    let runtimeResolution = { configuredComposeServices: new Set() };
    if (composeRuntimeTargets.length > 0) {
      this._setPhase(
        operationId,
        "resolving_runtime_targets",
        composeRuntimeTargets.map((server) => server.serverId),
      );
      try {
        runtimeResolution = await this.resolveRuntimeTargets({
          operationId,
          kind,
          servers: composeRuntimeTargets,
          serverIds: composeRuntimeTargets.map((server) => server.serverId),
        });
      } catch (error) {
        const normalized = normalizeOperationError(error, {
          code: "MCP_RUNTIME_TARGET_RESOLUTION_FAILED",
          source: "compose",
          stage: "resolving_runtime_targets",
        });
        for (const server of composeRuntimeTargets) {
          await this._publishFailure(operationId, server, normalized, {
            configured: true,
            targetEnabled: true,
          });
          this._terminalize(operationId, server.serverId, {
            status: "failed",
            phase: "failed",
            outcome: "failed",
            success: false,
            error: normalized,
          });
        }
        const failedIds = new Set(
          composeRuntimeTargets.map((server) => server.serverId),
        );
        runtimeTargets = runtimeTargets.filter(
          (server) => !failedIds.has(server.serverId),
        );
        if (runtimeTargets.length === 0) {
          return this.operationManager.getMcpOperation(operationId);
        }
      }
    }

    const restartResult = await this.restartServers(
      runtimeTargets.map((server) => server.serverId),
      {
        operationId,
        kind,
        skipRegeneration: true,
        skipEnsureEnabled: true,
        skipPreReadinessInvalidation: true,
        ...(runtimeResolution?.configuredComposeServices instanceof Set
          ? {
              configuredComposeServices:
                runtimeResolution.configuredComposeServices,
            }
          : runtimeResolution instanceof Set
            ? { configuredComposeServices: runtimeResolution }
            : {}),
        onPhase: (phase, metadata = {}) => {
          this._setPhase(
            operationId,
            phase,
            Array.isArray(metadata.serverIds)
              ? metadata.serverIds
              : runtimeTargets.map((server) => server.serverId),
          );
        },
      },
    );
    const readinessTargets = await this._applyRestartResults(
      operationId,
      runtimeTargets,
      restartResult,
    );
    if (readinessTargets.length === 0) {
      return this.operationManager.getMcpOperation(operationId);
    }

    this._setPhase(
      operationId,
      "waiting_readiness",
      readinessTargets.map((server) => server.serverId),
    );
    const scheduler = this.createReadinessScheduler({
      operationId,
      kind,
      servers: readinessTargets,
    });
    return await scheduler.run(operationId, readinessTargets);
  }

  async _applyDisableResults(operationId, targets, result = {}) {
    const results = new Map(
      (Array.isArray(result.results) ? result.results : [])
        .filter((entry) => entry?.serverId)
        .map((entry) => [entry.serverId, entry]),
    );
    for (const server of targets) {
      const entry = results.get(server.serverId);
      if (entry?.success !== false && (entry || result.success === true)) {
        await this.publishTerminalState({
          operationId,
          serverId: server.serverId,
          deploymentType: server.deploymentType,
          status: "disabled",
          phase: "disabled",
          outcome: "disabled",
          healthy: false,
          targetEnabled: false,
        });
        this._terminalize(operationId, server.serverId, {
          status: "succeeded",
          phase: "disabled",
          outcome: "disabled",
          healthy: false,
          success: true,
          error: null,
        });
        continue;
      }
      const error = normalizeOperationError(
        entry?.startupFailure || entry?.error || result.error || "Disable failed",
        { code: "MCP_DISABLE_FAILED", source: "runtime", stage: "runtime_stop" },
      );
      await this._publishFailure(operationId, server, error, {
        targetEnabled: false,
      });
      this._terminalize(operationId, server.serverId, {
        status: "failed",
        phase: "failed",
        outcome: "failed",
        success: false,
        error,
      });
    }
  }

  async _applyRestartResults(operationId, targets, result = {}) {
    const results = new Map(
      (Array.isArray(result.results) ? result.results : [])
        .filter((entry) => entry?.serverId)
        .map((entry) => [entry.serverId, entry]),
    );
    const readinessTargets = [];
    for (const server of targets) {
      const entry = results.get(server.serverId);
      if (entry?.requiresConfiguration || entry?.errorCode === "NOT_CONFIGURED") {
        const requiredAction = entry?.requiredAction || "configure";
        await this.publishTerminalState({
          operationId,
          serverId: server.serverId,
          deploymentType: server.deploymentType,
          status: "not_configured",
          phase: "not_configured",
          outcome: "not_configured",
          requiredAction,
          healthy: false,
          configured: false,
          targetEnabled: true,
          configurationIssue: entry?.configurationIssue || null,
          configurationErrorCode: entry?.errorCode || "NOT_CONFIGURED",
          configurationMessage: entry?.error || entry?.message || null,
          error: entry?.error || entry?.message || null,
        });
        this._terminalize(operationId, server.serverId, {
          status: "attention_required",
          phase: "not_configured",
          outcome: "not_configured",
          requiredAction,
          success: true,
          error: null,
          configurationIssue: entry?.configurationIssue || null,
          configurationErrorCode: entry?.errorCode || "NOT_CONFIGURED",
          configurationMessage: entry?.error || entry?.message || null,
          requiresSecretReplacement:
            entry?.requiresSecretReplacement === true,
          recoveryPrompt: entry?.recoveryPrompt || null,
          recoveryLabel: entry?.recoveryLabel || null,
        });
        continue;
      }
      if (entry?.success === true || (!entry && result.success === true)) {
        this.operationManager.updateServer(operationId, server.serverId, {
          status: "running",
          phase: "runtime_started",
          progressPercent: 60,
          healthy: false,
          success: null,
          error: null,
        });
        readinessTargets.push({
          ...server,
          deploymentType:
            server.deploymentType === "core" || server.deploymentType === "host"
              ? server.deploymentType
              : entry?.mode || server.deploymentType || "docker",
        });
        continue;
      }
      const error = normalizeOperationError(
        entry?.startupFailure || entry?.error || result.error || "Runtime start failed",
        { code: "MCP_RUNTIME_START_FAILED", source: "runtime", stage: "runtime_start" },
      );
      await this._publishFailure(operationId, server, error, {
        targetEnabled: true,
      });
      this._terminalize(operationId, server.serverId, {
        status: "failed",
        phase: "failed",
        outcome: "failed",
        success: false,
        error,
      });
    }
    return readinessTargets;
  }
}

module.exports = {
  McpOperationCoordinator,
  PHASE_PROGRESS,
  VALID_OPERATION_KINDS,
  normalizeOperationError,
  normalizeRequestedServers,
};
