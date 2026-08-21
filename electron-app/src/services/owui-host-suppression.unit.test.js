const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "owui-host.js",
);
const source = fs.readFileSync(sourcePath, "utf8");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.isConnected = true;
    this.style = {};
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getBoundingClientRect() {
    return {
      x: 0,
      y: 44,
      width: 1200,
      height: 756,
    };
  }

  dispatchEvent() {}
}

class FakeObserver {
  observe() {}
  disconnect() {}
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildHarness() {
  const visibilityCalls = [];
  const createCalls = [];
  const destroyCalls = [];
  const executeCalls = [];
  const warnings = [];
  const dispatchedEvents = [];
  let owuiEventHandler = null;
  const animationFrames = new Map();
  const timers = new Map();
  let nextAnimationFrameId = 1;
  let nextTimerId = 1;
  let currentVisible = true;
  let currentWebContentsId = 40;
  let viewExists = false;
  let captureCallCount = 0;
  let captureImpl = async () => "snapshot-default";
  let destroyImpl = async () => true;
  let executeImpl = async () => "execute-default";

  const element = new FakeElement();
  const window = {
    location: { origin: "app://bundle" },
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    requestAnimationFrame(callback) {
      const id = nextAnimationFrameId;
      nextAnimationFrameId += 1;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    addEventListener() {},
    dispatchEvent(event) {
      dispatchedEvents.push(event);
      return true;
    },
    visualViewport: null,
    electronAPI: {
      owui: {
        async createOrAdoptView(options) {
          createCalls.push(options);
          if (!viewExists) {
            currentWebContentsId += 1;
            viewExists = true;
          }
          currentVisible = options.visible !== false;
          return {
            webContentsId: currentWebContentsId,
            currentUrl: options.url || "http://localhost:3789",
            requestedUrl: options.url || "http://localhost:3789",
            bounds: options.bounds,
            visible: currentVisible,
          };
        },
        async destroyView(viewKey, expectedWebContentsId) {
          destroyCalls.push({ viewKey, expectedWebContentsId });
          const destroyed = await destroyImpl(viewKey, expectedWebContentsId);
          if (
            destroyed !== false &&
            (!expectedWebContentsId || expectedWebContentsId === currentWebContentsId)
          ) {
            viewExists = false;
          }
          return destroyed;
        },
        async executeJavaScript(viewKey, script) {
          executeCalls.push({ viewKey, script });
          try {
            return await executeImpl(viewKey, script);
          } catch (error) {
            if (String(error?.message || error).includes("Unknown OWUI view:")) {
              viewExists = false;
            }
            throw error;
          }
        },
        async setBounds(_viewKey, bounds) {
          return { bounds, visible: currentVisible };
        },
        async setVisible(viewKey, visible) {
          currentVisible = Boolean(visible);
          visibilityCalls.push({ viewKey, visible: currentVisible });
          return { visible: currentVisible };
        },
        capturePage(viewKey) {
          captureCallCount += 1;
          return captureImpl(viewKey, captureCallCount);
        },
        onEvent(callback) {
          owuiEventHandler = callback;
        },
      },
    },
  };

  const context = {
    window,
    document: {
      createElement() {
        return new FakeElement();
      },
    },
    Event: class FakeEvent {
      constructor(type) {
        this.type = type;
      }
    },
    ResizeObserver: FakeObserver,
    MutationObserver: FakeObserver,
    URL,
    console: {
      ...console,
      warn(...args) {
        warnings.push(args);
      },
    },
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  vm.runInNewContext(source, context, { filename: sourcePath });
  window.ensureOwuiHost(element, {
    viewKey: "main",
    windowType: "main",
    url: "http://localhost:3789",
    createImmediately: true,
  });

  async function flushMicrotasks(rounds = 8) {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  }

  function flushAnimationFrames() {
    const callbacks = Array.from(animationFrames.values());
    animationFrames.clear();
    callbacks.forEach((callback) => callback());
  }

  function runAllTimers() {
    const pending = Array.from(timers.values());
    timers.clear();
    pending.forEach(({ callback }) => callback());
  }

  return {
    element,
    createCalls,
    destroyCalls,
    executeCalls,
    visibilityCalls,
    warnings,
    dispatchedEvents,
    window,
    async ready() {
      await flushMicrotasks();
      flushAnimationFrames();
      await flushMicrotasks();
      visibilityCalls.length = 0;
      warnings.length = 0;
    },
    flushMicrotasks,
    flushAnimationFrames,
    runAllTimers,
    setCaptureImpl(nextImpl) {
      captureImpl = nextImpl;
    },
    setDestroyImpl(nextImpl) {
      destroyImpl = nextImpl;
    },
    setExecuteImpl(nextImpl) {
      executeImpl = nextImpl;
    },
    emitOwuiEvent(payload) {
      assert.equal(typeof owuiEventHandler, "function");
      owuiEventHandler(payload);
    },
    getCaptureCallCount() {
      return captureCallCount;
    },
    getTimerDelays() {
      return Array.from(timers.values(), ({ delay }) => delay);
    },
  };
}

test("OWUI hosts distinguish requested and committed URLs and signal adoption", async () => {
  const harness = buildHarness();

  assert.equal(harness.element.getURL(), "http://localhost:3789");
  assert.equal(harness.element.getCommittedURL(), "");

  await harness.ready();
  assert.equal(harness.element.getCommittedURL(), "http://localhost:3789");
  assert.equal(
    harness.dispatchedEvents.some(
      (event) =>
        event.type === "owui-committed-url-changed" &&
        event.detail?.viewKey === "main" &&
        event.detail?.previousUrl === "" &&
        event.detail?.currentUrl === "http://localhost:3789",
    ),
    true,
  );

  harness.emitOwuiEvent({
    type: "did-navigate-in-page",
    viewKey: "main",
    currentUrl: "http://localhost:3789/c/chat-b",
    requestedUrl: "http://localhost:3789/c/chat-a",
    url: "http://localhost:3789/c/chat-b",
  });
  assert.equal(
    harness.element.getCommittedURL(),
    "http://localhost:3789/c/chat-b",
  );
  assert.equal(harness.element.getURL(), "http://localhost:3789/c/chat-b");
  assert.equal(
    harness.dispatchedEvents.at(-1).detail.currentUrl,
    "http://localhost:3789/c/chat-b",
  );
});

test("remount waits for an in-flight native view destroy", async () => {
  const harness = buildHarness();
  await harness.ready();
  const destroy = deferred();
  harness.setDestroyImpl(() => destroy.promise);

  const disposal = harness.window.disposeOwuiHost(harness.element, {
    destroyView: true,
  });
  harness.window.ensureOwuiHost(harness.element, {
    viewKey: "main",
    windowType: "main",
    url: "http://localhost:3789/c/reopened",
    createImmediately: true,
  });
  await harness.flushMicrotasks();

  assert.deepEqual(harness.destroyCalls, [
    { viewKey: "main", expectedWebContentsId: 41 },
  ]);
  assert.equal(harness.createCalls.length, 1);

  destroy.resolve(true);
  await disposal;
  await harness.flushMicrotasks();

  assert.equal(harness.createCalls.length, 2);
  assert.equal(harness.element.getWebContentsId(), 42);
});

test("a missing native view is recreated and the failed operation is retried", async () => {
  const harness = buildHarness();
  await harness.ready();
  let attempts = 0;
  harness.setExecuteImpl(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Unknown OWUI view: main");
    }
    return "recovered";
  });

  const result = await harness.element.executeJavaScript("document.title");
  await harness.flushMicrotasks();

  assert.equal(result, "recovered");
  assert.equal(harness.executeCalls.length, 2);
  assert.equal(harness.element.getWebContentsId(), 42);
  assert.equal(
    harness.warnings.some((args) =>
      String(args[0]).includes("disappeared during executeJavaScript"),
    ),
    true,
  );
});

test("native view destruction is scoped to the instance being disposed", () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const viewsSource = fs.readFileSync(path.join(__dirname, "owui-views.js"), "utf8");

  assert.match(
    preloadSource,
    /destroyView: async \(viewKey, expectedWebContentsId\)[\s\S]*?expectedWebContentsId,/,
  );
  assert.match(
    ipcSource,
    /owui-destroy-view[\s\S]*?owuiViews\.destroyView\(viewKey, expectedWebContentsId\)/,
  );
  assert.match(
    viewsSource,
    /function destroyView\(viewKey, expectedWebContentsId\)[\s\S]*?entry\.view\.webContents\.id !== normalizedExpectedId[\s\S]*?Ignoring stale destroy/,
  );
});

