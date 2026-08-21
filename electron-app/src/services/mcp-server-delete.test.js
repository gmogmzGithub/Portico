const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { deleteUserMcpServer } = require("./mcp-server-delete");
const {
  loadStartupFailures,
  recordStartupFailure,
} = require("./mcp-startup-failures");

function makeTempProjectRoot(testName) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-delete-${testName}-`));
}

function writeUserServer(root, serverId, yaml = "deployment_type: docker\n") {
  const serverDir = path.join(root, "mcp-configs-user", serverId);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, `${serverId}.yaml`), yaml);
  fs.writeFileSync(path.join(serverDir, `${serverId}.fragment`), "{}\n");
  fs.writeFileSync(path.join(serverDir, `${serverId}.png`), "png");
  return serverDir;
}

test("deleteUserMcpServer removes a docker-managed user server, clears its toggle, and refreshes runtime infra", async (t) => {
  const root = makeTempProjectRoot("docker");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverId = "demo";
  const serverDir = writeUserServer(root, serverId);
  const logger = { log() {}, warn() {}, error() {} };
  recordStartupFailure(root, {
    serverId,
    error: "stale failure",
    source: "config",
    stage: "config_generation",
  });

  let togglesDraft = null;
  const executedCommands = [];
  const refreshCalls = [];
  const healthCalls = [];
  const toggleEvents = [];
  const clearedRuntimeState = [];

  const result = await deleteUserMcpServer(serverId, {
    projectRoot: root,
    env: { PATH: "/bin" },
    isPackagedApp: false,
    logger,
    isCoreServer() {
      return false;
    },
    async isHostDeployedServer() {
      return false;
    },
    getConfiguredMcpoRuntimeTarget() {
      return { containerName: "mcpo-demo", deploymentScope: "docker" };
    },
    getMcpoServerContainerCandidates() {
      return ["mcpo-demo", "mcpo-single-demo"];
    },
    async mutateToggles(mutator) {
      togglesDraft = { demo: true, keep: true };
      await mutator(togglesDraft);
    },
    async executeWithStreaming(command) {
      executedCommands.push(command);
    },
    async regenerateMcpInfrastructure(execAsync, projectRoot, env, options) {
      refreshCalls.push({
        step: "regenerate",
        hasExecAsync: typeof execAsync === "function",
        projectRoot,
        env,
        options,
      });
    },
    async refreshMcpControlPlane(execAsync, projectRoot, env, options) {
      refreshCalls.push({
        step: "refresh",
        hasExecAsync: typeof execAsync === "function",
        projectRoot,
        env,
        options,
      });
    },
    queueFullHealthCheck(reason, options) {
      healthCalls.push({ reason, options });
    },
    broadcastToggleState(payload) {
      toggleEvents.push(payload);
    },
    clearRuntimeState(serverId) {
      clearedRuntimeState.push(serverId);
    },
    execAsync: async () => undefined,
  });

  assert.equal(result.success, true);
  assert.equal(result.server_id, serverId);
  assert.equal(result.files_deleted_count, 3);
  assert.equal(result.toggle_removed, true);
  assert.equal(fs.existsSync(serverDir), false);
  assert.equal(loadStartupFailures(root)[serverId], undefined);
  assert.deepEqual(clearedRuntimeState, [serverId]);
  assert.deepEqual(togglesDraft, { keep: true });
  assert.deepEqual(executedCommands, [
    "docker rm -f mcpo-demo >/dev/null 2>&1 || true",
    "docker rm -f mcpo-single-demo >/dev/null 2>&1 || true",
  ]);
  assert.deepEqual(refreshCalls, [
    {
      step: "regenerate",
      hasExecAsync: true,
      projectRoot: root,
      env: { PATH: "/bin" },
      options: {
        force: true,
        isPackagedApp: false,
        timeout: 30000,
      },
    },
    {
      step: "refresh",
      hasExecAsync: true,
      projectRoot: root,
      env: { PATH: "/bin" },
      options: {
        controlPlaneContainer: "mcpo",
        serverId,
        includeRegular: true,
        includeCore: false,
        serverRouteWait: "skip",
        logger,
      },
    },
  ]);
  assert.deepEqual(healthCalls, [
    {
      reason: `mcp-server-deleted:${serverId}`,
      options: { immediate: true },
    },
  ]);
  assert.deepEqual(toggleEvents, [{ server_id: serverId, enabled: false }]);
});

test("deleteUserMcpServer uses the host lifecycle for host-deployed user servers", async (t) => {
  const root = makeTempProjectRoot("host");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverId = "host-demo";
  const serverDir = writeUserServer(root, serverId, "deployment_type: host\n");
  const logger = { log() {}, warn() {}, error() {} };

  let restarted = null;
  const result = await deleteUserMcpServer(serverId, {
    projectRoot: root,
    env: { PATH: "/bin" },
    isPackagedApp: true,
    logger,
    isCoreServer() {
      return false;
    },
    async isHostDeployedServer() {
      return true;
    },
    async mutateToggles(mutator) {
      const draft = { "host-demo": true };
      await mutator(draft);
    },
    async restartHostMcpoWithFreshConfig(options) {
      restarted = options;
    },
    queueFullHealthCheck() {},
    broadcastToggleState() {},
    clearRuntimeState() {},
    execAsync: async () => undefined,
  });

  assert.equal(result.success, true);
  assert.equal(result.files_deleted_count, 3);
  assert.equal(fs.existsSync(serverDir), false);
  assert.equal(typeof restarted.execAsync, "function");
  assert.equal(restarted.projectRoot, root);
  assert.deepEqual(restarted.env, { PATH: "/bin" });
  assert.deepEqual(restarted.regenerationOptions, {
    force: true,
    isPackagedApp: true,
    timeout: 30000,
  });
});

test("deleteUserMcpServer rejects immutable system servers without mutating files or toggles", async (t) => {
  const root = makeTempProjectRoot("core");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverDir = writeUserServer(root, "core-demo");

  let mutated = false;
  const result = await deleteUserMcpServer("core-demo", {
    projectRoot: root,
    isPackagedApp: false,
    isCoreServer() {
      return true;
    },
    async mutateToggles() {
      mutated = true;
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "IMMUTABLE_SYSTEM_SERVER");
  assert.equal(mutated, false);
  assert.equal(fs.existsSync(serverDir), true);
});

test("deleteUserMcpServer returns a structured failure when cleanup errors after deletion", async (t) => {
  const root = makeTempProjectRoot("cleanup-failure");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverId = "broken-host";
  const serverDir = writeUserServer(root, serverId, "deployment_type: host\n");
  const logger = { log() {}, warn() {}, error() {} };

  let togglesDraft = null;
  const result = await deleteUserMcpServer(serverId, {
    projectRoot: root,
    isPackagedApp: false,
    logger,
    isCoreServer() {
      return false;
    },
    async isHostDeployedServer() {
      return true;
    },
    async mutateToggles(mutator) {
      togglesDraft = { "broken-host": true };
      await mutator(togglesDraft);
    },
    async restartHostMcpoWithFreshConfig() {
      throw new Error("host restart failed");
    },
    clearRuntimeState() {},
    execAsync: async () => undefined,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "host restart failed");
  assert.equal(result.files_deleted_count, 3);
  assert.equal(result.toggle_removed, true);
  assert.equal(fs.existsSync(serverDir), false);
  assert.deepEqual(togglesDraft, {});
});

test("delete wiring stays local and no longer loops through the MCP Assistant HTTP endpoint", () => {
  const apiSource = fs.readFileSync(
    path.join(__dirname, "api.js"),
    "utf8",
  );
  const ipcSource = fs.readFileSync(
    path.join(__dirname, "ipc.js"),
    "utf8",
  );

  assert.match(apiSource, /apiApp\.post\('\/api\/delete-mcp-server\/:serverId'/);
  assert.match(apiSource, /deleteUserMcpServer\(serverId,\s*\{/);
  assert.match(ipcSource, /ipcMain\.handle\("delete-user-mcp-server"/);
  assert.match(ipcSource, /deleteUserMcpServer\(serverId,\s*\{/);
  assert.doesNotMatch(
    ipcSource,
    /http:\/\/localhost:8766\/mcp-assistant\/mcp_assistant_delete_user_mcp_server/,
  );
});
