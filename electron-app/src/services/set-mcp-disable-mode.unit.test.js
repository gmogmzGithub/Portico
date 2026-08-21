// Behavioral pin for the set-mcp-disable-mode IPC handler: hard mode must
// ALWAYS ride on toggles=false. A server whose toggle key is ABSENT passes
// the SERVER_NOT_DISABLED gate, but downstream toggle reads fail open
// (absent = on), so stamping "hard" without forcing the boolean would leave
// a "hard-disabled" server visible in <needs_config>/<needs_auth>. The
// handler persists toggles=false BEFORE the mode (PORTICO-410 crash-safe order).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ipcModulePath = require.resolve("./ipc");
const dockerMcpModulePath = require.resolve("./docker-mcp");
const sharedStatePath = require.resolve("./shared-state");
const originalLoad = Module._load;

function loadIpcWithCapturedHandlers(projectRoot) {
  const previousIpc = require.cache[ipcModulePath];
  const previousDockerMcp = require.cache[dockerMcpModulePath];
  const previousSharedState = require.cache[sharedStatePath];

  const handlers = new Map();
  const electronStub = {
    app: {
      getPath() {
        return os.tmpdir();
      },
      getVersion() {
        return "0.0.0-test";
      },
      on() {},
    },
    ipcMain: {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
      on() {},
    },
    shell: {},
    clipboard: {},
    dialog: {},
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
  };

  const bootstrapStub = {
    PROJECT_ROOT: projectRoot,
    APP_SERVICES: __dirname,
    execPromise: async () => ({ stdout: "", stderr: "" }),
    sendInitLog() {},
    getConfigPath() {},
    getLogPaths() {
      return {};
    },
    clearWebviewCache() {},
    getThemeIcon() {},
    updateWindowMenu() {},
  };

  // Toggle/mode stores are pure-fs leaf modules the handler writes through —
  // load them real so the test observes actual on-disk persistence.
  const realThrough = new Set([
    "./shared-state",
    "./mcp-toggle-store",
    "./mcp-disable-mode-store",
  ]);

  const functionalStubs = {
    "../config/runtime-secrets-config": {
      resolveMcpSensitiveEnvSecrets: () => ({}),
    },
    "./docker-status-probe": {
      createSerialPoller: () => ({
        start() {},
        stop() {},
        trigger() {},
        poke() {},
        isRunning() {
          return false;
        },
      }),
      probeDockerStatus: async () => ({ running: false }),
    },
    "./host-mcpo-runtime": {
      createSerialTaskQueue: () => async (task) => task(),
      consumeProcessOutputLines() {},
      shouldSuppressHostMcpoLogLine() {
        return false;
      },
      classifyHostMcpoStderrLine() {
        return null;
      },
      markHostMcpoStarting() {},
      markHostMcpoReady() {},
      markHostMcpoStopped() {},
      isHostMcpoStartupPending() {
        return false;
      },
      getHostMcpoStartupPhase() {
        return null;
      },
    },
    // Disk-faithful identity check: installed = mcp-configs/<id>/ exists.
    "./mcp-startup-failures": {
      isInstalledMcpServerId: (root, serverId) =>
        fs.existsSync(path.join(root, "mcp-configs", String(serverId || ""))),
      clearStartupFailure() {},
      pruneStartupFailures() {},
      loadStartupFailures() {
        return {};
      },
    },
    "./mcp-operation-manager": {
      defaultMcpOperationManager: {
        getActiveMcpOperation: () => null,
        acquireMutationLease: () => () => {},
        whenMutationIdle: async () => {},
      },
    },
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    const parentFile = parent?.filename || "";
    const inHarness =
      parentFile === ipcModulePath || parentFile === dockerMcpModulePath;
    if (inHarness) {
      if (request === "./bootstrap" || request === "../bootstrap") {
        return bootstrapStub;
      }
      if (request === "./docker-mcp" && parentFile === ipcModulePath) {
        return originalLoad.apply(this, [request, parent, isMain]);
      }
      if (realThrough.has(request)) {
        return originalLoad.apply(this, [request, parent, isMain]);
      }
      if (Object.prototype.hasOwnProperty.call(functionalStubs, request)) {
        return functionalStubs[request];
      }
      if (request.startsWith("./") || request.startsWith("../")) {
        return {};
      }
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  delete require.cache[dockerMcpModulePath];
  delete require.cache[sharedStatePath];

  const ipc = require("./ipc");
  const dockerMcp = require("./docker-mcp");

  return {
    ipc,
    dockerMcp,
    handlers,
    restore() {
      Module._load = originalLoad;
      delete require.cache[ipcModulePath];
      delete require.cache[dockerMcpModulePath];
      delete require.cache[sharedStatePath];
      if (previousIpc) require.cache[ipcModulePath] = previousIpc;
      if (previousDockerMcp)
        require.cache[dockerMcpModulePath] = previousDockerMcp;
      if (previousSharedState)
        require.cache[sharedStatePath] = previousSharedState;
    },
  };
}

function makeProjectRoot() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "set-mode-ipc-"));
  const serverDir = path.join(projectRoot, "mcp-configs", "testsrv");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, "testsrv.yaml"),
    [
      "name: Test Server",
      "id: testsrv",
      "display_name: Test Server",
      "deployment_type: docker",
      "description: fixture",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(serverDir, "testsrv.fragment"),
    JSON.stringify({ command: "python3", args: ["server.py"] }),
  );
  return projectRoot;
}

