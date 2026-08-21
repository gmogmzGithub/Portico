const { READINESS_PHASE_DISABLED } = require("./readiness-phase");

// PORTICO-410: a hard-disabled integration must be opaque to the model. The chat
// tool path (mcp-assistant → REST /api/toggle-mcp-server) is the only way the
// model can flip toggles, so this gate is the enforcement chokepoint. The UI
// never goes through it — user-initiated enables travel the IPC/operation
// paths and explicitly clear the disable mode instead.
//
// IMPORTANT: the refusal text is read by the mcp-assistant Rust client, which
// treats certain transport substrings ("nginx", "connection closed",
// "Server disconnected", "timed out") as "toggle likely succeeded". Keep those
// words out of every string below.
const HARD_DISABLED_ERROR_CODE = "INTEGRATION_HARD_DISABLED";

const HARD_DISABLED_ERROR_TEXT =
  "This integration was hard-disabled by the user and cannot be enabled from chat. " +
  "Only the user can re-enable it from the Control Plane.";

function hardDisabledToggleRefusal(serverId) {
  return {
    success: false,
    server_id: serverId,
    enabled: true,
    started: false,
    healthy: false,
    readiness_phase: READINESS_PHASE_DISABLED,
    uiStatus: READINESS_PHASE_DISABLED,
    errorCode: HARD_DISABLED_ERROR_CODE,
    error: HARD_DISABLED_ERROR_TEXT,
    message: HARD_DISABLED_ERROR_TEXT,
  };
}

/**
 * Decide how the REST toggle endpoint should treat a request against a
 * hard-disabled server. Pure — callers supply the current state.
 *
 * Returns null when the request should proceed normally (server not hard
 * disabled, or state has drifted and the normal path should self-heal it).
 * Otherwise returns `{ blocked, response }`:
 *   - blocked=true  → enable attempt refused; respond with `response`.
 *   - blocked=false → disable no-op; already hard-disabled, mode kept.
 */
function evaluateHardDisableToggleGate({
  serverId,
  enabled,
  isHardDisabled,
  currentToggle,
}) {
  if (!isHardDisabled) {
    return null;
  }

  if (enabled) {
    return { blocked: true, response: hardDisabledToggleRefusal(serverId) };
  }

  // Disable request on a hard-disabled server: only short-circuit when the
  // toggle already agrees (false). If state drifted (toggle true while mode
  // says hard), fall through so the normal disable path re-persists toggles
  // and stops the runtime.
  if (currentToggle === false) {
    return {
      blocked: false,
      response: {
        success: true,
        server_id: serverId,
        enabled: false,
        healthy: false,
        readiness_phase: READINESS_PHASE_DISABLED,
        message: `Server ${serverId} is already disabled.`,
      },
    };
  }

  return null;
}

module.exports = {
  HARD_DISABLED_ERROR_CODE,
  HARD_DISABLED_ERROR_TEXT,
  evaluateHardDisableToggleGate,
  hardDisabledToggleRefusal,
};
