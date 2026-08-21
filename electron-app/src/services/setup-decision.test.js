const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifySetupRequirementStatus,
  shouldDeferRequiredUpdateForSetup,
} = require("./setup-decision");

test("setup decision continues when the setup requirement is satisfied", () => {
  assert.equal(
    classifySetupRequirementStatus({ needsSetup: false }).action,
    "continue",
  );
});

test("setup decision routes identity-only reasons through reconciliation", () => {
  for (const reason of [
    "env-missing",
    "env-empty",
    "env-user-missing",
    "env-user-placeholder",
  ]) {
    const decision = classifySetupRequirementStatus({ needsSetup: true, reason });
    assert.equal(decision.action, "reconcile_identity", reason);
    assert.equal(decision.setupMode, "identity_repair", reason);
  }
});

test("setup decision distinguishes new requirements from runtime repair", () => {
  assert.deepEqual(
    classifySetupRequirementStatus({
      needsSetup: true,
      reason: "setup-not-completed",
      setupRequirementId: "requirement-a",
      completion: { exists: false },
    }),
    {
      action: "full_setup",
      reason: "setup-not-completed",
      reasonMessage: null,
      safeErrorCode: "SETUP_REQUIREMENT_INCOMPLETE",
      setupMode: "full",
      setupOperationId: null,
      setupRequirementId: "requirement-a",
      seedDefaults: true,
    },
  );

  const repair = classifySetupRequirementStatus({
    needsSetup: true,
    reason: "runtime-file-missing",
  });
  assert.equal(repair.action, "runtime_repair");
  assert.equal(repair.safeErrorCode, "SETUP_RUNTIME_REPAIR_REQUIRED");
  assert.equal(repair.setupMode, "runtime_repair");
  assert.equal(repair.seedDefaults, false);
});

test("missing host prerequisites return to full setup", () => {
  for (const reason of ["command-line-tools-unavailable", "orbstack-unavailable"]) {
    const decision = classifySetupRequirementStatus({
      needsSetup: true,
      reason,
      completion: { exists: true },
    });
    assert.equal(decision.action, "full_setup", reason);
    assert.equal(decision.safeErrorCode, "SETUP_HOST_PREREQUISITE_REQUIRED", reason);
    assert.equal(decision.seedDefaults, false, reason);
    assert.equal(shouldDeferRequiredUpdateForSetup(decision), true, reason);
  }
});

test("setup decision fails closed for invalid or unknown setup state", () => {
  for (const reason of [
    "setup-requirement-missing",
    "setup-completion-invalid",
    "project-root-missing",
    "setup-evaluation-error",
    "unexpected-reason",
  ]) {
    assert.equal(
      classifySetupRequirementStatus({ needsSetup: true, reason }).action,
      "blocked",
      reason,
    );
  }
});

// PORTICO-376: a required update is deferred so guided setup runs first for genuine
// not-set-up states. Set-up machines and invalid/error states must fall through
// to the normal update path so a mandatory update is never suppressed.
test("required update is deferred until setup and its host prerequisites are complete", () => {
  const deferred = [
    "setup-not-completed",
    "runtime-file-missing",
    "command-line-tools-unavailable",
    "orbstack-unavailable",
  ];
  for (const reason of deferred) {
    const decision = classifySetupRequirementStatus({ needsSetup: true, reason });
    assert.equal(
      shouldDeferRequiredUpdateForSetup(decision),
      true,
      `expected defer for ${reason} (action ${decision.action})`,
    );
  }

  // Set-up machine: continue -> never defer (mandatory update proceeds).
  assert.equal(
    shouldDeferRequiredUpdateForSetup(classifySetupRequirementStatus({ needsSetup: false })),
    false,
  );

  // Identity reconciliation is not a runtime/OrbStack setup -> do not defer.
  assert.equal(
    shouldDeferRequiredUpdateForSetup(
      classifySetupRequirementStatus({ needsSetup: true, reason: "env-missing" }),
    ),
    false,
  );

  // Invalid / evaluation-error states classify to "blocked" -> do NOT defer,
  // so a transient setup-evaluation error can't hide a mandatory update.
  for (const reason of ["setup-evaluation-error", "setup-requirement-missing", "project-root-missing"]) {
    assert.equal(
      shouldDeferRequiredUpdateForSetup(classifySetupRequirementStatus({ needsSetup: true, reason })),
      false,
      `expected no defer for blocked reason ${reason}`,
    );
  }

  // Defensive: junk input never defers.
  assert.equal(shouldDeferRequiredUpdateForSetup(), false);
  assert.equal(shouldDeferRequiredUpdateForSetup(null), false);
  assert.equal(shouldDeferRequiredUpdateForSetup({}), false);
});

test("identityResultLacksEmail flags only authenticated results without a plausible email", () => {
  const { identityResultLacksEmail } = require("./setup-decision");
  const result = (user, authenticated = true) => ({
    authenticated,
    sessionSummary: { user },
  });

  assert.equal(
    identityResultLacksEmail(result({ id: "jdoe", name: "Jane Doe" })),
    true,
  );
  assert.equal(
    identityResultLacksEmail(result({ id: "jdoe", email: "bare-handle" })),
    true,
  );
  assert.equal(
    identityResultLacksEmail(result({ id: "jdoe", email: "jdoe@example.invalid" })),
    false,
  );
  // Unauthenticated results are the login path's problem, not this predicate's.
  assert.equal(
    identityResultLacksEmail(result({ id: "jdoe" }, false)),
    false,
  );
  assert.equal(identityResultLacksEmail(null), false);
});
