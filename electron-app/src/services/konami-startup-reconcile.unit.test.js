const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const ipcModulePath = require.resolve("./ipc");
const originalLoad = Module._load;

function loadIpcModule({
  executeJavaScriptResult = { success: true, modelId: "GPT-5.6 Sol Pro" },
  executeJavaScriptError = null,
  onExecuteJavaScript = null,
  persistedUnlocked = true,
  previousUnlocked = true,
  ownerWindowId = 7,
  persistError = null,
  mirrorErrorWhenUnlocked = null,
  serviceUnlockResult = null,
  serviceUnlockError = null,
} = {}) {
  const previousModule = require.cache[ipcModulePath];
  const handlers = new Map();
  const logs = [];
  let executeJavaScriptCalls = 0;
  let serviceUnlockCalls = 0;
  let persistedState = Boolean(persistedUnlocked);
  const interleaving = [];

  const logger = {
    log(layer, level, message, meta) {
      logs.push({ layer, level, message, meta });
    },
  };

  const ownerWindow = {
    id: ownerWindowId,
    isDestroyed() {
      return false;
    },
    webContents: {
      send() {},
      isDestroyed() {
        return false;
      },
    },
  };

  const electronStub = {
    app: {
      getPath(name) {
        assert.equal(name, "userData");
        return "/tmp/portico-tests";
      },
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: {},
    clipboard: {},
    BrowserWindow: {
      fromWebContents() {
        return ownerWindow;
      },
      getAllWindows() {
        return [];
      },
    },
    Notification: function Notification() {},
  };

  const sharedState = {
    PROJECT_ROOT: "/tmp/open-webui-mcp",
    appState: {
      konamiUnlocked: previousUnlocked,
    },
    windows: {},
    serverLifecycleEmitter: {
      on() {},
    },
    serverLifecycle: new Map(),
    buildInfo: {},
  };

  const owuiViews = {
    listViews() {
      return [{ viewKey: "main", ownerWindowId }];
    },
    executeJavaScript() {
      executeJavaScriptCalls += 1;
      interleaving.push("execute-owui-update");
      onExecuteJavaScript?.({
        persistedUnlocked: persistedState,
        interleaving: [...interleaving],
      });
      if (executeJavaScriptError) {
        throw executeJavaScriptError;
      }
      return executeJavaScriptResult;
    },
    broadcastToViews() {},
    getViewKeyForContents() {
      return "main";
    },
    getViewState() {
      return { ownerWindowId };
    },
  };

  const stubModules = {
    "./shared-state": sharedState,
    "./bootstrap": {
      PROJECT_ROOT: "/tmp/open-webui-mcp",
      APP_SERVICES: "/tmp/open-webui-mcp/electron-app/src/services",
      getConfigPath() {},
      getLogPaths() {
        return {};
      },
      execPromise() {},
      clearWebviewCache() {},
      sendInitLog() {},
      getThemeIcon() {},
      updateWindowMenu() {},
    },
    "./konami-unlock": {
      getKonamiFlagPath() {
        return "/tmp/portico-tests/KONAMI";
      },
      getManagedKonamiMirrorPath() {
        return "/tmp/open-webui-mcp/health-status/KONAMI";
      },
      readKonamiUnlocked() {
        return persistedState;
      },
      persistKonamiUnlocked() {
        interleaving.push("persist-authoritative-flag");
        if (persistError) {
          throw persistError;
        }
        persistedState = true;
        return "/tmp/portico-tests/KONAMI";
      },
      clearKonamiUnlocked() {
        interleaving.push("rollback-authoritative-flag");
        persistedState = false;
        return "/tmp/portico-tests/KONAMI";
      },
      syncKonamiManagedMirror() {
        interleaving.push("sync-managed-mirror");
        if (persistedState && mirrorErrorWhenUnlocked) {
          throw mirrorErrorWhenUnlocked;
        }
        return "/tmp/open-webui-mcp/health-status/KONAMI";
      },
    },
    "./konami-logger": {
      getKonamiLogger() {
        return logger;
      },
    },
    "./konami-model-unlock":
      serviceUnlockResult !== null || serviceUnlockError !== null
        ? {
            async unlockKonamiModelWithServiceAuth() {
              serviceUnlockCalls += 1;
              interleaving.push("execute-service-update");
              if (serviceUnlockError) {
                throw serviceUnlockError;
              }
              return serviceUnlockResult;
            },
          }
        : {},
    "./owui-views": owuiViews,
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }

    if (parent?.filename === ipcModulePath) {
      if (Object.prototype.hasOwnProperty.call(stubModules, request)) {
        return stubModules[request];
      }
      if (request.startsWith("./") || request.startsWith("../")) {
        return {};
      }
    }

    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  const ipc = require("./ipc");

  return {
    ipc,
    handlers,
    logs,
    getExecuteJavaScriptCalls() {
      return executeJavaScriptCalls;
    },
    getServiceUnlockCalls() {
      return serviceUnlockCalls;
    },
    getInterleaving() {
      return [...interleaving];
    },
    isPersistedUnlocked() {
      return persistedState;
    },
    restore() {
      Module._load = originalLoad;
      delete require.cache[ipcModulePath];
      if (previousModule) {
        require.cache[ipcModulePath] = previousModule;
      }
    },
  };
}

test("startup hydration classifies missing-token and view-resolution errors as transient", () => {
  const loaded = loadIpcModule();

  try {
    assert.deepEqual(
      loaded.ipc._test.resolveKonamiStartupHydrationFailure({
        message: "Missing OWUI token",
        code: "missing-token",
      }),
      {
        message: "Missing OWUI token",
        code: "missing-token",
        status: null,
        transient: true,
        surfacedError: null,
      },
    );

    assert.deepEqual(
      loaded.ipc._test.resolveKonamiStartupHydrationFailure({
        message: "OWUI request failed: fetch failed",
        code: "owui-unavailable",
      }),
      {
        message: "OWUI request failed: fetch failed",
        code: "owui-unavailable",
        status: null,
        transient: true,
        surfacedError: null,
      },
    );

    assert.deepEqual(
      loaded.ipc._test.resolveKonamiStartupHydrationFailure({
        message: "OWUI auth bridge secret is unavailable",
        code: "missing-bridge-secret",
      }),
      {
        message: "OWUI auth bridge secret is unavailable",
        code: "missing-bridge-secret",
        status: null,
        transient: true,
        surfacedError: null,
      },
    );

    assert.deepEqual(
      loaded.ipc._test.resolveKonamiStartupHydrationFailure({
        message: "No OWUI view available for Konami unlock",
      }),
      {
        message: "No OWUI view available for Konami unlock",
        code: null,
        status: null,
        transient: true,
        surfacedError: null,
      },
    );

    assert.deepEqual(
      loaded.ipc._test.resolveKonamiStartupHydrationFailure({
        message: "Unknown OWUI view: main",
      }),
      {
        message: "Unknown OWUI view: main",
        code: null,
        status: null,
        transient: true,
        surfacedError: null,
      },
    );
  } finally {
    loaded.restore();
  }
});

test("persisted konami startup hydration retries once and suppresses warn-level noise for missing tokens", async () => {
  const loaded = loadIpcModule({
    executeJavaScriptResult: {
      success: false,
      code: "missing-token",
      error: "Missing OWUI token",
    },
    persistedUnlocked: true,
    previousUnlocked: true,
  });

  const originalInfo = console.info;
  const originalWarn = console.warn;
  const infoCalls = [];
  const warnCalls = [];
  console.info = (...args) => infoCalls.push(args);
  console.warn = (...args) => warnCalls.push(args);

  try {
    loaded.ipc.registerOwuiHandlers();
    const handler = loaded.handlers.get("konami-get-state");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 41 } }, { viewKey: "main" });

    assert.deepEqual(result, {
      success: true,
      unlocked: true,
      immediate: false,
      error: null,
    });
    assert.equal(loaded.getExecuteJavaScriptCalls(), 1);
    assert.equal(warnCalls.length, 0);
    assert.equal(
      loaded.logs.some((entry) => entry.level === "warn"),
      false,
    );
    assert.equal(infoCalls.length > 0, true);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    loaded.restore();
  }
});

