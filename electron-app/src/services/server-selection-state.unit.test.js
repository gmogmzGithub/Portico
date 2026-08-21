const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGuidedSetupSelectionToToggles,
  getGuidedSetupDisabledTooltip,
  getHydratedGuidedSetupSelectionIndices,
  isGuidedSetupEffectivelyEnabledServer,
  isGuidedSetupConfiguredServer,
  isGuidedSetupDisabledServer,
  isGuidedSetupVisibleServer,
  getSelectedServerIdsFromIndices,
  getSelectedServerIndicesFromIds,
  getServerDeploymentType,
  isGuidedSetupSelectableServer,
} = require("./guided-setup/server-selection-state");

test("isGuidedSetupSelectableServer only allows integrations the guided setup UI can manage", () => {
  assert.equal(isGuidedSetupSelectableServer({ id: "glean" }), true);
  assert.equal(isGuidedSetupSelectableServer({ id: "skills", isCore: true }), false);
  assert.equal(isGuidedSetupSelectableServer({ id: "custom", userInstalled: true }), false);
  assert.equal(
    isGuidedSetupSelectableServer(
      { id: "chrome-devtools", deploymentType: "host" },
      { hostModeSupported: false },
    ),
    false,
  );
});

test("guided setup disabled server ids keep a server visible but non-selectable", () => {
  const server = { id: "data-plat-mcp" };
  const options = {
    guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
    guidedSetupDisabledTooltips: {
      "data-plat-mcp": "Disabled in guided setup",
    },
  };

  assert.equal(isGuidedSetupVisibleServer(server, options), true);
  assert.equal(isGuidedSetupDisabledServer(server, options), true);
  assert.equal(isGuidedSetupSelectableServer(server, options), false);
  assert.equal(getGuidedSetupDisabledTooltip(server, options), "Disabled in guided setup");
});

test("selected server ids reconcile across MCP catalog reordering", () => {
  const before = [
    { id: "glean" },
    { id: "google_workspace" },
    { id: "ownership-mcp" },
  ];
  const selectedIds = getSelectedServerIdsFromIndices(before, [1, 2]);
  const after = [
    { id: "ownership-mcp" },
    { id: "glean" },
    { id: "google_workspace" },
  ];

  assert.deepEqual(selectedIds, ["google_workspace", "ownership-mcp"]);
  assert.deepEqual(getSelectedServerIndicesFromIds(after, selectedIds), [0, 2]);
});

test("guided setup hydration merges current selection with enabled manageable toggles only", () => {
  const servers = [
    { id: "skills", isCore: true },
    { id: "glean", isConfigured: true },
    { id: "custom", userInstalled: true },
    { id: "chrome-devtools", deploymentType: "host", isConfigured: true },
    { id: "google_workspace", isConfigured: true },
  ];

  const selectedIndices = getHydratedGuidedSetupSelectionIndices({
    servers,
    selectedIndices: [4],
    toggles: {
      skills: true,
      glean: true,
      custom: true,
      "chrome-devtools": true,
    },
    hostModeSupported: false,
  });

  assert.deepEqual(selectedIndices, [1, 4]);
});

test("guided setup hydration ignores toggles for guided-setup-disabled servers", () => {
  const servers = [
    { id: "data-plat-mcp" },
    { id: "glean" },
  ];

  const selectedIndices = getHydratedGuidedSetupSelectionIndices({
    servers,
    selectedIndices: [],
    toggles: {
      "data-plat-mcp": true,
      glean: true,
    },
    guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
  });

  assert.deepEqual(selectedIndices, [1]);
});

test("guided setup effective enabled state follows toggles only, even when health disagrees", () => {
  const server = { id: "google_workspace", isConfigured: true };

  assert.equal(
    isGuidedSetupEffectivelyEnabledServer(server, {
      toggles: { google_workspace: false },
      healthStatus: {
        servers: {
          google_workspace: {
            status: "healthy",
            configured: true,
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    isGuidedSetupEffectivelyEnabledServer(server, {
      toggles: { google_workspace: true },
      healthStatus: {
        servers: {
          google_workspace: {
            status: "disabled",
            configured: false,
          },
        },
      },
    }),
    true,
  );
});

test("guided setup toggle persistence only overwrites selectable integrations and forces core on", () => {
  const servers = [
    { id: "skills", isCore: true },
    { id: "glean", isConfigured: true },
    { id: "custom", userInstalled: true },
    { id: "chrome-devtools", deploymentType: "host", isConfigured: true },
    { id: "google_workspace", isConfigured: true },
  ];

  const toggles = applyGuidedSetupSelectionToToggles({
    servers,
    selectedIndices: [4],
    existingToggles: {
      preexisting: true,
      skills: false,
      glean: true,
      custom: true,
      "chrome-devtools": true,
      google_workspace: false,
    },
    hostModeSupported: false,
  });

  assert.deepEqual(toggles, {
    preexisting: true,
    skills: true,
    glean: false,
    custom: true,
    "chrome-devtools": true,
    google_workspace: true,
  });
});

test("guided setup toggle persistence forces guided-setup-disabled servers off", () => {
  const toggles = applyGuidedSetupSelectionToToggles({
    servers: [
      { id: "data-plat-mcp" },
      { id: "glean" },
    ],
    selectedIndices: [1],
    existingToggles: {
      "data-plat-mcp": true,
      glean: false,
    },
    guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
  });

  assert.deepEqual(toggles, {
    "data-plat-mcp": false,
    glean: true,
  });
});

test("server-selection helpers normalize deployment types and configured state edge cases", () => {
  assert.equal(getServerDeploymentType({ deploymentType: "host" }), "host");
  assert.equal(getServerDeploymentType({ deployment_type: "host" }), "host");
  assert.equal(getServerDeploymentType({}), "docker");

  assert.equal(isGuidedSetupConfiguredServer(null), false);
  assert.equal(
    isGuidedSetupConfiguredServer(
      { id: "slack", isConfigured: true },
      {
        servers: {
          slack: {
            status: "not_configured",
          },
        },
      },
    ),
    false,
  );
  assert.equal(
    isGuidedSetupConfiguredServer(
      { id: "slack", isConfigured: false },
      {
        servers: {
          slack: {
            status: "healthy",
            configured: true,
          },
        },
      },
    ),
    true,
  );
  assert.equal(
    isGuidedSetupConfiguredServer(
      { id: "snowflake", isConfigured: false },
      {
        servers: {
          snowflake: {
            status: "healthy",
            configured: false,
          },
        },
      },
    ),
    true,
  );
  assert.equal(
    isGuidedSetupEffectivelyEnabledServer(
      { id: "slack", isConfigured: true },
      {
        toggles: { slack: true },
        healthStatus: {
          servers: {
            slack: {
              status: "disabled",
              configured: true,
            },
          },
        },
      },
    ),
    true,
  );
});

test("selected id hydration ignores duplicates or invalid toggles while preserving explicit ids", () => {
  const servers = [{ id: "glean" }, { id: "slack" }, { id: "sourcegraph" }];

  assert.deepEqual(
    getSelectedServerIdsFromIndices(servers, [0, 0, 9, 1]),
    ["glean", "slack"],
  );
  assert.deepEqual(getSelectedServerIndicesFromIds(servers, ["", "slack"]), [1]);
  assert.deepEqual(
    getHydratedGuidedSetupSelectionIndices({
      servers,
      selectedIndices: [2],
      toggles: [],
    }),
    [2],
  );
});
