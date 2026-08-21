const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectRestartedHostServerIds,
  ensureServersEnabledForRestart,
  restartHostMcpoWithFreshConfig,
} = require("./host-mcp-lifecycle");

test("ensureServersEnabledForRestart enables only non-core servers that are not already true", async () => {
  const calls = [];
  const result = await ensureServersEnabledForRestart(
    ["chrome-devtools", "local-shell", "agent-vm", "chrome-devtools"],
    {
      isCoreServer(serverId) {
        return serverId === "agent-vm";
      },
      async mutateToggles(mutator, options) {
        const draft = {
          "chrome-devtools": false,
          "local-shell": true,
        };
        await mutator(draft);
        calls.push({ draft, reason: options.reason });
      },
      logger: { log() {} },
      reasonPrefix: "restartMcpoServer",
    },
  );

  assert.deepEqual(result.changedServerIds, ["chrome-devtools"]);
  assert.deepEqual(result.skippedServerIds, ["agent-vm"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].draft, {
    "chrome-devtools": true,
    "local-shell": true,
  });
  assert.equal(
    calls[0].reason,
    "restartMcpoServer:chrome-devtools,local-shell",
  );
});

test("ensureServersEnabledForRestart validates required callbacks", async () => {
  await assert.rejects(
    () => ensureServersEnabledForRestart(["chrome-devtools"], {}),
    /mutateToggles \(function\) is required/,
  );
  await assert.rejects(
    () =>
      ensureServersEnabledForRestart(["chrome-devtools"], {
        mutateToggles: async () => undefined,
        isCoreServer: null,
      }),
    /isCoreServer \(function\) is required/,
  );
});

test("restartHostMcpoWithFreshConfig regenerates config before restarting host mcpo", async () => {
  const calls = [];
  await restartHostMcpoWithFreshConfig({
    execAsync: async () => undefined,
    projectRoot: "/repo",
    env: { PATH: "/bin" },
    async regenerateMcpInfrastructure(execAsync, projectRoot, env, options) {
      calls.push({
        step: "regenerate",
        hasExecAsync: typeof execAsync === "function",
        projectRoot,
        env,
        options,
      });
    },
    async stopHostMcpo() {
      calls.push({ step: "stop" });
    },
    async startHostMcpo() {
      calls.push({ step: "start" });
    },
    logger: { log() {} },
    regenerationOptions: { timeout: 1234, force: true },
  });

  assert.deepEqual(calls, [
    {
      step: "regenerate",
      hasExecAsync: true,
      projectRoot: "/repo",
      env: { PATH: "/bin" },
      options: { timeout: 1234, force: true },
    },
    { step: "stop" },
    { step: "start" },
  ]);
});

test("restartHostMcpoWithFreshConfig stops on regeneration failure", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      restartHostMcpoWithFreshConfig({
        execAsync: async () => undefined,
        projectRoot: "/repo",
        env: { PATH: "/bin" },
        async regenerateMcpInfrastructure() {
          calls.push("regenerate");
          throw new Error("regen failed");
        },
        async stopHostMcpo() {
          calls.push("stop");
        },
        async startHostMcpo() {
          calls.push("start");
        },
        logger: { log() {} },
      }),
    /regen failed/,
  );

  assert.deepEqual(calls, ["regenerate"]);
});

test("restartHostMcpoWithFreshConfig can skip regeneration when config was already refreshed", async () => {
  const calls = [];
  await restartHostMcpoWithFreshConfig({
    execAsync: async () => undefined,
    projectRoot: "/repo",
    env: { PATH: "/bin" },
    async regenerateMcpInfrastructure() {
      calls.push("regenerate");
    },
    async stopHostMcpo() {
      calls.push("stop");
    },
    async startHostMcpo() {
      calls.push("start");
    },
    logger: { log() {} },
    skipRegeneration: true,
  });

  assert.deepEqual(calls, ["stop", "start"]);
});

test("collectRestartedHostServerIds filters disabled host servers", () => {
  const result = collectRestartedHostServerIds(
    {
      servers: {
        "chrome-devtools": { deployment: "host", status: "healthy" },
        "local-shell": { deployment: "host", status: "disabled" },
        time: { deployment: "docker", status: "healthy" },
      },
    },
    {
      isServerEffectivelyEnabled(serverId) {
        return serverId !== "local-shell";
      },
    },
  );

  assert.deepEqual(result, ["chrome-devtools"]);
});

test("collectRestartedHostServerIds validates predicate input", () => {
  assert.throws(
    () => collectRestartedHostServerIds({}, { isServerEffectivelyEnabled: null }),
    /isServerEffectivelyEnabled \(function\) is required/,
  );
});
