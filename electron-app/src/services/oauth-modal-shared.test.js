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
  constructor(id = "", registry = null) {
    this.id = id;
    this.registry = registry;
    this.classList = new FakeClassList();
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id && this.registry) {
      this.registry[child.id] = child;
    }
    return child;
  }

  cloneNode() {
    const clone = new FakeElement(this.id, this.registry);
    clone.className = this.className;
    clone.style = { ...this.style };
    clone.textContent = this.textContent;
    clone.innerHTML = this.innerHTML;
    clone.disabled = this.disabled;
    return clone;
  }

  click() {
    const handler = this.listeners.get("click");
    if (handler) {
      handler({ preventDefault() {} });
    }
  }

  querySelectorAll() {
    return [];
  }
}

function attachParent(element, elements) {
  element.parentNode = {
    replaceChild(newChild, oldChild) {
      newChild.parentNode = this;
      elements[oldChild.id] = newChild;
    },
  };
}

function buildOauthModalHarness() {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "oauth-modal-shared.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");

  const ids = [
    "oauth-modal",
    "oauth-server-preview",
    "oauth-server-icon",
    "oauth-server-name",
    "oauth-server-description",
    "oauth-progress-text",
    "oauth-current-server",
    "oauth-buttons",
    "oauth-waiting",
    "oauth-success",
    "oauth-completion-summary",
    "oauth-skip-all-btn",
    "oauth-stat-done",
    "oauth-stat-skipped",
    "oauth-stat-failed",
    "oauth-authorize-btn",
    "oauth-skip-btn",
    "oauth-prev-btn",
    "oauth-next-btn",
    "oauth-done-btn",
    "oauth-close-btn",
    "oauth-error-container",
    "oauth-view-logs-btn",
  ];

  const elements = {};
  for (const id of ids) {
    elements[id] = new FakeElement(id, elements);
  }
  elements["oauth-buttons-container"] = new FakeElement(
    "oauth-buttons-container",
    elements,
  );
  elements["oauth-waiting-text"] = new FakeElement(
    "oauth-waiting-text",
    elements,
  );
  elements["oauth-waiting-hint"] = new FakeElement(
    "oauth-waiting-hint",
    elements,
  );

  Object.values(elements).forEach((element) => attachParent(element, elements));

  const documentListeners = new Map();
  const dismissals = [];
  const suppressionChanges = [];
  const restartCalls = [];
  const immediateSetTimeout = (handler) => setTimeout(handler, 0);
  const immediateClearTimeout = (timeoutId) => clearTimeout(timeoutId);
  const immediateSetInterval = (handler) => {
    const intervalHandle = { active: true, timeoutId: null };
    const tick = () => {
      if (!intervalHandle.active) {
        return;
      }
      handler();
      intervalHandle.timeoutId = setTimeout(tick, 0);
    };
    intervalHandle.timeoutId = setTimeout(tick, 0);
    return intervalHandle;
  };
  const immediateClearInterval = (intervalHandle) => {
    if (!intervalHandle) {
      return;
    }
    intervalHandle.active = false;
    if (intervalHandle.timeoutId) {
      clearTimeout(intervalHandle.timeoutId);
    }
  };

  const document = {
    createElement() {
      return new FakeElement("", elements);
    },
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      if (selector === ".oauth-buttons-container") {
        return elements["oauth-buttons-container"];
      }
      if (selector === ".oauth-waiting-text") {
        return elements["oauth-waiting-text"];
      }
      if (selector === ".oauth-waiting-hint") {
        return elements["oauth-waiting-hint"];
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      const current = documentListeners.get(type);
      if (!handler || current === handler) {
        documentListeners.delete(type);
      }
    },
  };

  const context = {
    window: {
      electronAPI: {
        async getServerMetadata(serverId) {
          return {
            name: serverId,
            display_name: serverId.toUpperCase(),
            description: "OAuth server",
          };
        },
        async checkOAuthTokensExist() {
          return { exists: true };
        },
        async getServerTools() {
          return { success: true, tools: [{ name: "tool" }] };
        },
        async apiRestartMcpServers(serverIds) {
          restartCalls.push(serverIds);
          return { success: true };
        },
        notifyOAuthDismissed(serverId) {
          dismissals.push(serverId);
        },
      },
      setOwuiInteractionSuppressed(reason, suppressed) {
        suppressionChanges.push({ reason, suppressed });
      },
    },
    document,
    console,
    setTimeout: immediateSetTimeout,
    clearTimeout: immediateClearTimeout,
    setInterval: immediateSetInterval,
    clearInterval: immediateClearInterval,
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    context,
    dismissals,
    restartCalls,
    suppressionChanges,
    async waitForModalOpen() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (suppressionChanges.some((entry) => entry.suppressed === true)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.fail("OAuth modal did not open during test setup");
    },
    clickCloseButton() {
      elements["oauth-close-btn"].click();
    },
    pressEscape() {
      const handler = documentListeners.get("keydown");
      if (handler) {
        handler({ key: "Escape" });
      }
    },
  };
}

