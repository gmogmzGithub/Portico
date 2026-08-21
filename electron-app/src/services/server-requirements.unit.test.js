const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getGuidedSetupDescription,
  getGuidedSetupRequirements,
  getRequiredEnvVars,
  resolveControlPlaneSetupAction,
  serverRequiresConfig,
  serverRequiresConfigurationBeforeOAuth,
  serverRequiresOAuth,
  serverSupportsOAuth,
} = require("./guided-setup/server-requirements");

test("guided setup treats OAuth and configuration as independent requirements", () => {
  const dualRequirementServer = {
    oauth: { requires_user_authorization: true },
    required_env_vars: [{ name: "API_KEY" }],
  };

  assert.deepEqual(getGuidedSetupRequirements(dualRequirementServer), {
    requiresOAuth: true,
    requiresConfig: true,
  });
  assert.equal(serverRequiresOAuth({ oauth: { requires_user_authorization: true } }), true);
  assert.equal(serverRequiresConfig({ required_env_vars: [{ name: "TOKEN" }] }), true);
  assert.equal(serverRequiresConfigurationBeforeOAuth(dualRequirementServer), true);
  assert.equal(
    serverRequiresConfigurationBeforeOAuth({
      oauth: { requires_user_authorization: true },
    }),
    false,
  );
  assert.deepEqual(getGuidedSetupRequirements({ oauth: {} }), {
    requiresOAuth: false,
    requiresConfig: false,
  });
  assert.deepEqual(getRequiredEnvVars({ requiredVars: [{ name: "TOKEN" }] }), [
    { name: "TOKEN" },
  ]);
});

test("Control Plane gives authentication precedence over configuration", () => {
  const dualRequirementServer = {
    oauth: { requires_user_authorization: true },
    requiredVars: [{ name: "API_KEY" }],
    isConfigured: false,
    hasOAuthTokens: false,
  };

  assert.equal(serverSupportsOAuth(dualRequirementServer), true);
  assert.equal(
    serverSupportsOAuth({ oauth: { type: "non-dcr" } }),
    true,
  );
  assert.equal(
    resolveControlPlaneSetupAction(dualRequirementServer),
    "authenticate",
  );
  assert.equal(
    resolveControlPlaneSetupAction({
      ...dualRequirementServer,
      hasOAuthTokens: true,
    }),
    "configure",
  );
  assert.equal(
    resolveControlPlaneSetupAction({
      ...dualRequirementServer,
      hasOAuthTokens: true,
      isConfigured: true,
    }),
    null,
  );
});

test("Control Plane preserves auth-only and config-only setup behavior", () => {
  assert.equal(
    resolveControlPlaneSetupAction({
      oauth: { type: "dcr" },
      hasOAuthTokens: false,
      isConfigured: true,
    }),
    "authenticate",
  );
  assert.equal(
    resolveControlPlaneSetupAction({
      requiredVars: [{ name: "TOKEN" }],
      isConfigured: false,
    }),
    "configure",
  );
  assert.equal(resolveControlPlaneSetupAction({ isConfigured: true }), null);
});

test("guided setup descriptions prefer dedicated copy and fall back to general metadata", () => {
  assert.equal(
    getGuidedSetupDescription({
      guidedSetupDescription: "Guided copy",
      description: "General copy",
    }),
    "Guided copy",
  );
  assert.equal(
    getGuidedSetupDescription({
      guided_setup_description: "Snake-case guided copy",
      description: "General copy",
    }),
    "Snake-case guided copy",
  );
  assert.equal(
    getGuidedSetupDescription({ description: " General copy " }),
    "General copy",
  );
  assert.equal(getGuidedSetupDescription({}), "");
});
