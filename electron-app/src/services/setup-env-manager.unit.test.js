const test = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  const modulePath = require.resolve("./guided-setup/setup-env-manager");
  delete require.cache[modulePath];
  return require("./guided-setup/setup-env-manager");
}

function withElectronApi(electronAPI, run) {
  const previousWindow = global.window;
  global.window = {
    electronAPI,
  };

  let result;
  try {
    result = run();
  } finally {
    if (!result || typeof result.then !== "function") {
      global.window = previousWindow;
    }
  }

  if (!result || typeof result.then !== "function") {
    return result;
  }

  return result.finally(() => {
    global.window = previousWindow;
  });
}

test("setup env manager tracks the project root and identifies placeholders or deprecated vars", () => {
  const mod = loadModule();

  mod.init("/tmp/project");
  assert.equal(mod.getProjectRoot(), "/tmp/project");
  assert.equal(mod.isPlaceholderValue("your-token-here"), true);
  assert.equal(mod.isPlaceholderValue("sk-portico-where-real-key"), false);
  assert.equal(mod.isPlaceholderValue("real-token"), false);
  assert.equal(
    mod.cleanDeprecatedEnvVars("FOO=1\nOLD=2\n\nANOTHER=3\n", ["OLD"]),
    "FOO=1\n\nANOTHER=3\n",
  );
});

test("isServerConfigured requires all non-placeholder env vars for config-driven servers", () => {
  const mod = loadModule();

  assert.equal(
    mod.isServerConfigured(
      {
        isConfigured: true,
        required_env_vars: [{ name: "GITLAB_PERSONAL_ACCESS_TOKEN", sensitive: true }],
      },
      {},
    ),
    true,
  );
  assert.equal(
    mod.isServerConfigured(
      { required_env_vars: [{ name: "TOKEN" }, { name: "SECRET" }] },
      { TOKEN: "value", SECRET: "your-secret-here" },
    ),
    false,
  );
  assert.equal(
    mod.isServerConfigured(
      { required_env_vars: [{ name: "TOKEN" }] },
      { TOKEN: "value" },
    ),
    true,
  );
  assert.equal(mod.isServerConfigured({}, {}), true);
});

test("loadExistingEnvVars skips comments, placeholders, and runtime-only keys", async () => {
  const mod = loadModule();
  mod.configureSensitiveRequiredEnvVars([
    {
      required_env_vars: [{ name: "SOURCEGRAPH_TOKEN", sensitive: true }],
    },
  ]);

  const envVars = await withElectronApi(
    {
      async readEnvFile() {
        return {
          success: true,
          content: [
            "# Comment",
            "PORTICO_LLM_API_KEY=runtime-only",
            "LOCAL_STACK_API_KEY=runtime-only-local",
            "CLOUDSMITH_ENTITLEMENT_TOKEN=runtime-only-cloudsmith",
            "SOURCEGRAPH_TOKEN=runtime-only-sourcegraph",
            "SOURCEGRAPH_TOKEN_FILE=/tmp/sourcegraph-token",
            "SLACK_TOKEN=slack-secret",
            "PLACEHOLDER=your-token-here",
            "QUERY=value=with=equals",
            "",
          ].join("\n"),
        };
      },
    },
    () => mod.loadExistingEnvVars(),
  );

  assert.deepEqual(envVars, {
    SLACK_TOKEN: "slack-secret",
    QUERY: "value=with=equals",
  });
});

