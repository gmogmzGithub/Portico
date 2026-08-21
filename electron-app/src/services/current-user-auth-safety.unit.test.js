const test = require("node:test");
const assert = require("node:assert/strict");

const currentUserPath = require.resolve("./current-user");
const bootstrapPath = require.resolve("./bootstrap");
const setupAuthPath = require.resolve("./setup-auth");

function loadCurrentUserTestHelpers() {
  const previousCurrentUser = require.cache[currentUserPath];
  const previousBootstrap = require.cache[bootstrapPath];
  const previousSetupAuth = require.cache[setupAuthPath];
  require.cache[bootstrapPath] = {
    id: bootstrapPath,
    filename: bootstrapPath,
    loaded: true,
    exports: { PROJECT_ROOT: "/tmp/project" },
  };
  require.cache[setupAuthPath] = {
    id: setupAuthPath,
    filename: setupAuthPath,
    loaded: true,
    exports: {},
  };
  delete require.cache[currentUserPath];
  const helpers = require("./current-user")._test;

  return {
    helpers,
    restore() {
      delete require.cache[currentUserPath];
      for (const [modulePath, previous] of [
        [bootstrapPath, previousBootstrap],
        [setupAuthPath, previousSetupAuth],
      ]) {
        if (previous) require.cache[modulePath] = previous;
        else delete require.cache[modulePath];
      }
      if (previousCurrentUser) require.cache[currentUserPath] = previousCurrentUser;
    },
  };
}

test("identity-sync failures expose only fixed codes and copy", () => {
  const loaded = loadCurrentUserTestHelpers();
  const error = new Error(
    "Failed to write /Users/example/private/.env for employee@example.com",
  );
  error.code = "EACCES_PRIVATE";
  const result = loaded.helpers.buildIdentitySyncFailure(
    { source: "interactive" },
    error,
  );

  assert.deepEqual(result, {
    success: false,
    authenticated: false,
    sessionSummary: null,
    source: "interactive",
    error: "The signed-in account could not be saved locally. Try again.",
    errorCode: "identity_sync_failed",
  });
  assert.doesNotMatch(JSON.stringify(result), /Users|employee|EACCES_PRIVATE/);
  loaded.restore();
});
