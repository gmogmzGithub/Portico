const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.listeners = new Map();
    this.onclick = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  async click(event = {}) {
    const listeners = this.listeners.get("click") || [];
    for (const handler of listeners) {
      await handler({
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }

    if (typeof this.onclick === "function") {
      await this.onclick({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }

  appendChild(child) {
    this.child = child;
    return child;
  }
}

function buildHarness() {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "control-plane.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  const elements = {
    "config-modal": new FakeElement("config-modal"),
    "config-interface": new FakeElement("config-interface"),
    "setup-wizard-modal": new FakeElement("setup-wizard-modal"),
    "setup-wizard-modal-cancel-btn": new FakeElement("setup-wizard-modal-cancel-btn"),
    "setup-wizard-modal-confirm-btn": new FakeElement("setup-wizard-modal-confirm-btn"),
    "setup-wizard-modal-close-btn": new FakeElement("setup-wizard-modal-close-btn"),
    "loading-progress-close-btn": new FakeElement("loading-progress-close-btn"),
  };

  const documentListeners = new Map();

  const document = {
    head: new FakeElement("head"),
    createElement() {
      return new FakeElement();
    },
    getElementById(id) {
      return elements[id] || null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      documentListeners.set(
        type,
        handlers.filter((item) => item !== handler),
      );
    },
  };

  const suppressionCalls = [];
  const launchedWizardCalls = [];

  const context = {
    window: {
      appState: {
        env: {
          PORTICO_USER_ID: "user@example.com",
          PORTICO_USER_NAME: "Test User",
          PORTICO_REDACT_ALLOW: "*",
          SLACK_TOKEN: "secret",
        },
      },
      setNativeOverlayInteractionSuppressed(reason, suppressed) {
        suppressionCalls.push({ reason, suppressed });
      },
      electronAPI: {
        launchGuidedSetup: async () => {
          launchedWizardCalls.push("launch");
        },
      },
    },
    document,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    Math,
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    elements,
    suppressionCalls,
    launchedWizardCalls,
    window: context.window,
    async dispatchKeydown(key) {
      const handlers = documentListeners.get("keydown") || [];
      for (const handler of [...handlers]) {
        await handler({ key });
      }
    },
  };
}

test("environment variables modal suppresses OWUI interaction while visible", async () => {
  const harness = buildHarness();

  harness.window.showConfiguration();
  assert(harness.elements["config-modal"].classList.contains("visible"));
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "config-modal",
    suppressed: true,
  });

  await harness.dispatchKeydown("Escape");
  assert(!harness.elements["config-modal"].classList.contains("visible"));
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "config-modal",
    suppressed: false,
  });
});

test("setup wizard modal releases OWUI suppression for cancel, close, backdrop, and confirm", async () => {
  const harness = buildHarness();

  harness.window.showSetupWizardModal();
  assert(harness.elements["setup-wizard-modal"].classList.contains("visible"));
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "setup-wizard-modal",
    suppressed: true,
  });

  await harness.elements["setup-wizard-modal-cancel-btn"].click();
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "setup-wizard-modal",
    suppressed: false,
  });

  harness.window.showSetupWizardModal();
  await harness.elements["setup-wizard-modal-close-btn"].click();
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "setup-wizard-modal",
    suppressed: false,
  });

  harness.window.showSetupWizardModal();
  await harness.elements["setup-wizard-modal"].onclick({
    target: harness.elements["setup-wizard-modal"],
  });
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "setup-wizard-modal",
    suppressed: false,
  });

  harness.window.showSetupWizardModal();
  await harness.elements["setup-wizard-modal-confirm-btn"].click();
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "setup-wizard-modal",
    suppressed: false,
  });
  assert.equal(harness.launchedWizardCalls.length, 1);
});
