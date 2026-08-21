const READINESS_PHASE_TOOL_READY = "tool_ready";
const READINESS_PHASE_STARTING = "starting";
const READINESS_PHASE_CHECKING_TOKENS = "checking_tokens";
const READINESS_PHASE_NEEDS_OAUTH = "needs_oauth";
const READINESS_PHASE_WAITING_CALLBACK = "waiting_callback";
const READINESS_PHASE_DISABLED = "disabled";
const { canonicalizeReadinessPhase } = require("./readiness-phase");

function normalizeReadinessPhase(readiness = {}) {
  if (!readiness || typeof readiness !== "object") {
    return null;
  }

  return canonicalizeReadinessPhase(readiness);
}

function buildEnabledNoopMessage(serverId, readinessPhase, healthy) {
  if (healthy || readinessPhase === READINESS_PHASE_TOOL_READY) {
    return `Server ${serverId} is already enabled and its tools are ready.`;
  }

  if (readinessPhase === READINESS_PHASE_CHECKING_TOKENS) {
    return `Server ${serverId} is already enabled and is checking existing OAuth tokens.`;
  }

  if (
    readinessPhase === READINESS_PHASE_NEEDS_OAUTH ||
    readinessPhase === READINESS_PHASE_WAITING_CALLBACK
  ) {
    return `Server ${serverId} is already enabled and is ready for OAuth authorization.`;
  }

  return `Server ${serverId} is already enabled but is still starting.`;
}

async function detectToggleLifecycleNoop(serverId, enabled, options = {}) {
  if (!serverId || typeof serverId !== "string") {
    throw new TypeError("serverId (string) is required");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled (boolean) is required");
  }
  if (typeof options.isServerEffectivelyEnabled !== "function") {
    throw new TypeError("isServerEffectivelyEnabled (function) is required");
  }

  const effectiveEnabled = await options.isServerEffectivelyEnabled(serverId);
  const getServerReadinessStatus = options.getServerReadinessStatus;
  const getMcpoServerStatus = options.getMcpoServerStatus;
  const deploymentType = options.deploymentType || "docker";

  let readiness = null;
  let readinessPhase = null;
  if (typeof getServerReadinessStatus === "function") {
    readiness = await getServerReadinessStatus(serverId);
    readinessPhase = normalizeReadinessPhase(readiness);
  }

  if (enabled) {
    if (!effectiveEnabled) {
      return null;
    }

    const healthy = Boolean(readiness?.healthy);
    const actionablePhase = healthy
      ? READINESS_PHASE_TOOL_READY
      : readinessPhase;

    if (
      actionablePhase &&
      actionablePhase !== READINESS_PHASE_DISABLED
    ) {
      return {
        enabled: true,
        healthy,
        readinessPhase:
          actionablePhase ||
          (healthy ? READINESS_PHASE_TOOL_READY : READINESS_PHASE_STARTING),
        message: buildEnabledNoopMessage(
          serverId,
          actionablePhase,
          healthy,
        ),
      };
    }

    return null;
  }

  if (effectiveEnabled) {
    return null;
  }

  if (readinessPhase && readinessPhase !== READINESS_PHASE_DISABLED) {
    return null;
  }

  if (
    deploymentType === "docker" &&
    typeof getMcpoServerStatus === "function"
  ) {
    const containerStatus = await getMcpoServerStatus(serverId);
    if (containerStatus?.running) {
      return null;
    }
  }

  return {
    enabled: false,
    healthy: false,
    readinessPhase: READINESS_PHASE_DISABLED,
    message: `Server ${serverId} is already disabled.`,
  };
}

module.exports = {
  detectToggleLifecycleNoop,
  normalizeReadinessPhase,
};
