const { normalizePlausibleEmail } = require("./setup-auth-shared");

const IDENTITY_RECONCILIATION_REASONS = new Set([
  "env-missing",
  "env-empty",
  "env-user-missing",
  "env-user-placeholder",
]);

// PORTICO-414: an authenticated identity result whose session carries no
// plausible email cannot support restricted publish/install or OWUI seeding;
// the decision pipeline escalates it to an identity-repair sign-in.
function identityResultLacksEmail(identity) {
  return (
    identity?.authenticated === true &&
    !normalizePlausibleEmail(identity?.sessionSummary?.user?.email)
  );
}

const BLOCKING_SETUP_REASONS = new Set([
  "setup-requirement-missing",
  "setup-completion-invalid",
  "project-root-missing",
  "setup-evaluation-error",
]);

const HOST_PREREQUISITE_REASONS = new Set([
  "command-line-tools-unavailable",
  "orbstack-unavailable",
]);

function classifySetupRequirementStatus(status = {}) {
  const reason = typeof status.reason === "string" ? status.reason : null;
  const setupRequirementId =
    typeof status.setupRequirementId === "string"
      ? status.setupRequirementId
      : typeof status.requirement?.data?.setupRequirementId === "string"
        ? status.requirement.data.setupRequirementId
        : null;
  const base = {
    reason,
    reasonMessage:
      typeof status.reasonMessage === "string" ? status.reasonMessage : null,
    setupRequirementId,
    setupOperationId:
      typeof status.setupOperationId === "string"
        ? status.setupOperationId
        : null,
  };

  if (status.needsSetup !== true) {
    return {
      ...base,
      action: "continue",
      safeErrorCode: null,
      setupMode: null,
      seedDefaults: false,
    };
  }
  if (IDENTITY_RECONCILIATION_REASONS.has(reason)) {
    return {
      ...base,
      action: "reconcile_identity",
      safeErrorCode: "SETUP_IDENTITY_RECONCILIATION_REQUIRED",
      setupMode: "identity_repair",
      seedDefaults: false,
    };
  }
  if (reason === "setup-not-completed") {
    return {
      ...base,
      action: "full_setup",
      safeErrorCode: "SETUP_REQUIREMENT_INCOMPLETE",
      setupMode: "full",
      seedDefaults: status.completion?.exists === false,
    };
  }
  if (HOST_PREREQUISITE_REASONS.has(reason)) {
    return {
      ...base,
      action: "full_setup",
      safeErrorCode: "SETUP_HOST_PREREQUISITE_REQUIRED",
      setupMode: "full",
      seedDefaults: false,
    };
  }
  if (reason === "runtime-file-missing") {
    return {
      ...base,
      action: "runtime_repair",
      safeErrorCode: "SETUP_RUNTIME_REPAIR_REQUIRED",
      setupMode: "runtime_repair",
      seedDefaults: false,
    };
  }

  return {
    ...base,
    action: "blocked",
    safeErrorCode: BLOCKING_SETUP_REASONS.has(reason)
      ? "SETUP_STATE_INVALID"
      : "SETUP_STATE_UNRECOGNIZED",
    setupMode: null,
    seedDefaults: false,
    recognizedReason: BLOCKING_SETUP_REASONS.has(reason),
  };
}

// PORTICO-376: On startup a required (mandatory) update must NOT preempt required
// setup or repair. A fresh install, a missing host prerequisite, or a
// stub/legacy managed runtime would dead-end at prep/apply ("Required update
// preparation failed"). Run guided setup FIRST and let the update be re-offered
// on the next launch, once the machine is set up (Command Line Tools and
// OrbStack present, runtime seeded) so it applies cleanly.
//
// Deliberately narrow: `continue` (healthy, set-up machines) and `blocked`
// (invalid/unrecognized state, incl. `setup-evaluation-error`) both fall through
// to the normal update path, so a transient setup-evaluation error cannot hide
// an update.
function shouldDeferRequiredUpdateForSetup(decision = {}) {
  const action = decision && typeof decision.action === "string" ? decision.action : null;
  return action === "full_setup" || action === "runtime_repair";
}

module.exports = {
  BLOCKING_SETUP_REASONS,
  HOST_PREREQUISITE_REASONS,
  IDENTITY_RECONCILIATION_REASONS,
  classifySetupRequirementStatus,
  identityResultLacksEmail,
  shouldDeferRequiredUpdateForSetup,
};