test("a stalled overlay capture never delays hiding the native OWUI view", async () => {
  const harness = buildHarness();
  await harness.ready();
  harness.setCaptureImpl(() => new Promise(() => {}));

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", true);

  assert.deepEqual(harness.visibilityCalls, [
    { viewKey: "main", visible: false },
  ]);
  await harness.flushMicrotasks();
  assert.equal(harness.getCaptureCallCount(), 1);
  assert.deepEqual(harness.getTimerDelays(), [1000]);
});

test("a cached snapshot remains available for later modal suppression", async () => {
  const harness = buildHarness();
  await harness.ready();
  harness.setCaptureImpl(async () => "snapshot-one");

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", true);
  await harness.flushMicrotasks();
  assert.equal(
    harness.element.style.backgroundImage,
    "url(data:image/png;base64,snapshot-one)",
  );
  assert.equal(harness.getCaptureCallCount(), 1);

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", false);
  await harness.flushMicrotasks();
  harness.flushAnimationFrames();
  await harness.flushMicrotasks();
  assert.equal(harness.element.style.backgroundImage, "");

  harness.window.setOwuiInteractionSuppressed("sensitive-info-modal", true);
  assert.equal(
    harness.element.style.backgroundImage,
    "url(data:image/png;base64,snapshot-one)",
  );
  await harness.flushMicrotasks();
  assert.equal(harness.getCaptureCallCount(), 1);
});

