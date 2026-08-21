// PORTICO-224 regression tests: user-installed servers must derive isConfigured
// from their declared required_env_vars (same check bundled servers use), the
// scan must normalize bare-string entries, and the placeholder heuristic must
// be case/whitespace-insensitive.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ipcModulePath = require.resolve("./ipc");
const dockerMcpModulePath = require.resolve("./docker-mcp");
const sharedStatePath = require.resolve("./shared-state");
const serverRequirementsPath = require.resolve(
  "./guided-setup/server-requirements",
);
const originalLoad = Module._load;

function loadIpcWithRealDockerMcp(projectRoot) {
  const previousIpc = require.cache[ipcModulePath];
  const previousDockerMcp = require.cache[dockerMcpModulePath];
  const previousSharedState = require.cache[sharedStatePath];

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
      handle() {},
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

  const realThrough = new Set([
    "./shared-state",
    "./guided-setup/server-requirements",
    "../guided-setup/server-requirements",
  ]);

  // Functional stubs for the few docker-mcp dependencies invoked at module
  // load. Everything else relative gets an inert {} so no real subsystem
  // (pollers, loggers, child processes) starts inside the test runner.
  const functionalStubs = {
    // pre-beta-tmp: checkServerConfigured falls back to the runtime
    // secret store for sensitive vars missing from .env; these tests
    // model "no stored secrets" so declared-but-unset vars must gate.
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
  delete require.cache[serverRequirementsPath];

  const ipc = require("./ipc");
  const dockerMcp = require("./docker-mcp");
  const state = require("./shared-state");

  return {
    ipc,
    dockerMcp,
    state,
    restore() {
      Module._load = originalLoad;
      delete require.cache[ipcModulePath];
      delete require.cache[dockerMcpModulePath];
      delete require.cache[sharedStatePath];
      delete require.cache[serverRequirementsPath];
      if (previousIpc) require.cache[ipcModulePath] = previousIpc;
      if (previousDockerMcp)
        require.cache[dockerMcpModulePath] = previousDockerMcp;
      if (previousSharedState)
        require.cache[sharedStatePath] = previousSharedState;
    },
  };
}

function writeServer(configRoot, serverId, yamlText) {
  const dir = path.join(configRoot, serverId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${serverId}.yaml`), yamlText);
  fs.writeFileSync(
    path.join(dir, `${serverId}.fragment`),
    JSON.stringify({
      command: "python3",
      args: ["server.py"],
      env: { MARVIN_PASSWORD: "${MARVIN_PASSWORD}" },
    }),
  );
}

const NEEDY_YAML = [
  "name: Marvin",
  "id: marvin",
  "display_name: Marvin",
  "deployment_type: docker",
  "description: user server with a sensitive var",
  "user_installed: true",
  "is_core: false",
  "required_env_vars:",
  "  - name: MARVIN_PASSWORD",
  '    placeholder: "Paste the Marvin password"',
  '    description: "Marvin password"',
  "    sensitive: true",
  "",
].join("\n");

test("server scanner emits ASCII-only status logs", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico287-scan-"));
  const userConfigs = path.join(projectRoot, "mcp-configs-user");
  writeServer(userConfigs, "marvin", NEEDY_YAML);
  fs.mkdirSync(path.join(userConfigs, "orphan"));
  fs.mkdirSync(path.join(userConfigs, "run-sub-agent"));

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  const originalConsoleLog = console.log;
  const output = [];
  try {
    console.log = (...args) => output.push(args.map(String).join(" "));
    loaded.state.configData.env = {};
    await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);

    const statusLogs = output.filter((line) => line.startsWith("  ["));
    assert.deepEqual(statusLogs.sort(), [
      "  [CLEANUP] Cleaning up deprecated server: run-sub-agent",
      "  [OK] Loaded user-installed server: marvin",
      "  [SKIP] Skipping orphan: no YAML config found",
    ]);
    assert.equal(
      output.every((line) =>
        Buffer.from(line, "utf8").every((byte) => byte < 0x80),
      ),
      true,
    );
  } finally {
    console.log = originalConsoleLog;
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("user-installed server with declared required vars gates on stored values", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico224-scan-"));
  const userConfigs = path.join(projectRoot, "mcp-configs-user");
  writeServer(userConfigs, "marvin", NEEDY_YAML);

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    loaded.state.configData.env = {};
    let servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(servers.length, 1);
    assert.equal(
      servers[0].isConfigured,
      false,
      "no stored value → needs configuration",
    );
    assert.deepEqual(servers[0].requiredVars, [
      {
        name: "MARVIN_PASSWORD",
        placeholder: "Paste the Marvin password",
        description: "Marvin password",
        sensitive: true,
      },
    ]);
    assert.equal(servers[0].userInstalled, true);

    loaded.state.configData.env = {
      MARVIN_PASSWORD: "YOUR_PASSWORD_HERE",
    };
    servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(
      servers[0].isConfigured,
      false,
      "uppercase placeholder value → still needs configuration",
    );

    loaded.state.configData.env = { MARVIN_PASSWORD: "s3cr3t-value" };
    servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(servers[0].isConfigured, true, "real value → configured");
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("legacy user-installed yamls (empty or absent required_env_vars) stay configured", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico224-scan-"));
  const userConfigs = path.join(projectRoot, "mcp-configs-user");
  writeServer(
    userConfigs,
    "legacy-empty",
    [
      "name: Legacy Empty",
      "id: legacy-empty",
      "display_name: Legacy Empty",
      "deployment_type: docker",
      "description: legacy empty list",
      "user_installed: true",
      "is_core: false",
      "required_env_vars: []",
      "",
    ].join("\n"),
  );
  writeServer(
    userConfigs,
    "legacy-absent",
    [
      "name: Legacy Absent",
      "id: legacy-absent",
      "display_name: Legacy Absent",
      "deployment_type: docker",
      "description: legacy without the key",
      "user_installed: true",
      "is_core: false",
      "",
    ].join("\n"),
  );

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    loaded.state.configData.env = {};
    const servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(servers.length, 2);
    for (const server of servers) {
      assert.equal(
        server.isConfigured,
        true,
        `${server.id}: user servers without declared vars must stay configured`,
      );
      assert.deepEqual(server.requiredVars, []);
    }
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("hand-edited bare-string entries are normalized and still gate", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico224-scan-"));
  const userConfigs = path.join(projectRoot, "mcp-configs-user");
  writeServer(
    userConfigs,
    "bare",
    [
      "name: Bare",
      "id: bare",
      "display_name: Bare",
      "deployment_type: docker",
      "description: hand-edited bare string entry",
      "user_installed: true",
      "is_core: false",
      "required_env_vars:",
      "  - MARVIN_PASSWORD",
      "",
    ].join("\n"),
  );

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    loaded.state.configData.env = {};
    let servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].isConfigured, false);
    assert.deepEqual(
      servers[0].requiredVars,
      [{ name: "MARVIN_PASSWORD" }],
      "bare strings must reach consumers in object form",
    );

    loaded.state.configData.env = { MARVIN_PASSWORD: "real-value" };
    servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    assert.equal(servers[0].isConfigured, true);
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("bundled servers keep the same configured semantics", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico224-scan-"));
  const systemConfigs = path.join(projectRoot, "mcp-configs");
  writeServer(
    systemConfigs,
    "bundled-needy",
    [
      "name: Bundled Needy",
      "id: bundled-needy",
      "display_name: Bundled Needy",
      "deployment_type: docker",
      "description: bundled server with a required var",
      "required_env_vars:",
      "  - name: BUNDLED_TOKEN",
      "    sensitive: true",
      "",
    ].join("\n"),
  );

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    loaded.state.configData.env = {};
    let servers = await loaded.ipc.scanMcpConfigDirectory(
      systemConfigs,
      false,
    );
    assert.equal(servers.length, 1);
    assert.equal(servers[0].isConfigured, false);
    assert.equal(servers[0].userInstalled, false);

    loaded.state.configData.env = { BUNDLED_TOKEN: "real-value" };
    servers = await loaded.ipc.scanMcpConfigDirectory(systemConfigs, false);
    assert.equal(servers[0].isConfigured, true);
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("checkServerConfigured placeholder heuristic is trim- and case-insensitive", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portico224-scan-"));
  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    const { checkServerConfigured } = loaded.dockerMcp;
    const server = { required_env_vars: [{ name: "TOKEN" }] };
    assert.equal(checkServerConfigured(server, {}), false);
    assert.equal(checkServerConfigured(server, { TOKEN: "" }), false);
    assert.equal(
      checkServerConfigured(server, { TOKEN: "YOUR_TOKEN_HERE" }),
      false,
    );
    assert.equal(
      checkServerConfigured(server, { TOKEN: " Placeholder " }),
      false,
    );
    assert.equal(checkServerConfigured(server, { TOKEN: "Example" }), false);
    assert.equal(
      checkServerConfigured(server, { TOKEN: "real-token-123" }),
      true,
    );
    // String entries stay supported by the shared check.
    assert.equal(
      checkServerConfigured({ required_env_vars: ["TOKEN"] }, {}),
      false,
    );
    assert.equal(
      checkServerConfigured(
        { required_env_vars: ["TOKEN"] },
        { TOKEN: "real-token-123" },
      ),
      true,
    );
    // No declared vars → configured.
    assert.equal(checkServerConfigured({ required_env_vars: [] }, {}), true);
    assert.equal(checkServerConfigured({}, {}), true);
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("scanner maps the yaml deprecated flag strictly into server records", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deprecated-scan-"));
  const userConfigs = path.join(projectRoot, "mcp-configs-user");
  const baseYaml = (id, extra) =>
    [
      `name: ${id}`,
      `id: ${id}`,
      `display_name: ${id}`,
      "deployment_type: docker",
      `description: ${id}`,
      "user_installed: true",
      "is_core: false",
      ...extra,
      "",
    ].join("\n");
  writeServer(userConfigs, "old-tool", baseYaml("old-tool", ["deprecated: true"]));
  writeServer(userConfigs, "current-tool", baseYaml("current-tool", []));
  writeServer(
    userConfigs,
    "stringy-tool",
    baseYaml("stringy-tool", ['deprecated: "true"']),
  );

  const loaded = loadIpcWithRealDockerMcp(projectRoot);
  try {
    loaded.state.configData.env = {};
    const servers = await loaded.ipc.scanMcpConfigDirectory(userConfigs, true);
    const byId = Object.fromEntries(servers.map((s) => [s.id, s]));

    assert.equal(byId["old-tool"].deprecated, true, "deprecated: true → true");
    assert.equal(
      byId["current-tool"].deprecated,
      false,
      "absent flag → false",
    );
    assert.equal(
      byId["stringy-tool"].deprecated,
      false,
      'non-boolean "true" is not honored',
    );
  } finally {
    loaded.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