test("closing the OAuth modal notifies the backend that the current server was dismissed", async () => {
  const harness = buildOauthModalHarness();

  const flowPromise = harness.context.runOAuthFlowForMultipleServers(
    [{ server_name: "glean" }],
    () => {},
  );
  await harness.waitForModalOpen();

  harness.clickCloseButton();

  await flowPromise;

  assert.deepEqual(harness.dismissals, ["glean"]);
  assert.deepEqual(harness.suppressionChanges, [
    { reason: "oauth-modal", suppressed: true },
    { reason: "oauth-modal", suppressed: false },
  ]);
});

test("pressing Escape dismisses the active OAuth server exactly once", async () => {
  const harness = buildOauthModalHarness();

  const flowPromise = harness.context.runOAuthFlowForMultipleServers(
    [{ server_name: "glean" }],
    () => {},
  );
  await harness.waitForModalOpen();

  harness.pressEscape();
  harness.pressEscape();

  await flowPromise;

  assert.deepEqual(harness.dismissals, ["glean"]);
});

test("backend-managed OAuth finalization skips the frontend restart", async () => {
  const harness = buildOauthModalHarness();

  harness.context.runOAuthFlowForMultipleServers(
    [{ server_name: "glean" }],
    () => {},
    { backendManagedFinalization: true },
  );
  await harness.waitForModalOpen();

  await harness.context.markCurrentAsDone();

  assert.deepEqual(harness.restartCalls, []);
  harness.context.closeOAuthModal();
});

test("manual OAuth finalization still restarts the MCP server", async () => {
  const harness = buildOauthModalHarness();

  harness.context.runOAuthFlowForMultipleServers(
    [{ server_name: "glean" }],
    () => {},
  );
  await harness.waitForModalOpen();

  await harness.context.markCurrentAsDone();

  assert.deepEqual(
    harness.restartCalls.map((serverIds) => Array.from(serverIds)),
    [["glean"]],
  );
  harness.context.closeOAuthModal();
});

test("shared OAuth modal prepares bootstrap state without clearing durable tokens before authorization", async () => {
  const harness = buildOauthModalHarness();
  const callOrder = [];

  harness.context.window.electronAPI.prepareOAuthStart = async (serverId) => {
    callOrder.push(`prepare:${serverId}`);
    return { success: true, cleared: true };
  };
  harness.context.window.electronAPI.clearOAuthTokens = async (serverId) => {
    callOrder.push(`clear:${serverId}`);
    return { success: true, cleared: true };
  };
  harness.context.window.electronAPI.refreshOAuthUrl = async (serverId) => {
    callOrder.push(`refresh:${serverId}`);
    return {
      success: true,
      authorization_url: "https://auth.example.test",
    };
  };
  harness.context.window.electronAPI.openExternal = async () => {};
  harness.context.window.electronAPI.pollOAuthCompletion = async () => ({
    completed: true,
  });

  const flowPromise = harness.context.runOAuthFlowForMultipleServers(
    [{ server_name: "glean" }],
    () => {},
  );
  await harness.waitForModalOpen();

  await harness.context.handleAuthorize();
  harness.context.closeOAuthModal();
  await flowPromise;

  assert.deepEqual(callOrder.slice(0, 2), ["prepare:glean", "refresh:glean"]);
  assert.equal(callOrder.includes("clear:glean"), false);
});
