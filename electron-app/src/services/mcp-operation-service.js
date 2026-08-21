const {
  DEFAULT_OPERATION_WAIT_TIMEOUT_MS,
  operationWaitTimeoutMs,
} = require("./mcp-readiness-scheduler");

const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "attention_required",
  "partial",
  "failed",
  "interrupted",
]);

const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_OPERATION_WAIT_TIMEOUT_MS;

let registeredCoordinator = null;

function coordinatorRegistrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateCoordinator(coordinator) {
  if (!coordinator || typeof coordinator.start !== "function") {
    throw new TypeError("MCP operation coordinator must expose start(request)");
  }
  const manager = coordinator.operationManager;
  if (
    !manager ||
    typeof manager.getActiveMcpOperation !== "function" ||
    typeof manager.getMcpOperation !== "function" ||
    typeof manager.onMcpOperationUpdated !== "function"
  ) {
    throw new TypeError(
      "MCP operation coordinator must expose its operationManager",
    );
  }
}

function registerMcpOperationCoordinator(coordinator) {
  validateCoordinator(coordinator);
  if (registeredCoordinator && registeredCoordinator !== coordinator) {
    throw coordinatorRegistrationError(
      "A different MCP operation coordinator is already registered",
      "MCP_OPERATION_COORDINATOR_ALREADY_REGISTERED",
    );
  }
  registeredCoordinator = coordinator;
  return () => {
    if (registeredCoordinator === coordinator) {
      registeredCoordinator = null;
    }
  };
}

function hasMcpOperationCoordinator() {
  return registeredCoordinator !== null;
}

function requireCoordinator() {
  if (!registeredCoordinator) {
    throw coordinatorRegistrationError(
      "MCP operation coordinator is not initialized",
      "MCP_OPERATION_COORDINATOR_UNAVAILABLE",
    );
  }
  return registeredCoordinator;
}

function startMcpOperation(request) {
  return requireCoordinator().start(request);
}

function getActiveMcpOperation() {
  return requireCoordinator().operationManager.getActiveMcpOperation();
}

function getMcpOperation(operationId) {
  return requireCoordinator().operationManager.getMcpOperation(operationId);
}

function onMcpOperationUpdated(listener) {
  return requireCoordinator().operationManager.onMcpOperationUpdated(listener);
}

function runExclusiveMcpMutation(details, callback) {
  return requireCoordinator().operationManager.runExclusiveMutation(details, callback);
}

function acquireMcpMutationLease(details) {
  return requireCoordinator().operationManager.acquireMutationLease(details);
}

function isTerminalMcpOperation(snapshot) {
  return (
    TERMINAL_OPERATION_STATUSES.has(snapshot?.status) &&
    snapshot?.effectsFinalized !== false
  );
}

function waitForMcpOperation(operationId, options = {}) {
  const coordinator = requireCoordinator();
  const manager = coordinator.operationManager;
  const current = manager.getMcpOperation(operationId);
  if (!current) {
    return Promise.reject(
      coordinatorRegistrationError(
        `MCP operation ${operationId} was not found`,
        "MCP_OPERATION_NOT_FOUND",
      ),
    );
  }
  if (isTerminalMcpOperation(current)) {
    return Promise.resolve(current);
  }
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : operationWaitTimeoutMs(current, DEFAULT_WAIT_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let timer = null;
    const unsubscribe = manager.onMcpOperationUpdated((snapshot) => {
      if (
        snapshot?.operationId !== operationId ||
        !isTerminalMcpOperation(snapshot)
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
    timer = setTimeout(() => {
      unsubscribe();
      reject(
        coordinatorRegistrationError(
          `Timed out waiting for MCP operation ${operationId}`,
          "MCP_OPERATION_WAIT_TIMEOUT",
        ),
      );
    }, timeoutMs);
  });
}

function operationRows(snapshot) {
  if (Array.isArray(snapshot?.rows)) return snapshot.rows;
  if (Array.isArray(snapshot?.servers)) return snapshot.servers;
  return [];
}

function buildLegacyMcpOperationResult(snapshot) {
  const results = operationRows(snapshot).map((row) => {
    const serverId = row.serverId || row.id;
    const pending = row.terminal !== true;
    const readinessPhase = pending
      ? "starting"
      : row.outcome || row.phase || "unknown";
    const success =
      pending || ["succeeded", "attention_required"].includes(row.status);
    return {
      serverId,
      success,
      pending,
      healthy: row.healthy === true,
      readinessPhase,
      readiness_phase: readinessPhase,
      requiresConfiguration:
        row.requiredAction === "configure" || row.outcome === "not_configured",
      requiresAuthentication:
        row.requiredAction === "authenticate" || row.outcome === "needs_oauth",
      requiresSecretReplacement:
        row.requiresSecretReplacement === true ||
        row.requiredAction === "replace_saved_secret",
      configurationIssue: row.configurationIssue || null,
      requiredAction: row.requiredAction || null,
      recoveryPrompt: row.recoveryPrompt || null,
      recoveryLabel: row.recoveryLabel || null,
      uiStatus: readinessPhase,
      errorCode: row.configurationErrorCode || row.error?.code || null,
      error:
        row.error?.message ||
        row.errorMessage ||
        row.configurationMessage ||
        null,
    };
  });
  const errors = results
    .filter((entry) => entry.success === false)
    .map((entry) => `${entry.serverId}: ${entry.error || "Operation failed"}`);
  return {
    success:
      ["queued", "running", "succeeded", "attention_required"].includes(
        snapshot?.status,
      ),
    operationId: snapshot?.operationId || null,
    operation: snapshot || null,
    results,
    errors,
    error: errors[0] || null,
  };
}

async function startAndWaitForMcpOperation(request, options = {}) {
  const started = startMcpOperation(request);
  try {
    const completed = await waitForMcpOperation(started.operationId, options);
    return buildLegacyMcpOperationResult(completed);
  } catch (error) {
    error.operationId = started.operationId;
    error.operation = getMcpOperation(started.operationId);
    throw error;
  }
}

module.exports = {
  DEFAULT_WAIT_TIMEOUT_MS,
  TERMINAL_OPERATION_STATUSES,
  acquireMcpMutationLease,
  buildLegacyMcpOperationResult,
  getActiveMcpOperation,
  getMcpOperation,
  hasMcpOperationCoordinator,
  isTerminalMcpOperation,
  onMcpOperationUpdated,
  registerMcpOperationCoordinator,
  runExclusiveMcpMutation,
  startAndWaitForMcpOperation,
  startMcpOperation,
  waitForMcpOperation,
};
