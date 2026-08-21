// Electron Shell layer: app-wide toast integrity.
//
// index.html loads control-plane.js, then marketplaces.js, then
// services/manager.js as classic scripts sharing one global scope. Each once
// declared its own top-level `showNotification`, so the LAST script owned the
// global binding for everyone — the "global clobber" regression that made all
// install/publish/delete feedback silently invisible.
//
// In-app DOM toasts are now retired by design (user decision, 2026-07-31):
// `showNotification` logs and forwards to the generic native-notification
// bridge (electronAPI.showNativeNotification → main-process Notification),
// `showManagerNotification` delegates to it, and NO `.notification` /
// `.enhanced-notification` element may ever be created. Chat-status
// notifications keep their own typed path in the main process
// (services/chat-native-notifications.js).
//
// These tests load the three scripts in index.html order into one context and
// pin that contract: the global survives the load order with one shared
// implementation, every call is DOM-free and timer-free, the message reaches
// the native bridge verbatim, and both legacy wrappers still route through
// the shared global (so ~150 call sites and the harness stubs that target it
// keep working).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER_DIR = path.join(__dirname, "..", "renderer", "components");
const CONTROL_PLANE_PATH = path.join(RENDERER_DIR, "control-plane.js");
const MARKETPLACES_PATH = path.join(RENDERER_DIR, "marketplaces.js");
const MANAGER_PATH = path.join(__dirname, "manager.js");

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  _set() {
    const raw = String(this.element.className || "");
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  _write(set) {
    this.element.className = [...set].join(" ");
  }
  add(...names) {
    const set = this._set();
    for (const name of names) set.add(name);
    this._write(set);
  }
  remove(...names) {
    const set = this._set();
    for (const name of names) set.delete(name);
    this._write(set);
  }
  contains(name) {
    return this._set().has(name);
  }
  toggle(name, force) {
    const set = this._set();
    const next = force === undefined ? !set.has(name) : Boolean(force);
    if (next) set.add(name);
    else set.delete(name);
    this._write(set);
    return next;
  }
}

class FakeStyle {
  constructor() {
    this.cssText = "";
    this._props = new Map();
  }
  setProperty(name, value, priority = "") {
    this._props.set(name, { value, priority });
  }
  getPropertyValue(name) {
    return this._props.get(name)?.value || "";
  }
  getPropertyPriority(name) {
    return this._props.get(name)?.priority || "";
  }
  set transform(value) {
    if (/!important/.test(String(value))) return;
    this._props.set("transform", { value: String(value), priority: "" });
  }
  get transform() {
    return this._props.get("transform")?.value || "";
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.id = "";
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._textContent = "";
    this.attributes = new Map();
    this.eventListeners = new Map();
  }
  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }
  get textContent() {
    if (!this.children.length) return this._textContent;
    return (
      this._textContent + this.children.map((c) => c.textContent).join("")
    );
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML || "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  addEventListener(type, handler) {
    const list = this.eventListeners.get(type) || [];
    list.push(handler);
    this.eventListeners.set(type, list);
  }
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  focus() {}
  blur() {}
  click() {}
}

function findByClass(root, className) {
  const out = [];
  const walk = (el) => {
    if (el.classList?.contains?.(className)) out.push(el);
    for (const child of el.children || []) walk(child);
  };
  walk(root);
  return out;
}

// Deterministic timer queue so we can prove no toast lifecycle gets scheduled.
function makeTimerQueue() {
  const timers = [];
  let nextId = 1;
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.push({ id, fn, delay: Number(delay) || 0 });
      return id;
    },
    clearTimeout(id) {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    },
    setInterval() {
      return nextId++;
    },
    clearInterval() {},
    runUpTo(maxDelay) {
      let guard = 0;
      for (;;) {
        const idx = timers.findIndex((t) => t.delay <= maxDelay);
        if (idx < 0) return;
        const [timer] = timers.splice(idx, 1);
        timer.fn();
        if (++guard > 1000) throw new Error("timer runaway");
      }
    },
    pending() {
      return timers.length;
    },
  };
}

