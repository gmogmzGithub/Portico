const test = require("node:test");
const assert = require("node:assert");

const {
  ORBSTACK_MISSING_UPDATE_MESSAGE,
  errorIndicatesOrbStackMissing,
  actionableUpdateFailureMessage,
} = require("./orbstack-availability");

// ---------------------------------------------------------------------------
// PORTICO-323 (light fix): the OrbStack-absent update failure must produce an
// actionable "install OrbStack" message instead of the raw error or the
// misleading "check your network and retry" banner.
// ---------------------------------------------------------------------------

test("detects the wrapped prep failure (Automatic Docker recovery failed: OrbStack is not installed.)", () => {
  const err = new Error(
    "Automatic Docker recovery failed: OrbStack is not installed.",
  );
  assert.equal(errorIndicatesOrbStackMissing(err), true);
});

test("detects a bare string and a cause chain", () => {
  assert.equal(errorIndicatesOrbStackMissing("OrbStack is not installed."), true);
  assert.equal(
    errorIndicatesOrbStackMissing({
      message: "prep failed",
      cause: { message: "orbstack is not installed" },
    }),
    true,
  );
});

test("does not misfire on unrelated failures", () => {
  assert.equal(errorIndicatesOrbStackMissing(null), false);
  assert.equal(errorIndicatesOrbStackMissing(new Error("network timeout")), false);
  assert.equal(
    errorIndicatesOrbStackMissing(new Error("Docker is not running")),
    false,
  );
});

test("actionableUpdateFailureMessage swaps in the OrbStack message only when relevant", () => {
  const fallback = "check your network and retry";
  assert.equal(
    actionableUpdateFailureMessage(
      "Automatic Docker recovery failed: OrbStack is not installed.",
      fallback,
    ),
    ORBSTACK_MISSING_UPDATE_MESSAGE,
  );
  assert.equal(
    actionableUpdateFailureMessage(new Error("network timeout"), fallback),
    fallback,
  );
});
