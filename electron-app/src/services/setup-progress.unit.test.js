const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function withFakeDom(run) {
  const progressSteps = [
    "hello",
    "prerequisites",
    "server-selection",
    "oauth",
    "configuration",
    "finalize",
  ].map((stepName) => {
    const step = new FakeElement(`step-${stepName}`);
    step.dataset.step = stepName;
    return step;
  });

  const helloLabel = new FakeElement("progress-label-hello");
  const trackerWrapper = new FakeElement("progress-tracker-wrapper");
  const header = new FakeElement("panel-header");
  const tracker = new FakeElement("progress-tracker");

  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      switch (id) {
        case "progress-label-hello":
          return helloLabel;
        case "progress-tracker-wrapper":
          return trackerWrapper;
        case "panel-header":
          return header;
        default:
          return null;
      }
    },
    querySelectorAll(selector) {
      if (selector === ".progress-step") {
        return progressSteps;
      }
      return [];
    },
    querySelector(selector) {
      if (selector === ".progress-tracker") {
        return tracker;
      }
      return null;
    },
  };

  const modulePath = require.resolve("../renderer/components/setup-progress");
  delete require.cache[modulePath];
  const loaded = require("../renderer/components/setup-progress");

  try {
    run({ loaded, progressSteps, helloLabel, trackerWrapper, header, tracker });
  } finally {
    global.document = previousDocument;
  }
}

function getStep(steps, stepName) {
  return steps.find((step) => step.dataset.step === stepName);
}

test("updateProgressTracker applies active/completed states and hides irrelevant steps", () => {
  withFakeDom(({ loaded, progressSteps, helloLabel }) => {
    loaded.updateProgressTracker(
      "oauth",
      {
        prerequisites: true,
        prerequisitesWarning: false,
        serverSelection: true,
        oauth: false,
        servers: {},
      },
      [],
      "power",
      { showStep: true },
      true,
    );

    assert.equal(helloLabel.textContent, "Power");
    assert(getStep(progressSteps, "hello").classList.contains("completed"));
    assert(getStep(progressSteps, "prerequisites").classList.contains("completed"));
    assert(getStep(progressSteps, "server-selection").classList.contains("completed"));
    assert(getStep(progressSteps, "oauth").classList.contains("active"));
    assert(getStep(progressSteps, "configuration").classList.contains("inactive"));

    loaded.updateProgressTracker(
      "configuration",
      {
        prerequisites: true,
        prerequisitesWarning: false,
        serverSelection: true,
        oauth: true,
        servers: {},
      },
      [],
      "basic",
      { showStep: false },
      false,
    );

    assert.equal(helloLabel.textContent, "Basic");
    assert.equal(getStep(progressSteps, "prerequisites").style.display, "none");
    assert.equal(getStep(progressSteps, "server-selection").style.display, "none");
    assert.equal(getStep(progressSteps, "oauth").style.display, "none");
    assert.equal(getStep(progressSteps, "configuration").style.display, "none");
  });
});

test("updateProgressTracker marks Connect as partial when OAuth work was skipped and Configure as partial when servers remain", () => {
  withFakeDom(({ loaded, progressSteps }) => {
    loaded.updateProgressTracker(
      "configuration",
      {
        prerequisites: true,
        prerequisitesWarning: false,
        serverSelection: true,
        oauth: true,
        servers: {
          slack: true,
        },
      },
      [{ id: "slack" }, { id: "sourcegraph" }, { id: "gitlab" }],
      "power",
      { showStep: true },
      true,
      {
        oauthServers: [{ id: "glean" }, { id: "google_workspace" }],
        completedOAuthServers: new Set(),
        connectedOAuthServers: new Set(),
        skippedOAuthServers: new Set(["glean", "google_workspace"]),
        configuredServers: new Set(["slack"]),
        skippedServers: new Set(["gitlab"]),
      },
    );

    const oauthStep = getStep(progressSteps, "oauth");
    const configurationStep = getStep(progressSteps, "configuration");

    assert.equal(oauthStep.classList.contains("partial"), true);
    assert.equal(oauthStep.classList.contains("completed"), false);
    assert.equal(configurationStep.classList.contains("active"), true);

    loaded.updateProgressTracker(
      "oauth",
      {
        prerequisites: true,
        prerequisitesWarning: false,
        serverSelection: true,
        oauth: false,
        servers: {
          slack: true,
        },
      },
      [{ id: "slack" }, { id: "sourcegraph" }, { id: "gitlab" }],
      "power",
      { showStep: true },
      true,
      {
        oauthServers: [{ id: "glean" }, { id: "google_workspace" }],
        completedOAuthServers: new Set(),
        connectedOAuthServers: new Set(),
        skippedOAuthServers: new Set(),
        configuredServers: new Set(["slack"]),
        skippedServers: new Set(["gitlab"]),
      },
    );

    assert.equal(getStep(progressSteps, "oauth").classList.contains("active"), true);
    assert.equal(getStep(progressSteps, "configuration").classList.contains("partial"), true);
    assert.equal(getStep(progressSteps, "configuration").classList.contains("completed"), false);
  });
});

