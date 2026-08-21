const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/setup-copy");
  delete require.cache[modulePath];
  return require("../renderer/components/setup-copy");
}

function withCopyDom(run) {
  const button = new FakeElement("copy-btn");
  const listeners = new Map();
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "copy-btn") {
        return button;
      }
      return null;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
  };

  try {
    return run({ button, listeners });
  } finally {
    global.document = previousDocument;
  }
}

test("copyToClipboard strips HTML, prefers Electron IPC, and restores the button after the timer", () => {
  withCopyDom(({ button }) => {
    const previousWindow = global.window;
    const previousTimeout = global.setTimeout;
    const copied = [];
    let timeoutHandler = null;
    global.window = {
      electronAPI: {
        copyToClipboard(text) {
          copied.push(text);
        },
      },
    };
    global.setTimeout = (handler) => {
      timeoutHandler = handler;
      return 1;
    };
    button.classList.add("copy-pane-button");
    button.innerHTML = "<span>Copy</span>";

    try {
      const mod = loadModule();
      mod.copyToClipboard("<strong>Hello</strong> world", "copy-btn");

      assert.deepEqual(copied, ["Hello world"]);
      assert.equal(button.classList.contains("copied"), true);
      assert.match(button.innerHTML, /Copied!/);
      assert.match(button.innerHTML, /width="16"/);

      timeoutHandler();
      assert.equal(button.classList.contains("copied"), false);
      assert.equal(button.innerHTML, "<span>Copy</span>");
    } finally {
      global.window = previousWindow;
      global.setTimeout = previousTimeout;
    }
  });
});

test("copyToClipboard falls back to navigator.clipboard when Electron IPC is unavailable", () => {
  withCopyDom(({ button }) => {
    const previousWindow = global.window;
    const previousTimeout = global.setTimeout;
    // Node 21+ exposes `navigator` as a built-in non-writable global; Node 20
    // (the project's `engines.node` floor) does not. Cover both cases:
    //   - Missing: install a plain object as `global.navigator` for the test
    //     and remove it on teardown.
    //   - Present (Node 21+): mutate the `clipboard` property on the existing
    //     Navigator instance (assignment to `global.navigator` is a no-op
    //     because the global is non-writable) and restore the original
    //     descriptor on teardown.
    const navigatorWasMissing = typeof global.navigator === "undefined";
    if (navigatorWasMissing) {
      global.navigator = {};
    }
    const previousClipboardDescriptor = Object.getOwnPropertyDescriptor(
      global.navigator,
      "clipboard",
    );
    const copied = [];
    global.window = {
      electronAPI: {},
    };
    Object.defineProperty(global.navigator, "clipboard", {
      value: {
        writeText(text) {
          copied.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
      writable: true,
    });
    global.setTimeout = () => 1;
    button.innerHTML = "Copy";

    try {
      const mod = loadModule();
      mod.copyToClipboard("<em>Slack</em> token", "copy-btn");
      // The mock writeText pushes to `copied` synchronously, so the assertion
      // can run immediately without awaiting microtasks.
      assert.deepEqual(copied, ["Slack token"]);
    } finally {
      global.window = previousWindow;
      global.setTimeout = previousTimeout;
      if (navigatorWasMissing) {
        delete global.navigator;
      } else if (previousClipboardDescriptor) {
        Object.defineProperty(
          global.navigator,
          "clipboard",
          previousClipboardDescriptor,
        );
      } else {
        delete global.navigator.clipboard;
      }
    }
  });
});

test("copyToClipboard logs an error when the copy flow throws", () => {
  const previousAddLog = global.addLog;
  const logs = [];
  global.addLog = (...args) => logs.push(args);

  try {
    const mod = loadModule();
    mod.copyToClipboard(null, "copy-btn");
    assert.deepEqual(logs, [["Failed to copy to clipboard", "error"]]);
  } finally {
    global.addLog = previousAddLog;
  }
});

test("setupClipboardShortcuts allows standard copy, paste, and select-all shortcuts", () => {
  withCopyDom(({ listeners }) => {
    const mod = loadModule();
    mod.setupClipboardShortcuts();

    const [handler] = listeners.get("keydown");
    assert.equal(handler({ metaKey: true, key: "v" }), true);
    assert.equal(handler({ ctrlKey: true, key: "a" }), true);
    assert.equal(handler({ ctrlKey: true, key: "c" }), true);
    assert.equal(handler({ ctrlKey: true, key: "x" }), undefined);
  });
});
