const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/setup-browser");
  delete require.cache[modulePath];
  return require("../renderer/components/setup-browser");
}

function createStyledElement(id = "") {
  const element = new FakeElement(id);
  element.style.setProperty = function setProperty(name, value) {
    this[name] = value;
  };
  element.style.removeProperty = function removeProperty(name) {
    delete this[name];
  };
  return element;
}

function withBrowserDom(run) {
  const mainContainer = createStyledElement("main-container");
  mainContainer.classList.add("browser-hidden");
  mainContainer.offsetWidth = 1000;

  const webview = createStyledElement("browser-webview");
  webview.src = "about:blank";
  webview.loadURLCalls = [];
  webview.loadURL = (url) => {
    webview.loadURLCalls.push(url);
  };
  webview.currentUrl = "https://loaded.example";
  webview.getURL = () => webview.currentUrl;

  const resizeHandle = createStyledElement("resize-handle");
  const setupPanel = createStyledElement("setup-panel");
  const documentListeners = new Map();

  const previousDocument = global.document;
  global.document = {
    body: { style: {} },
    getElementById(id) {
      if (id === "main-container") return mainContainer;
      if (id === "browser-webview") return webview;
      if (id === "resize-handle") return resizeHandle;
      return null;
    },
    querySelector(selector) {
      if (selector === ".setup-panel") return setupPanel;
      if (selector === ".main-container") return mainContainer;
      return null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
  };

  function emitDocumentEvent(type, event) {
    for (const handler of documentListeners.get(type) || []) {
      handler(event);
    }
  }

  try {
    return run({
      mainContainer,
      webview,
      resizeHandle,
      setupPanel,
      emitDocumentEvent,
      documentListeners,
    });
  } finally {
    global.document = previousDocument;
  }
}

test("showBrowser and hideBrowser toggle the panel state and emit log entries", () => {
  withBrowserDom(({ mainContainer }) => {
    const previousAddLog = global.addLog;
    const logs = [];
    global.addLog = (...args) => logs.push(args);

    try {
      const mod = loadModule();
      const setupState = { browserVisible: false };

      mod.showBrowser(setupState);
      mod.showBrowser(setupState);
      assert.equal(setupState.browserVisible, true);
      assert.equal(mainContainer.classList.contains("browser-hidden"), false);

      mod.hideBrowser(setupState);
      mod.hideBrowser(setupState);
      assert.equal(setupState.browserVisible, false);
      assert.equal(mainContainer.classList.contains("browser-hidden"), true);
      assert.deepEqual(logs, [
        ["Browser panel opened", "info"],
        ["Browser panel closed", "info"],
      ]);
    } finally {
      global.addLog = previousAddLog;
    }
  });
});

test("loadBrowserUrl uses the embedded webview for valid URLs and rejects invalid input", () => {
  withBrowserDom(({ webview }) => {
    const previousAddLog = global.addLog;
    const logs = [];
    global.addLog = (...args) => logs.push(args);

    try {
      const mod = loadModule();

      mod.loadBrowserUrl("https://example.test/oauth");
      mod.loadBrowserUrl("ftp://example.test/unsupported");

      assert.deepEqual(webview.loadURLCalls, ["https://example.test/oauth"]);
      assert.deepEqual(logs, [
        ["Loading https://example.test/oauth...", "info"],
        ["Invalid URL: ftp://example.test/unsupported", "error"],
      ]);
    } finally {
      global.addLog = previousAddLog;
    }
  });
});

test("loadBrowserUrl alerts when the browser webview is missing", () => {
  const previousDocument = global.document;
  const previousAlert = global.alert;
  const previousAddLog = global.addLog;
  const alerts = [];
  const logs = [];
  global.alert = (message) => alerts.push(message);
  global.addLog = (...args) => logs.push(args);
  global.document = {
    getElementById() {
      return null;
    },
  };

  try {
    const mod = loadModule();
    mod.loadBrowserUrl("https://example.test");

    assert.deepEqual(logs, [["ERROR: Cannot find browser webview!", "error"]]);
    assert.deepEqual(alerts, [
      "Browser webview not found. The browser panel may not be loaded properly.",
    ]);
  } finally {
    global.document = previousDocument;
    global.alert = previousAlert;
    global.addLog = previousAddLog;
  }
});

test("loadBrowserUrl falls back to the external browser when webview loading throws", () => {
  withBrowserDom(({ webview }) => {
    const previousWindow = global.window;
    const previousAddLog = global.addLog;
    const logs = [];
    const opened = [];
    global.addLog = (...args) => logs.push(args);
    webview.loadURL = () => {
      throw new Error("boom");
    };
    global.window = {
      electronAPI: {
        openUrl(url) {
          opened.push(url);
        },
      },
    };

    try {
      const mod = loadModule();
      mod.loadBrowserUrl("https://example.test/fallback");

      assert.deepEqual(logs, [
        ["Error loading URL: boom", "error"],
      ]);
      assert.deepEqual(opened, ["https://example.test/fallback"]);
    } finally {
      global.window = previousWindow;
      global.addLog = previousAddLog;
    }
  });
});

test("openExternalUrl prefers Electron IPC and falls back to window.open on failure", async () => {
  const previousWindow = global.window;
  const previousAddLog = global.addLog;
  const opened = [];
  const logs = [];
  let rejectNext = false;
  global.addLog = (...args) => logs.push(args);
  global.window = {
    electronAPI: {
      openUrl(url) {
        if (rejectNext) {
          return Promise.reject(new Error("nope"));
        }
        opened.push(["ipc", url]);
        return Promise.resolve();
      },
    },
    open(url, target) {
      opened.push(["window", url, target]);
    },
  };

  try {
    const mod = loadModule();

    mod.openExternalUrl("https://example.test/ipc");
    await Promise.resolve();
    rejectNext = true;
    mod.openExternalUrl("https://example.test/fallback");
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(opened, [
      ["ipc", "https://example.test/ipc"],
      ["window", "https://example.test/fallback", "_blank"],
    ]);
    assert.deepEqual(logs, [
      ["Opening https://example.test/ipc in external browser...", "info"],
      ["Error opening URL: nope", "error"],
    ]);
  } finally {
    global.window = previousWindow;
    global.addLog = previousAddLog;
  }
});

test("setupWebview wires load and popup events through the expected handlers", () => {
  withBrowserDom(({ webview }) => {
    const previousWindow = global.window;
    const previousAddLog = global.addLog;
    const logs = [];
    const opened = [];
    global.addLog = (...args) => logs.push(args);
    global.window = {
      electronAPI: {
        openUrl(url) {
          opened.push(url);
        },
      },
    };

    try {
      const mod = loadModule();
      mod.setupWebview();

      const startHandlers = webview.listeners.get("did-start-loading") || [];
      const finishHandlers = webview.listeners.get("did-finish-load") || [];
      const failHandlers = webview.listeners.get("did-fail-load") || [];
      const popupHandlers = webview.listeners.get("new-window") || [];

      startHandlers[0]();
      finishHandlers[0]();
      failHandlers[0]({ errorCode: -7, errorDescription: "network error" });
      failHandlers[0]({ errorCode: -3, errorDescription: "aborted" });
      let prevented = false;
      popupHandlers[0]({
        url: "https://example.test/popup",
        preventDefault() {
          prevented = true;
        },
      });

      assert.deepEqual(logs, [
        ["Loading page...", "info"],
        ["Page loaded: https://loaded.example", "success"],
        ["Failed to load page: network error", "error"],
      ]);
      assert.deepEqual(opened, ["https://example.test/popup"]);
      assert.equal(prevented, true);
    } finally {
      global.window = previousWindow;
      global.addLog = previousAddLog;
    }
  });
});

test("setupResizeHandle adjusts the panel width within bounds and resets on mouseup", () => {
  withBrowserDom(({ resizeHandle, setupPanel, emitDocumentEvent }) => {
    const mod = loadModule();
    mod.setupResizeHandle();

    resizeHandle.listeners.get("mousedown")[0]({ clientX: 320 });
    assert.equal(resizeHandle.classList.contains("dragging"), true);
    assert.equal(global.document.body.style.cursor, "col-resize");

    emitDocumentEvent("mousemove", { clientX: 500 });
    assert.equal(setupPanel.style.width, "50%");
    assert.equal(setupPanel.style.minWidth, "auto");

    emitDocumentEvent("mousemove", { clientX: 900 });
    assert.equal(setupPanel.style.width, "50%");

    emitDocumentEvent("mouseup", {});
    assert.equal(resizeHandle.classList.contains("dragging"), false);
    assert.equal(global.document.body.style.cursor, "default");
  });
});