test("a late capture cannot repaint after native view suppression ends", async () => {
  const harness = buildHarness();
  await harness.ready();
  const capture = deferred();
  harness.setCaptureImpl(() => capture.promise);

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", true);
  await harness.flushMicrotasks();
  harness.window.setOwuiInteractionSuppressed("oauth-wizard", false);
  await harness.flushMicrotasks();
  harness.flushAnimationFrames();
  await harness.flushMicrotasks();

  capture.resolve("snapshot-too-late");
  await harness.flushMicrotasks();

  assert.deepEqual(harness.visibilityCalls, [
    { viewKey: "main", visible: false },
    { viewKey: "main", visible: true },
  ]);
  assert.equal(harness.element.style.backgroundImage, "");
});

test("overlapping suppression reasons keep OWUI hidden until the final release", async () => {
  const harness = buildHarness();
  await harness.ready();
  harness.setCaptureImpl(async () => "snapshot-overlap");

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", true);
  harness.window.setOwuiInteractionSuppressed("renderer-overlay", true);
  harness.window.setOwuiInteractionSuppressed("oauth-wizard", false);

  assert.deepEqual(harness.visibilityCalls, [
    { viewKey: "main", visible: false },
  ]);

  harness.window.setOwuiInteractionSuppressed("renderer-overlay", false);
  assert.deepEqual(harness.visibilityCalls, [
    { viewKey: "main", visible: false },
    { viewKey: "main", visible: true },
  ]);
});

test("snapshot timeout clears the request so a later modal can retry", async () => {
  const harness = buildHarness();
  await harness.ready();
  harness.setCaptureImpl(() => new Promise(() => {}));

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", true);
  await harness.flushMicrotasks();
  harness.runAllTimers();
  await harness.flushMicrotasks();
  assert.equal(harness.getCaptureCallCount(), 1);
  assert.equal(
    harness.warnings.some((args) => String(args[0]).includes("timed out")),
    true,
  );

  harness.window.setOwuiInteractionSuppressed("oauth-wizard", false);
  await harness.flushMicrotasks();
  harness.window.setOwuiInteractionSuppressed("sensitive-info-modal", true);
  await harness.flushMicrotasks();

  assert.equal(harness.getCaptureCallCount(), 2);
});
