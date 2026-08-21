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
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.attributes = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  async dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      await handler({
        target: this,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }

  async click(event = {}) {
    await this.dispatch("click", event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createHarness({ unlocked = false, deferGetState = false } = {}) {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "theme.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  const elements = {
    "theme-toggle": new FakeElement("theme-toggle"),
    "chat-webview": new FakeElement("chat-webview"),
    "konami-modal": new FakeElement("konami-modal"),
    "konami-dismiss-btn": new FakeElement("konami-dismiss-btn"),
    "konami-close-btn": new FakeElement("konami-close-btn"),
  };
  elements["chat-webview"].dataset.owuiViewKey = "main";

  const documentListeners = new Map();
  const storage = createStorage();
  const suppressionCalls = [];
  const setThemeCalls = [];
  const unlockCalls = [];
  const logCalls = [];
  let nowMs = 0;
  const deferredGetState = createDeferred();

  const documentElement = new FakeElement("documentElement");
  documentElement.setAttribute("data-theme", "dark");

  const document = {
    documentElement,
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
    getElementById(id) {
      return elements[id] || null;
    },
    querySelectorAll() {
      return [];
    },
  };

  const context = {
    window: {
      electronAPI: {
        getTheme: async () => "dark",
        setTheme: async (theme) => {
          setThemeCalls.push(theme);
        },
        onThemeChanged() {},
        logToMain: (payload) => {
          logCalls.push(payload);
        },
        owui: {
          setTheme: async () => true,
        },
        konami: {
          getState: async () =>
            (deferGetState ? deferredGetState.promise : { success: true, unlocked }),
          unlock: async (payload) => {
            unlockCalls.push(payload);
            return {
              success: true,
              unlocked: true,
              immediate: true,
              alreadyUnlocked: false,
            };
          },
          onChanged() {},
        },
      },
      localStorage: storage,
      setNativeOverlayInteractionSuppressed(reason, suppressed) {
        suppressionCalls.push({ reason, suppressed });
      },
    },
    document,
    localStorage: storage,
    console,
    setTimeout,
    clearTimeout,
    Date: {
      now: () => nowMs,
    },
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    elements,
    suppressionCalls,
    setThemeCalls,
    unlockCalls,
    logCalls,
    advanceTime(ms) {
      nowMs += ms;
    },
    resolveGetState(payload = { success: true, unlocked }) {
      deferredGetState.resolve(payload);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    async dispatchDOMContentLoaded() {
      const handlers = documentListeners.get("DOMContentLoaded") || [];
      for (const handler of handlers) {
        await handler();
      }
      await this.flush();
    },
    async pressThemeToggle(timeStamp) {
      await this.elements["theme-toggle"].dispatch("pointerdown", {
        button: 0,
        timeStamp,
      });
      await this.elements["theme-toggle"].click({ timeStamp });
      await this.flush();
    },
    async dispatchKeydown(key) {
      const handlers = documentListeners.get("keydown") || [];
      for (const handler of handlers) {
        await handler({ key });
      }
      await this.flush();
    },
  };
}

test("theme toggle unlocks after 10 rapid clicks at <=400ms gaps and shows the Konami modal", async () => {
  const harness = createHarness();
  await harness.dispatchDOMContentLoaded();

  for (let index = 0; index < 10; index += 1) {
    await harness.pressThemeToggle(index * 90);
  }

  assert.equal(harness.unlockCalls.length, 1);
  assert.equal(harness.unlockCalls[0].viewKey, "main");
  assert.equal(harness.elements["konami-modal"].classList.contains("visible"), true);
  assert.equal(
    harness.logCalls.some((entry) => entry.message.includes("Konami detector bootstrap")),
    true,
  );
  assert.equal(
    harness.logCalls.some((entry) => entry.message.includes("Konami unlock IPC request completed")),
    true,
  );
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "konami-modal",
    suppressed: true,
  });

  await harness.elements["konami-dismiss-btn"].click();
  assert.equal(harness.elements["konami-modal"].classList.contains("visible"), false);
  assert.deepEqual(harness.suppressionCalls.at(-1), {
    reason: "konami-modal",
    suppressed: false,
  });
});

test("theme toggle streak resets when any click gap exceeds 400ms", async () => {
  const harness = createHarness();
  await harness.dispatchDOMContentLoaded();

  for (let index = 0; index < 9; index += 1) {
    await harness.pressThemeToggle(index * 90);
  }

  await harness.pressThemeToggle(900 + 401);

  assert.equal(harness.unlockCalls.length, 0);
});

test("already unlocked installs do not retrigger the Konami unlock flow", async () => {
  const harness = createHarness({ unlocked: true });
  await harness.dispatchDOMContentLoaded();

  for (let index = 0; index < 10; index += 1) {
    await harness.pressThemeToggle(index * 90);
  }

  assert.equal(harness.unlockCalls.length, 0);
  assert.equal(harness.elements["konami-modal"].classList.contains("visible"), false);
});

test("theme toggle detector is active before async konami state hydration finishes", async () => {
  const harness = createHarness({ deferGetState: true });
  await harness.dispatchDOMContentLoaded();

  for (let index = 0; index < 10; index += 1) {
    await harness.pressThemeToggle(index * 90);
  }

  assert.equal(harness.unlockCalls.length, 1);

  harness.resolveGetState({ success: true, unlocked: false });
  await harness.flush();

  assert.equal(harness.elements["konami-modal"].classList.contains("visible"), true);
});
