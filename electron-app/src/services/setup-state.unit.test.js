const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setupState,
  getCurrentStage,
  getOnboardingMode,
  setCurrentStage,
  setOnboardingMode,
  getSelectedServers,
  setSelectedServers,
  addSelectedServer,
  removeSelectedServer,
  getServerConfigs,
  setServerConfigs,
  getCurrentServerIndex,
  setCurrentServerIndex,
  getEnvVars,
  getEnvVar,
  setEnvVar,
  getMcpServers,
  setMcpServers,
  isBrowserVisible,
  setBrowserVisible,
  isHostModeSupported,
  setHostModeSupported,
  getCompletedSteps,
  markPrerequisitesCompleted,
  markServerSelectionCompleted,
  markServerCompleted,
  getConfiguredServers,
  addConfiguredServer,
  removeConfiguredServer,
  hasConfiguredServer,
  getSkippedServers,
  addSkippedServer,
  removeSkippedServer,
  hasSkippedServer,
  clearServerTracking,
  getOAuthServers,
  setOAuthServers,
  getCurrentOAuthIndex,
  setCurrentOAuthIndex,
  getCompletedOAuthServers,
  addCompletedOAuthServer,
  hasCompletedOAuthServer,
  getConnectedOAuthServers,
  addConnectedOAuthServer,
  hasConnectedOAuthServer,
  getSkippedOAuthServers,
  addSkippedOAuthServer,
  hasSkippedOAuthServer,
  markOAuthCompleted,
  clearOAuthTracking,
  resetState,
} = require("./guided-setup/setup-state");

test.beforeEach(() => {
  resetState();
});

test("resetState restores guided setup defaults including saved mode and oauth step tracking", () => {
  setupState.currentStage = "finalize";
  setupState.savedOnboardingMode = "basic";
  setupState.serverSelectionHydrated = true;
  setOnboardingMode("power");
  addSelectedServer(2);
  setupState.serverConfigs = [{ id: "glean" }];
  addConfiguredServer("glean");
  addSkippedServer("google_workspace");
  setupState.guidedSetupDisabledServerIds.add("data-plat-mcp");
  setupState.guidedSetupDisabledTooltips = {
    "data-plat-mcp": "Disabled in guided setup",
  };
  setupState.completedSteps.prerequisites = true;
  setupState.completedSteps.oauth = true;
  setupState.completedSteps.servers.foo = true;
  setupState.prerequisitesManualVisit = true;
  setupState.oauthStepRequired = false;
  setOAuthServers([{ id: "glean" }]);
  setCurrentOAuthIndex(3);
  addCompletedOAuthServer("glean");
  addConnectedOAuthServer("glean");
  addSkippedOAuthServer("google_workspace");

  resetState();

  assert.equal(setupState.currentStage, "welcome");
  assert.equal(setupState.onboardingMode, null);
  assert.equal(setupState.savedOnboardingMode, null);
  assert.equal(setupState.serverSelectionHydrated, false);
  assert.deepEqual(setupState.selectedServers, []);
  assert.deepEqual(setupState.serverConfigs, []);
  assert.equal(setupState.completedSteps.prerequisites, false);
  assert.equal(setupState.completedSteps.oauth, false);
  assert.deepEqual(setupState.completedSteps.servers, {});
  assert.equal(setupState.prerequisitesManualVisit, false);
  assert.equal(setupState.oauthStepRequired, null);
  assert.deepEqual(setupState.oauthServers, []);
  assert.equal(setupState.currentOAuthIndex, 0);
  assert.equal(setupState.configuredServers.size, 0);
  assert.equal(setupState.skippedServers.size, 0);
  assert.equal(setupState.guidedSetupDisabledServerIds.size, 0);
  assert.deepEqual(setupState.guidedSetupDisabledTooltips, {});
  assert.equal(setupState.completedOAuthServers.size, 0);
  assert.equal(setupState.connectedOAuthServers.size, 0);
  assert.equal(setupState.skippedOAuthServers.size, 0);
});