test("saveEnvVarImmediately updates env files, strips runtime-only keys, and persists injected secrets", async () => {
  const mod = loadModule();
  let readCalls = 0;
  let writtenContent = null;
  const runtimeSecretWrites = [];

  await withElectronApi(
    {
      async readEnvFile() {
        readCalls += 1;
        return {
          success: true,
          content:
            "PORTICO_LLM_API_KEY=legacy\nLOCAL_STACK_API_KEY=local-old\nCLOUDSMITH_ENTITLEMENT_TOKEN=cloudsmith-old\nCLOUDSMITH_API_KEY=protected-release-key\nSLACK_TOKEN=old\n",
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
    async () => {
      await mod.saveEnvVarImmediately("SLACK_TOKEN", "new-secret");
      await mod.saveEnvVarImmediately("PORTICO_LLM_API_KEY", "skip-me");
    },
  );

  assert.equal(readCalls, 1);
  assert.doesNotMatch(writtenContent, /PORTICO_LLM_API_KEY=/);
  assert.doesNotMatch(writtenContent, /LOCAL_STACK_API_KEY=/);
  assert.doesNotMatch(writtenContent, /CLOUDSMITH_ENTITLEMENT_TOKEN=/);
  assert.match(writtenContent, /CLOUDSMITH_API_KEY=protected-release-key/);
  assert.match(writtenContent, /SLACK_TOKEN=new-secret/);
  assert.deepEqual(runtimeSecretWrites, [
    { key: "PORTICO_LLM_API_KEY", value: "skip-me" },
  ]);
});

test("saveEnvVarImmediately and generateEnvFile surface write failures", async () => {
  const mod = loadModule();

  await assert.rejects(
    () =>
      withElectronApi(
        {
          async readEnvFile() {
            return { success: true, content: "SLACK_TOKEN=old\n" };
          },
          async writeEnvFile() {
            return { success: false, error: "disk full" };
          },
        },
        () => mod.saveEnvVarImmediately("SLACK_TOKEN", "new"),
      ),
    /Failed to save SLACK_TOKEN to \.env file: disk full/,
  );

  await assert.rejects(
    () =>
      withElectronApi(
        {
          async readEnvFile() {
            return { success: false };
          },
          async writeEnvFile() {
            throw new Error("permission denied");
          },
        },
        () =>
          mod.generateEnvFile({
            SLACK_TOKEN: "token",
          }),
      ),
    /Failed to update \.env file: permission denied/,
  );
});

test("generateEnvFile writes configured values into a new or existing env document", async () => {
  const mod = loadModule();
  let writtenContent = null;
  const runtimeSecretWrites = [];

  await withElectronApi(
    {
      async readEnvFile() {
        return {
          success: true,
          content:
            "PORTICO_LLM_API_KEY=legacy\nLOCAL_STACK_API_KEY=local-old\nCLOUDSMITH_ENTITLEMENT_TOKEN=cloudsmith-old\nCLOUDSMITH_API_KEY=protected-release-key\nSLACK_TOKEN=old\n",
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
    () =>
      mod.generateEnvFile({
        SLACK_TOKEN: "new",
        TEAMWORKS_KEY: "teamworks",
        PORTICO_LLM_API_KEY: "skip",
      }),
  );

  assert.doesNotMatch(writtenContent, /PORTICO_LLM_API_KEY=/);
  assert.doesNotMatch(writtenContent, /LOCAL_STACK_API_KEY=/);
  assert.doesNotMatch(writtenContent, /CLOUDSMITH_ENTITLEMENT_TOKEN=/);
  assert.match(writtenContent, /CLOUDSMITH_API_KEY=protected-release-key/);
  assert.match(writtenContent, /SLACK_TOKEN=new/);
  assert.match(writtenContent, /TEAMWORKS_KEY=teamworks/);
  assert.deepEqual(runtimeSecretWrites, [
    { key: "PORTICO_LLM_API_KEY", value: "skip" },
  ]);
});

test("generateEnvFile persists sensitive required env vars securely and keeps non-sensitive values", async () => {
  const mod = loadModule();
  let writtenContent = null;
  const runtimeSecretWrites = [];

  mod.configureSensitiveRequiredEnvVars([
    {
      required_env_vars: [
        { name: "MATRIX_SECRET", sensitive: true },
        { name: "MATRIX_PUBLIC", sensitive: false },
        "MATRIX_LEGACY",
      ],
    },
  ]);

  await withElectronApi(
    {
      async readEnvFile() {
        return {
          success: true,
          content: [
            "MATRIX_SECRET=legacy-secret",
            "MATRIX_SECRET_FILE=/tmp/legacy-secret",
            "MATRIX_PUBLIC=old-public",
            "",
          ].join("\n"),
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
    () =>
      mod.generateEnvFile({
        MATRIX_SECRET: "new-secret",
        MATRIX_PUBLIC: "new-public",
        MATRIX_LEGACY: "legacy-public",
        MATRIX_PRESET: "preset value",
      }),
  );

  assert.doesNotMatch(writtenContent, /MATRIX_SECRET=/);
  assert.doesNotMatch(writtenContent, /MATRIX_SECRET_FILE=/);
  assert.match(writtenContent, /MATRIX_PUBLIC=new-public/);
  assert.match(writtenContent, /MATRIX_LEGACY=legacy-public/);
  assert.match(writtenContent, /MATRIX_PRESET=preset value/);
  assert.deepEqual(runtimeSecretWrites, [
    { key: "MATRIX_SECRET", value: "new-secret" },
  ]);
});

test("saveEnvVarImmediately does not log env var values", async () => {
  const mod = loadModule();
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  try {
    await withElectronApi(
      {
        async readEnvFile() {
          return { success: true, content: "SAFE_KEY=old\n" };
        },
        async writeEnvFile() {
          return { success: true };
        },
      },
      () => mod.saveEnvVarImmediately("SAFE_KEY", "sensitive-value-123"),
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(
    logs.some((line) => line.includes("sensitive-value-123")),
    false,
  );
});

test("guided setup never hydrates or rewrites the Ultra signing secret as plaintext", async () => {
  const mod = loadModule();
  const plaintextSecret = "ultra-sign-v1-guided-setup-test-secret";
  let writtenContent = null;
  const runtimeSecretWrites = [];
  const electronAPI = {
    async readEnvFile() {
      return {
        success: true,
        content: [
          "ULTRA_MULTI_AGENT_SIGNING_SECRET=" + plaintextSecret,
          "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE=/tmp/ultra-signing-secret",
          "VISIBLE_SETTING=kept",
          "",
        ].join("\n"),
      };
    },
    async writeEnvFile(content) {
      writtenContent = content;
      return { success: true };
    },
    async upsertRuntimeSecret(key, value) {
      runtimeSecretWrites.push({ key, value });
      return { success: true };
    },
  };

  const loaded = await withElectronApi(
    electronAPI,
    () => mod.loadExistingEnvVars(),
  );
  assert.deepEqual(loaded, { VISIBLE_SETTING: "kept" });

  await withElectronApi(
    electronAPI,
    () =>
      mod.generateEnvFile({
        ULTRA_MULTI_AGENT_SIGNING_SECRET: plaintextSecret,
        VISIBLE_SETTING: "updated",
      }),
  );

  assert.doesNotMatch(
    writtenContent,
    /ULTRA_MULTI_AGENT_SIGNING_SECRET(?:_FILE)?=/,
  );
  assert.match(writtenContent, /VISIBLE_SETTING=updated/);
  assert.deepEqual(runtimeSecretWrites, [
    {
      key: "ULTRA_MULTI_AGENT_SIGNING_SECRET",
      value: plaintextSecret,
    },
  ]);
});
