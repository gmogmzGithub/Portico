// ============================================================================
// OrbStack-availability messaging for the update pipeline (PORTICO-323, light fix).
//
// When a fresh / not-yet-set-up install tries to self-update with no Docker
// engine present, update PREPARATION fails at the image-pull stage with
// "Automatic Docker recovery failed: OrbStack is not installed." — before the
// stop guard ever runs. The stop-guard fix cannot help that case (you can't
// pull images without a container runtime). Historically the user saw either
// that raw message or a misleading "check your network connection and retry",
// with no mention of the real cause or a way forward.
//
// This helper detects the OrbStack-missing condition from a failure message and
// returns an actionable, plain-language message that points the user at
// installing OrbStack (which guided setup would otherwise do). It does NOT
// change startup ordering — surfacing an actionable error is the light,
// low-risk half of the PORTICO-323 "Expected" behavior; the SetupGate/ordering
// change is tracked separately.
// ============================================================================

// Shown instead of the generic "could not update / check your network" banner
// when the underlying failure is that OrbStack is not installed.
const ORBSTACK_MISSING_UPDATE_MESSAGE =
  "Portico can't finish updating because OrbStack — the container " +
  "runtime it needs — isn't installed. Install OrbStack (https://orbstack.dev), " +
  "then reopen Portico to finish setup.";

function errorIndicatesOrbStackMissing(error) {
  if (!error) {
    return false;
  }
  const message =
    typeof error === "string"
      ? error
      : [error.message, error.cause && error.cause.message]
          .filter(Boolean)
          .join(" ");
  return /orbstack is not installed/i.test(message);
}

// Return the actionable OrbStack-missing message when the failure is caused by
// OrbStack being absent; otherwise return the provided fallback unchanged.
function actionableUpdateFailureMessage(error, fallbackMessage) {
  if (errorIndicatesOrbStackMissing(error)) {
    return ORBSTACK_MISSING_UPDATE_MESSAGE;
  }
  return fallbackMessage;
}

module.exports = {
  ORBSTACK_MISSING_UPDATE_MESSAGE,
  errorIndicatesOrbStackMissing,
  actionableUpdateFailureMessage,
};