test("persisted konami startup hydration still surfaces non-transient reconcile failures", async () => {
  const loaded = loadIpcModule({
    executeJavaScriptResult: {
      success: false,
      code: "update-model-failed",
      error: "Failed to update model (HTTP 500)",
      status: 500,
    },
    persistedUnlocked: true,
    previousUnlocked: true,
  });

  const originalInfo = console.info;
  const originalWarn = console.warn;
  const infoCalls = [];
  const warnCalls = [];
  console.info = (...args) => infoCalls.push(args);
  console.warn = (...args) => warnCalls.push(args);

  try {
    loaded.ipc.registerOwuiHandlers();
    const handler = loaded.handlers.get("konami-get-state");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 42 } }, { viewKey: "main" });

    assert.deepEqual(result, {
      success: true,
      unlocked: true,
      immediate: false,
      error: "Failed to update model (HTTP 500)",
    });
    assert.equal(loaded.getExecuteJavaScriptCalls(), 1);
    assert.equal(infoCalls.length > 0, true);
    assert.equal(warnCalls.length > 0, true);
    assert.equal(
      loaded.logs.some((entry) => entry.level === "warn"),
      true,
    );
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    loaded.restore();
  }
});

test("first unlock persists authoritative desired state before the immediate OWUI update", async () => {
  const observations = [];
  const loaded = loadIpcModule({
    persistedUnlocked: false,
    previousUnlocked: false,
    onExecuteJavaScript(observation) {
      observations.push(observation);
      assert.equal(observation.persistedUnlocked, true);
    },
  });

  try {
    loaded.ipc.registerOwuiHandlers();
    const handler = loaded.handlers.get("konami-unlock");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 43 } }, { viewKey: "main" });

    assert.equal(result.success, true);
    assert.equal(result.unlocked, true);
    assert.equal(result.immediate, true);
    assert.equal(result.repairPending, false);
    assert.equal(loaded.isPersistedUnlocked(), true);
    assert.equal(observations.length, 1);

    const events = loaded.getInterleaving();
    const persistIndex = events.indexOf("persist-authoritative-flag");
    const mirrorIndex = events.indexOf("sync-managed-mirror", persistIndex);
    const updateIndex = events.indexOf("execute-owui-update");
    assert.notEqual(persistIndex, -1);
    assert.notEqual(mirrorIndex, -1);
    assert.notEqual(updateIndex, -1);
    assert.equal(persistIndex < mirrorIndex, true);
    assert.equal(mirrorIndex < updateIndex, true);
  } finally {
    loaded.restore();
  }
});

