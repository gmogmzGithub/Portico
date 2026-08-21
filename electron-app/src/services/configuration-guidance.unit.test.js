const test = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/configuration-guidance");
  delete require.cache[modulePath];
  return require("../renderer/components/configuration-guidance");
}

function createInput(value, options = {}) {
  return {
    value,
    disabled: options.disabled === true,
    dataset: {
      var: options.varName || "TOKEN",
    },
  };
}

test("resolveConfigurationPulseTarget prioritizes confirmation, save, accordion, then null", () => {
  const mod = loadModule();

  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: false,
      confirmationId: "confirmation-1",
      hasFirstAccordion: true,
      firstAccordionDismissed: false,
    }),
    "confirmation",
  );
  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: true,
      hasFirstAccordion: true,
      firstAccordionDismissed: false,
    }),
    "save",
  );
  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: false,
      hasFirstAccordion: true,
      firstAccordionDismissed: false,
    }),
    "accordion",
  );
  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: false,
      hasFirstAccordion: false,
      firstAccordionDismissed: true,
    }),
    null,
  );
});

test("configuration guidance controller tracks first-accordion dismissal and ready states", () => {
  const mod = loadModule();
  const controller = mod.createConfigurationGuidanceController();

  controller.reset("slack");
  assert.deepEqual(controller.getState(), {
    activeServerId: "slack",
    firstAccordionId: null,
    firstAccordionPulseDismissed: false,
  });

  assert.equal(
    controller.startArrival({
      serverId: "slack",
      firstAccordionId: "accordion-1",
      ready: false,
      confirmationId: null,
    }),
    "accordion",
  );
  assert.deepEqual(controller.getState(), {
    activeServerId: "slack",
    firstAccordionId: "accordion-1",
    firstAccordionPulseDismissed: false,
  });

  assert.equal(
    controller.handleAccordionToggle({
      accordionId: "accordion-1",
      isCollapsed: false,
      ready: false,
      confirmationId: null,
    }),
    null,
  );
  assert.equal(controller.getState().firstAccordionPulseDismissed, true);
  assert.equal(
    controller.getPulseTarget({
      ready: false,
      confirmationId: "confirmation-1",
    }),
    "confirmation",
  );
  assert.equal(
    controller.getPulseTarget({
      ready: true,
    }),
    "save",
  );
  assert.equal(controller.getState().firstAccordionPulseDismissed, true);
});

test("evaluateConfigurationReadiness blocks unresolved confirmations and invalid inputs", () => {
  const mod = loadModule();

  assert.deepEqual(
    mod.evaluateConfigurationReadiness([createInput("token")], {}, {
      unresolvedConfirmationCount: 1,
    }),
    {
      ready: false,
      activeInputCount: 1,
      unresolvedConfirmationCount: 1,
    },
  );

  assert.deepEqual(
    mod.evaluateConfigurationReadiness(
      [createInput(""), createInput("disabled", { disabled: true })],
      {
        validateEnvValue() {
          return { valid: false, value: "" };
        },
      },
    ),
    {
      ready: false,
      activeInputCount: 1,
      unresolvedConfirmationCount: 0,
    },
  );

  assert.deepEqual(
    mod.evaluateConfigurationReadiness([createInput("  abc  ")], {}),
    {
      ready: true,
      activeInputCount: 1,
      unresolvedConfirmationCount: 0,
    },
  );
});