test("updateProgressTracker keeps Connect visible and completed after all OAuth work finishes", () => {
  withFakeDom(({ loaded, progressSteps }) => {
    loaded.updateProgressTracker(
      "configuration",
      {
        prerequisites: true,
        prerequisitesWarning: false,
        serverSelection: true,
        oauth: true,
        servers: {},
      },
      [{ id: "sourcegraph" }],
      "power",
      { showStep: true },
      false,
      {
        oauthServers: [{ id: "glean" }, { id: "google_workspace" }],
        completedOAuthServers: new Set(["glean"]),
        connectedOAuthServers: new Set(["glean", "google_workspace"]),
        skippedOAuthServers: new Set(),
        configuredServers: new Set(),
        skippedServers: new Set(),
      },
    );

    const oauthStep = getStep(progressSteps, "oauth");
    assert.equal(oauthStep.style.display, "");
    assert.equal(oauthStep.classList.contains("completed"), true);
    assert.equal(oauthStep.classList.contains("partial"), false);
  });
});

test("isStepAccessible follows prereq bypass, oauth omission, and finalize gating", () => {
  withFakeDom(({ loaded }) => {
    const completed = {
      prerequisites: false,
      prerequisitesWarning: false,
      serverSelection: true,
      oauth: false,
      servers: {},
    };

    assert.equal(
      loaded.isStepAccessible(
        "server-selection",
        completed,
        [],
        "hello",
        "power",
        { showStep: false },
        true,
      ),
      true,
    );
    assert.equal(
      loaded.isStepAccessible(
        "oauth",
        completed,
        [],
        "server-selection",
        "power",
        { showStep: true },
        false,
      ),
      false,
    );
    assert.equal(
      loaded.isStepAccessible(
        "configuration",
        completed,
        [{ id: "slack" }],
        "oauth",
        "power",
        { showStep: true },
        true,
      ),
      false,
    );
    assert.equal(
      loaded.isStepAccessible(
        "configuration",
        { ...completed, oauth: true },
        [{ id: "slack" }],
        "oauth",
        "power",
        { showStep: true },
        true,
      ),
      true,
    );
    assert.equal(
      loaded.isStepAccessible(
        "configuration",
        completed,
        [{ id: "slack" }],
        "server-selection",
        "power",
        { showStep: true },
        false,
      ),
      true,
    );
    assert.equal(
      loaded.isStepAccessible(
        "finalize",
        completed,
        [],
        "configuration",
        "power",
        { showStep: true },
        true,
      ),
      false,
    );
    assert.equal(
      loaded.isStepAccessible(
        "finalize",
        completed,
        [],
        "finalize",
        "power",
        { showStep: true },
        true,
      ),
      true,
    );
  });
});

test("toggleProgressVisibility hides finalize and compacts active workflow stages", () => {
  withFakeDom(({ loaded, trackerWrapper, header, tracker }) => {
    loaded.toggleProgressVisibility("configuration", { prerequisites: true }, "power", {
      showStep: true,
    });
    assert.equal(trackerWrapper.style.display, "block");
    assert.equal(header.style.display, "none");
    assert(trackerWrapper.classList.contains("compact"));
    assert(header.classList.contains("compact"));
    assert(tracker.classList.contains("compact"));

    loaded.toggleProgressVisibility("finalize", { prerequisites: true }, "power", {
      showStep: true,
    });
    assert.equal(trackerWrapper.style.display, "none");
    assert.equal(header.style.display, "none");
    assert(trackerWrapper.classList.contains("compact"));

    loaded.toggleProgressVisibility("hello", { prerequisites: false }, "power", {
      showStep: true,
    });
    assert.equal(trackerWrapper.style.display, "none");
    assert.equal(header.style.display, "none");
    assert.equal(trackerWrapper.classList.contains("compact"), false);
    assert.equal(header.classList.contains("compact"), false);
    assert.equal(tracker.classList.contains("compact"), false);
  });
});

test("toggleProgressVisibility can keep the tracker visible for a manual prerequisites revisit", () => {
  withFakeDom(({ loaded, trackerWrapper, header, tracker }) => {
    loaded.toggleProgressVisibility(
      "prerequisites",
      { prerequisites: true },
      "power",
      { showStep: true },
      { showPrerequisitesTracker: true },
    );

    assert.equal(trackerWrapper.style.display, "block");
    assert.equal(header.style.display, "none");
    assert.equal(trackerWrapper.classList.contains("compact"), true);
    assert.equal(tracker.classList.contains("compact"), true);
  });
});
