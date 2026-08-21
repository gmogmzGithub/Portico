const READINESS_PHASE_TOOL_READY = "tool_ready";
const READINESS_PHASE_STARTING = "starting";
const READINESS_PHASE_CHECKING = "checking";
const READINESS_PHASE_CHECKING_TOKENS = "checking_tokens";
const READINESS_PHASE_NEEDS_OAUTH = "needs_oauth";
const READINESS_PHASE_WAITING_CALLBACK = "waiting_callback";
const READINESS_PHASE_TIMEOUT = "timeout";
const READINESS_PHASE_FAILED = "failed";
const READINESS_PHASE_STARTUP_FAILED = "startup_failed";
const READINESS_PHASE_DISABLED = "disabled";
const READINESS_PHASE_NOT_CONFIGURED = "not_configured";
const READINESS_PHASE_NOT_RUNNING = "not_running";

const STATUS_BACKED_READINESS_PHASES = new Set([
  READINESS_PHASE_TOOL_READY,
  READINESS_PHASE_STARTING,
  READINESS_PHASE_CHECKING,
  READINESS_PHASE_CHECKING_TOKENS,
  READINESS_PHASE_NEEDS_OAUTH,
  READINESS_PHASE_WAITING_CALLBACK,
  READINESS_PHASE_TIMEOUT,
  READINESS_PHASE_FAILED,
  READINESS_PHASE_STARTUP_FAILED,
  READINESS_PHASE_DISABLED,
  READINESS_PHASE_NOT_CONFIGURED,
  READINESS_PHASE_NOT_RUNNING,
]);

function normalizePhaseValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function defaultReadinessPhaseForStatus(status) {
  const normalizedStatus = normalizePhaseValue(status);
  if (normalizedStatus === "healthy") {
    return READINESS_PHASE_TOOL_READY;
  }
  if (normalizedStatus && STATUS_BACKED_READINESS_PHASES.has(normalizedStatus)) {
    return normalizedStatus;
  }
  return READINESS_PHASE_STARTING;
}

function canonicalizeReadinessPhase(readiness = {}) {
  const explicitPhase = normalizePhaseValue(
    readiness?.readinessPhase || readiness?.readiness_phase,
  );

  if (explicitPhase === "healthy") {
    return READINESS_PHASE_TOOL_READY;
  }
  if (explicitPhase) {
    return explicitPhase;
  }
  if (readiness?.healthy === true) {
    return READINESS_PHASE_TOOL_READY;
  }
  return defaultReadinessPhaseForStatus(readiness?.status);
}

module.exports = {
  READINESS_PHASE_TOOL_READY,
  READINESS_PHASE_STARTING,
  READINESS_PHASE_CHECKING,
  READINESS_PHASE_CHECKING_TOKENS,
  READINESS_PHASE_NEEDS_OAUTH,
  READINESS_PHASE_WAITING_CALLBACK,
  READINESS_PHASE_TIMEOUT,
  READINESS_PHASE_FAILED,
  READINESS_PHASE_STARTUP_FAILED,
  READINESS_PHASE_DISABLED,
  READINESS_PHASE_NOT_CONFIGURED,
  READINESS_PHASE_NOT_RUNNING,
  canonicalizeReadinessPhase,
  defaultReadinessPhaseForStatus,
};