test("clearOAuthTracking only resets oauth-specific progress without disturbing selected mode", () => {
  setupState.savedOnboardingMode = "basic";
  setOnboardingMode("basic");
  setupState.oauthStepRequired = false;
  setOAuthServers([{ id: "glean" }, { id: "google_workspace" }]);
  setCurrentOAuthIndex(2);
  addCompletedOAuthServer("glean");
  addConnectedOAuthServer("glean");
  addSkippedOAuthServer("google_workspace");

  clearOAuthTracking();

  assert.equal(setupState.onboardingMode, "basic");
  assert.equal(setupState.savedOnboardingMode, "basic");
  assert.deepEqual(setupState.oauthServers, []);
  assert.equal(setupState.oauthStepRequired, null);
  assert.equal(setupState.currentOAuthIndex, 0);
  assert.equal(setupState.completedOAuthServers.size, 0);
  assert.equal(setupState.connectedOAuthServers.size, 0);
  assert.equal(setupState.skippedOAuthServers.size, 0);
});

test("guided setup state getters and setters reflect the full wizard state surface", () => {
  setCurrentStage("oauth");
  setOnboardingMode("power");
  setSelectedServers([1]);
  addSelectedServer(2);
  removeSelectedServer(1);
  setServerConfigs([{ id: "slack" }]);
  setCurrentServerIndex(4);
  setEnvVar("SLACK_TOKEN", "secret");
  setMcpServers([{ id: "slack" }]);
  setBrowserVisible(true);
  setHostModeSupported(false);
  markPrerequisitesCompleted(true);
  setupState.prerequisitesManualVisit = true;
  markServerSelectionCompleted(true);
  markServerCompleted("slack");
  addConfiguredServer("slack");
  addSkippedServer("gitlab");
  setOAuthServers([{ id: "glean" }]);
  setCurrentOAuthIndex(3);
  addCompletedOAuthServer("glean");
  addConnectedOAuthServer("glean");
  addSkippedOAuthServer("google_workspace");
  markOAuthCompleted(true);

  assert.equal(getCurrentStage(), "oauth");
  assert.equal(getOnboardingMode(), "power");
  assert.deepEqual(getSelectedServers(), [2]);
  assert.deepEqual(getServerConfigs(), [{ id: "slack" }]);
  assert.equal(getCurrentServerIndex(), 4);
  assert.deepEqual(getEnvVars(), { SLACK_TOKEN: "secret" });
  assert.equal(getEnvVar("SLACK_TOKEN"), "secret");
  assert.deepEqual(getMcpServers(), [{ id: "slack" }]);
  assert.equal(isBrowserVisible(), true);
  assert.equal(isHostModeSupported(), false);
  assert.equal(getCompletedSteps().prerequisites, true);
  assert.equal(setupState.prerequisitesManualVisit, true);
  assert.equal(getCompletedSteps().serverSelection, true);
  assert.equal(getCompletedSteps().servers.slack, true);
  assert.equal(getConfiguredServers().has("slack"), true);
  assert.equal(hasConfiguredServer("slack"), true);
  assert.equal(getSkippedServers().has("gitlab"), true);
  assert.equal(hasSkippedServer("gitlab"), true);
  assert.deepEqual(getOAuthServers(), [{ id: "glean" }]);
  assert.equal(getCurrentOAuthIndex(), 3);
  assert.equal(getCompletedOAuthServers().has("glean"), true);
  assert.equal(hasCompletedOAuthServer("glean"), true);
  assert.equal(getConnectedOAuthServers().has("glean"), true);
  assert.equal(hasConnectedOAuthServer("glean"), true);
  assert.equal(getSkippedOAuthServers().has("google_workspace"), true);
  assert.equal(hasSkippedOAuthServer("google_workspace"), true);

  removeConfiguredServer("slack");
  removeSkippedServer("gitlab");
  clearServerTracking();

  assert.equal(getConfiguredServers().size, 0);
  assert.equal(getSkippedServers().size, 0);
});