test("first unlock uses the service-owned updater instead of the human OWUI session", async () => {
  const loaded = loadIpcModule({
    persistedUnlocked: false,
    previousUnlocked: false,
    serviceUnlockResult: {
      success: true,
      modelId: "GPT-5.6 Sol Pro",
      alreadyUnlocked: false,
      auth: "service",
    },
  });

  try {
    loaded.ipc.registerOwuiHandlers();
    const handler = loaded.handlers.get("konami-unlock");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 45 } }, { viewKey: "main" });

    assert.equal(result.success, true);
    assert.equal(result.unlocked, true);
    assert.equal(result.immediate, true);
    assert.equal(result.modelId, "GPT-5.6 Sol Pro");
    assert.equal(loaded.getServiceUnlockCalls(), 1);
    assert.equal(loaded.getExecuteJavaScriptCalls(), 0);
    const events = loaded.getInterleaving();
    assert.equal(
      events.indexOf("persist-authoritative-flag") <
        events.indexOf("execute-service-update"),
      true,
    );
  } finally {
    loaded.restore();
  }
});

test("failed desired-state persistence rolls back before any OWUI update", async () => {
  const loaded = loadIpcModule({
    persistedUnlocked: false,
    previousUnlocked: false,
    mirrorErrorWhenUnlocked: new Error("mirror unavailable"),
  });
  const originalError = console.error;
  console.error = () => {};

  try {
    loaded.ipc.registerOwuiHandlers();
    const handler = loaded.handlers.get("konami-unlock");
    assert.equal(typeof handler, "function");

    const result = await handler({ sender: { id: 44 } }, { viewKey: "main" });

    assert.equal(result.success, false);
    assert.equal(result.unlocked, false);
    assert.equal(result.immediate, false);
    assert.equal(result.repairPending, false);
    assert.equal(loaded.getExecuteJavaScriptCalls(), 0);
    assert.equal(loaded.isPersistedUnlocked(), false);
    assert.deepEqual(loaded.getInterleaving(), [
      "sync-managed-mirror",
      "persist-authoritative-flag",
      "sync-managed-mirror",
      "rollback-authoritative-flag",
      "sync-managed-mirror",
    ]);
  } finally {
    console.error = originalError;
    loaded.restore();
  }
});