function loadToastWorld() {
  const body = new FakeElement("body");
  const head = new FakeElement("head");
  const elementsById = new Map();
  const documentObject = {
    body,
    head,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => {
      if (!elementsById.has(id)) {
        const el = new FakeElement("div");
        el.id = id;
        elementsById.set(id, el);
      }
      return elementsById.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createTextNode: (text) => {
      const el = new FakeElement("span");
      el.textContent = text;
      return el;
    },
  };

  const timerQueue = makeTimerQueue();
  const consoleLogs = [];
  const consoleWarns = [];
  const electronAPI = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        // Every API surface becomes a tolerant async no-op; event
        // subscriptions (onLogOutput etc.) just swallow the callback.
        return () => Promise.resolve({ success: true });
      },
    },
  );

  const windowObject = {
    electronAPI,
    appState: {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    location: { reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document: documentObject,
    console: {
      log: (...args) => consoleLogs.push(args.join(" ")),
      warn: (...args) => consoleWarns.push(args.join(" ")),
      error() {},
      info() {},
    },
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout,
    setInterval: timerQueue.setInterval,
    clearInterval: timerQueue.clearInterval,
    Promise,
    Date,
    Math,
    URL,
    navigator: windowObject.navigator,
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
  };
  context.globalThis = context;

  for (const file of [CONTROL_PLANE_PATH, MARKETPLACES_PATH, MANAGER_PATH]) {
    vm.runInNewContext(fs.readFileSync(file, "utf8"), context, {
      filename: file,
    });
  }

  return { context, windowObject, body, timerQueue, consoleLogs, consoleWarns };
}

function assertNoToastDom(body) {
  assert.strictEqual(findByClass(body, "notification").length, 0);
  assert.strictEqual(findByClass(body, "enhanced-notification").length, 0);
}

test("window.showNotification survives the classic-script load order and stays DOM-free and timer-free", () => {
  const { context, windowObject, body, timerQueue, consoleLogs } =
    loadToastWorld();

  assert.strictEqual(typeof windowObject.showNotification, "function");

  // One shared implementation: the bare identifier later scripts resolve must
  // be the same function as the window binding (no shadow copies — the
  // original global-clobber pin).
  assert.strictEqual(context.showNotification, windowObject.showNotification);

  // Retired-toast pin: no type may create DOM or schedule toast timers.
  const pendingBefore = timerQueue.pending();
  for (const type of ["success", "error", "warning", "info", undefined]) {
    windowObject.showNotification(`msg for ${type || "default"}`, type);
  }
  assertNoToastDom(body);
  assert.strictEqual(timerQueue.pending(), pendingBefore);

  // The message still lands somewhere inspectable (console), tagged by type.
  assert.ok(consoleLogs.some((line) => line.includes("[Notification:error]")));
  assert.ok(
    consoleLogs.some((line) => line.includes("msg for default")),
  );
});

test("marketplaces flows route through the shared no-op global", () => {
  const { context, body, timerQueue, consoleLogs } = loadToastWorld();

  assert.strictEqual(typeof context.showMarketplacesNotification, "function");
  const pendingBefore = timerQueue.pending();
  context.showMarketplacesNotification("Skill uninstalled", "success");

  assertNoToastDom(body);
  assert.strictEqual(timerQueue.pending(), pendingBefore);
  assert.ok(
    consoleLogs.some(
      (line) =>
        line.includes("[Notification:success]") &&
        line.includes("Skill uninstalled"),
    ),
  );
});

test("showNotification forwards title + verbatim message to the native bridge", async () => {
  const { windowObject, body, timerQueue } = loadToastWorld();

  const bridgeCalls = [];
  windowObject.electronAPI = {
    showNativeNotification: (payload) => {
      bridgeCalls.push(payload);
      return Promise.resolve({ shown: true });
    },
  };

  const richError =
    'Failed to install "zeta-skill": a skill with this name already exists.';
  windowObject.showNotification(richError, "error");
  windowObject.showNotification("Agent published.", "success");
  windowObject.showNotification("Marketplace copy kept.", "warning");
  windowObject.showNotification("Plain info line", undefined);
  // Empty messages must not become empty native notifications.
  windowObject.showNotification("   ", "error");

  assert.deepEqual(bridgeCalls, [
    { title: "Error", body: richError },
    { title: "Success", body: "Agent published." },
    { title: "Warning", body: "Marketplace copy kept." },
    { title: "Portico", body: "Plain info line" },
  ]);
  assertNoToastDom(body);
  assert.strictEqual(timerQueue.pending(), 0);
});

test("marketplace flows reach the native bridge through the shared global", () => {
  const { context, windowObject } = loadToastWorld();

  const bridgeCalls = [];
  windowObject.electronAPI = {
    showNativeNotification: (payload) => {
      bridgeCalls.push(payload);
      return Promise.resolve({ shown: true });
    },
  };

  context.showMarketplacesNotification("Skill uninstalled", "success");
  assert.deepEqual(bridgeCalls, [{ title: "Success", body: "Skill uninstalled" }]);
});

test("a missing or failing native bridge never breaks the caller", async () => {
  const { windowObject, consoleLogs, consoleWarns } = loadToastWorld();

  // No bridge at all (e.g. a stripped-down harness window).
  windowObject.electronAPI = {};
  windowObject.showNotification("bridge missing", "error");
  assert.ok(consoleLogs.some((line) => line.includes("bridge missing")));

  // A rejecting bridge is swallowed into a console warning, not an
  // unhandled rejection.
  windowObject.electronAPI = {
    showNativeNotification: () =>
      Promise.reject(new Error("No handler registered")),
  };
  windowObject.showNotification("bridge rejecting", "error");
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    consoleWarns.some(
      (line) =>
        line.includes("Native forward failed") &&
        line.includes("No handler registered"),
    ),
  );
});

test("manager notifications delegate to the shared global without creating DOM", () => {
  const { context, body, timerQueue, consoleLogs } = loadToastWorld();

  assert.strictEqual(typeof context.showManagerNotification, "function");
  const pendingBefore = timerQueue.pending();
  context.showManagerNotification(
    "Services Stopped",
    "All services have been stopped",
    "success",
  );

  assertNoToastDom(body);
  assert.strictEqual(timerQueue.pending(), pendingBefore);
  assert.ok(
    consoleLogs.some(
      (line) =>
        line.includes("[Notification:success]") &&
        line.includes("Services Stopped: All services have been stopped"),
    ),
  );
});