function readJson(projectRoot, name) {
  const filePath = path.join(projectRoot, name);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("hard mode on an absent-toggle server persists toggles=false AND the mode", async () => {
  const projectRoot = makeProjectRoot();
  const loaded = loadIpcWithCapturedHandlers(projectRoot);
  try {
    loaded.ipc.registerConfigHandlers();
    const handler = loaded.handlers.get("set-mcp-disable-mode");
    assert.equal(typeof handler, "function", "handler must be registered");

    assert.equal(
      readJson(projectRoot, "mcp_toggles.json")?.testsrv,
      undefined,
      "precondition: toggle key absent",
    );

    const result = await handler(null, "testsrv", "hard");

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.mode, "hard");
    assert.equal(
      readJson(projectRoot, "mcp_toggles.json")?.testsrv,
      false,
      "hard mode must force the toggle boolean off",
    );
    assert.equal(
      readJson(projectRoot, "mcp_disable_modes.json")?.testsrv,
      "hard",
    );
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("soft mode on an absent-toggle server does not invent a toggle entry", async () => {
  const projectRoot = makeProjectRoot();
  const loaded = loadIpcWithCapturedHandlers(projectRoot);
  try {
    loaded.ipc.registerConfigHandlers();
    const handler = loaded.handlers.get("set-mcp-disable-mode");

    const result = await handler(null, "testsrv", "soft");

    assert.equal(result.success, true, JSON.stringify(result));
    const toggles = readJson(projectRoot, "mcp_toggles.json");
    assert.equal(
      toggles?.testsrv,
      undefined,
      "soft on an absent toggle stays absent (no behavior change)",
    );
    assert.equal(
      readJson(projectRoot, "mcp_disable_modes.json")?.testsrv,
      undefined,
      "soft mode keeps no modes entry",
    );
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("enabled servers are still refused (SERVER_NOT_DISABLED)", async () => {
  const projectRoot = makeProjectRoot();
  fs.writeFileSync(
    path.join(projectRoot, "mcp_toggles.json"),
    JSON.stringify({ testsrv: true }),
  );
  const loaded = loadIpcWithCapturedHandlers(projectRoot);
  try {
    loaded.ipc.registerConfigHandlers();
    const handler = loaded.handlers.get("set-mcp-disable-mode");

    const result = await handler(null, "testsrv", "hard");

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "SERVER_NOT_DISABLED");
    assert.equal(readJson(projectRoot, "mcp_toggles.json")?.testsrv, true);
    assert.equal(
      readJson(projectRoot, "mcp_disable_modes.json")?.testsrv,
      undefined,
    );
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
