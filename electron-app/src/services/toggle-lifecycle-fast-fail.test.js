const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
  DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS,
  awaitEnableToggleFastFail,
  resolveEnableToggleLifecycleResult,
  buildStartingToggleReadiness,
  detectRuntimeFilePreflightIssue,
  detectToggleEnablePreflightIssue,
  isConfigurationRequiredPreflightIssue,
  isSavedSecretUnavailableIssue,
  isActionableEnableReadiness,
  SNOWFLAKE_SECRET_RECOVERY_PROMPT,
} = require("./toggle-lifecycle-fast-fail");
const {
  SENSITIVE_RUNTIME_FILE_STUB,
  sensitiveRuntimeFileCachePath,
} = require("../config/runtime-secrets-config");

test("DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS is a generous safety-net deadline (response driven by lifecycle events, not this timeout)", () => {
  assert.equal(DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS >= 30000, true);
  assert.equal(DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS <= 500, true);
});

test("awaitEnableToggleFastFail returns early when lifecycle keeps running", async () => {
  let sleepCalls = 0;
  const result = await awaitEnableToggleFastFail(new Promise(() => {}), {
    fastFailMs: 5,
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  assert.deepEqual(result, { settled: false });
  assert.equal(sleepCalls, 1);
});

test("awaitEnableToggleFastFail returns the lifecycle result when it fails fast", async () => {
  const result = await awaitEnableToggleFastFail(
    Promise.resolve({ success: false, errorCode: "SERVICE_NOT_FOUND" }),
    {
      fastFailMs: 5,
      sleep: () => new Promise(() => {}),
    },
  );

  assert.deepEqual(result, {
    settled: true,
    result: { success: false, errorCode: "SERVICE_NOT_FOUND" },
  });
});

test("isActionableEnableReadiness recognizes healthy and oauth-actionable phases", () => {
  assert.equal(
    isActionableEnableReadiness({ healthy: true, readinessPhase: "tool_ready" }),
    true,
  );
  assert.equal(
    isActionableEnableReadiness({ healthy: false, readinessPhase: "healthy" }),
    true,
  );
  assert.equal(
    isActionableEnableReadiness({ healthy: false, readinessPhase: "needs_oauth" }),
    true,
  );
  assert.equal(
    isActionableEnableReadiness({ healthy: false, readinessPhase: "starting" }),
    false,
  );
});

test("resolveEnableToggleLifecycleResult returns readiness before the lifecycle finishes", async () => {
  let releaseLifecycle;
  const lifecyclePromise = new Promise((resolve) => {
    releaseLifecycle = () => resolve({ success: true, mode: "docker" });
  });

  let readinessCalls = 0;
  const resultPromise = resolveEnableToggleLifecycleResult(lifecyclePromise, {
    responseDeadlineMs: 50,
    pollIntervalMs: 5,
    initialReadiness: buildStartingToggleReadiness(true),
    getReadiness: async () => {
      readinessCalls += 1;
      if (readinessCalls < 2) {
        return { healthy: false, readinessPhase: "starting" };
      }
      return { healthy: false, readinessPhase: "needs_oauth" };
    },
    sleep: async () => undefined,
  });

  const result = await resultPromise;
  assert.equal(result.source, "readiness");
  assert.deepEqual(result.readinessResult, {
    healthy: false,
    readinessPhase: "needs_oauth",
  });
  assert.equal(result.lifecycleResult, null);
  assert.equal(readinessCalls >= 2, true);

  releaseLifecycle();
});

test("resolveEnableToggleLifecycleResult returns lifecycle failure immediately", async () => {
  const result = await resolveEnableToggleLifecycleResult(
    Promise.resolve({ success: false, errorCode: "SERVICE_NOT_FOUND" }),
    {
      responseDeadlineMs: 50,
      pollIntervalMs: 5,
      initialReadiness: buildStartingToggleReadiness(true),
      getReadiness: async () => ({ healthy: false, readinessPhase: "starting" }),
      sleep: async () => undefined,
    },
  );

  assert.equal(result.source, "lifecycle");
  assert.deepEqual(result.lifecycleResult, {
    success: false,
    errorCode: "SERVICE_NOT_FOUND",
  });
});

test("resolveEnableToggleLifecycleResult keeps polling after lifecycle success until readiness becomes actionable", async () => {
  let readinessCalls = 0;
  const result = await resolveEnableToggleLifecycleResult(
    Promise.resolve({ success: true, mode: "docker" }),
    {
      responseDeadlineMs: 50,
      pollIntervalMs: 5,
      initialReadiness: buildStartingToggleReadiness(true),
      getReadiness: async () => {
        readinessCalls += 1;
        if (readinessCalls < 2) {
          return { healthy: false, readinessPhase: "starting" };
        }
        return { healthy: true, readinessPhase: "tool_ready" };
      },
      sleep: async () => undefined,
    },
  );

  assert.equal(result.source, "readiness");
  assert.deepEqual(result.lifecycleResult, {
    success: true,
    mode: "docker",
  });
  assert.deepEqual(result.readinessResult, {
    healthy: true,
    readinessPhase: "tool_ready",
  });
  assert.equal(readinessCalls >= 2, true);
});

test("resolveEnableToggleLifecycleResult returns starting at the response deadline", async () => {
  const result = await resolveEnableToggleLifecycleResult(new Promise(() => {}), {
    responseDeadlineMs: 5,
    pollIntervalMs: 5,
    initialReadiness: buildStartingToggleReadiness(true),
    getReadiness: async () => ({ healthy: false, readinessPhase: "starting" }),
    sleep: async () => undefined,
  });

  assert.equal(result.source, "deadline");
  assert.deepEqual(result.readinessResult, {
    healthy: false,
    readinessPhase: "starting",
  });
  assert.equal(result.lifecycleResult, null);
});

test("detectToggleEnablePreflightIssue reports missing required env vars", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const yamlPath = path.join(projectRoot, "google_workspace.yaml");
  fs.writeFileSync(
    yamlPath,
    "required_env_vars:\n  - GOOGLE_CLIENT_ID\n  - GOOGLE_CLIENT_SECRET\n",
    "utf8",
  );
  fs.writeFileSync(path.join(projectRoot, ".env"), "GOOGLE_CLIENT_ID=abc\n", "utf8");

  const issue = detectToggleEnablePreflightIssue("google_workspace", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml(raw) {
      const vars = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => ({ name: line.slice(2) }));
      return { required_env_vars: vars };
    },
    parseEnvFile(raw) {
      return Object.fromEntries(
        raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=", 2)),
      );
    },
    checkServerConfigured(serverData, envData) {
      return serverData.required_env_vars.every((entry) => envData[entry.name]);
    },
  });

  assert.equal(issue.errorCode, "NOT_CONFIGURED");
  assert.match(issue.message, /trigger_guided_setup/);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue reports invalid user fragment JSON", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const serverDir = path.join(projectRoot, "mcp-configs-user", "user-snowflake-cortex");
  fs.mkdirSync(serverDir, { recursive: true });
  const yamlPath = path.join(serverDir, "user-snowflake-cortex.yaml");
  fs.writeFileSync(yamlPath, "required_env_vars: []\n", "utf8");
  fs.writeFileSync(
    path.join(serverDir, "user-snowflake-cortex.fragment"),
    '{ "args": ["snowflake-labs-mcp",], }\n',
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("user-snowflake-cortex", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return { required_env_vars: [] };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.equal(issue.errorCode, "INVALID_FRAGMENT_JSON");
  assert.equal(issue.stage, "config_generation");
  assert.equal(issue.source, "config");
  assert.match(issue.error, /Invalid JSON in fragment for user-snowflake-cortex/);
  assert.match(issue.error, /Unexpected token|Expected/);
  assert.equal(
    issue.configPath,
    path.join(serverDir, "user-snowflake-cortex.fragment"),
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue reports malformed user YAML as configuration required", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const serverDir = path.join(projectRoot, "mcp-configs-user", "broken-yaml");
  fs.mkdirSync(serverDir, { recursive: true });
  const yamlPath = path.join(serverDir, "broken-yaml.yaml");
  fs.writeFileSync(yamlPath, "display_name: [unterminated\n", "utf8");
  let parseOptions = null;

  const issue = detectToggleEnablePreflightIssue("broken-yaml", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml(_raw, options) {
      parseOptions = options;
      const error = new Error("unexpected end of the stream");
      error.reason = "unexpected end of the stream within a flow collection";
      error.mark = { line: 1, column: 0 };
      throw error;
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.deepEqual(parseOptions, { throwOnError: true });
  assert.equal(issue.errorCode, "INVALID_USER_SERVER_CONFIG");
  assert.equal(issue.configurationIssue, "invalid_server_config");
  assert.equal(issue.requiresConfiguration, true);
  assert.equal(issue.requiredAction, "configure");
  assert.equal(issue.severity, "error");
  assert.equal(issue.stage, "config_generation");
  assert.equal(issue.source, "config");
  assert.equal(issue.configPath, yamlPath);
  assert.equal(
    issue.message,
    `invalid YAML in ${yamlPath}: unexpected end of the stream within a flow collection at line 2 column 1`,
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue reuses a current generated YAML diagnostic", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const serverDir = path.join(projectRoot, "mcp-configs-user", "broken-yaml");
  const generatedDir = path.join(projectRoot, "mcpo-configs-generated");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  const yamlPath = path.join(serverDir, "broken-yaml.yaml");
  fs.writeFileSync(yamlPath, "display_name: [unterminated\n", "utf8");
  const canonicalError =
    `invalid YAML in ${yamlPath}: did not find expected ',' or ']' at line 2 column 1, ` +
    "while parsing a flow sequence at line 1 column 15";
  fs.writeFileSync(
    path.join(generatedDir, "server-config-status.json"),
    JSON.stringify({
      servers: {
        "broken-yaml": {
          configured: false,
          status: "not_configured",
          error: canonicalError,
          error_code: "INVALID_USER_SERVER_CONFIG",
          source: "config",
          stage: "config_generation",
        },
      },
    }),
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("broken-yaml", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      throw new Error("different JavaScript parser wording");
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.equal(issue.message, canonicalError);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue accepts valid fragment JSON", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const serverDir = path.join(projectRoot, "mcp-configs-user", "assumeapi-product");
  fs.mkdirSync(serverDir, { recursive: true });
  const yamlPath = path.join(serverDir, "assumeapi-product.yaml");
  fs.writeFileSync(yamlPath, "required_env_vars: []\n", "utf8");
  fs.writeFileSync(
    path.join(serverDir, "assumeapi-product.fragment"),
    '{ "command": "uvx", "args": ["assumeapi-product"] }\n',
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("assumeapi-product", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return { required_env_vars: [] };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.equal(issue, null);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue checks env after valid fragment JSON", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const serverDir = path.join(projectRoot, "mcp-configs-user", "example");
  fs.mkdirSync(serverDir, { recursive: true });
  const yamlPath = path.join(serverDir, "example.yaml");
  fs.writeFileSync(yamlPath, "required_env_vars:\n  - TOKEN\n", "utf8");
  fs.writeFileSync(
    path.join(serverDir, "example.fragment"),
    '{ "command": "node", "args": ["server.js"] }\n',
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("example", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return { required_env_vars: [{ name: "TOKEN" }] };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured(serverData, envData) {
      return serverData.required_env_vars.every((entry) => envData[entry.name]);
    },
  });

  assert.equal(issue.errorCode, "NOT_CONFIGURED");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue reports missing runtime_files sources as not configured", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const yamlPath = path.join(projectRoot, "runtime-server.yaml");
  fs.writeFileSync(
    yamlPath,
    "required_env_vars: []\nruntime_files:\n  - source: ./missing.yaml\n    filename: mcp_config.yaml\n",
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("runtime-server", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return {
        required_env_vars: [],
        runtime_files: [{ source: "./missing.yaml", filename: "mcp_config.yaml" }],
      };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.equal(issue.errorCode, "NOT_CONFIGURED");
  assert.equal(issue.stage, "config_generation");
  assert.equal(issue.source, "config");
  assert.equal(issue.error, "Missing runtime file: ./missing.yaml");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectRuntimeFilePreflightIssue accepts missing sensitive runtime_files source from persisted secure storage", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));

  const issue = detectRuntimeFilePreflightIssue(
    "snowflake",
    {
      runtime_files: [
        {
          source: "./missing-connections.toml",
          target: "/root/.snowflake/connections.toml",
          sensitive: true,
        },
      ],
    },
    {
      projectRoot,
      isSensitiveRuntimeFilePersisted({ serverId, target, source }) {
        assert.equal(serverId, "snowflake");
        assert.equal(target, "/root/.snowflake/connections.toml");
        assert.equal(source, "./missing-connections.toml");
        return true;
      },
    },
  );

  assert.equal(issue, null);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectRuntimeFilePreflightIssue reports missing sensitive runtime_files source when no secure copy exists", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));

  const issue = detectRuntimeFilePreflightIssue(
    "snowflake",
    {
      runtime_files: [
        {
          source: "./missing-connections.toml",
          target: "/root/.snowflake/connections.toml",
          sensitive: true,
        },
      ],
    },
    {
      projectRoot,
      isSensitiveRuntimeFilePersisted() {
        return false;
      },
    },
  );

  assert.equal(issue.errorCode, "NOT_CONFIGURED");
  assert.equal(issue.stage, "config_generation");
  assert.equal(issue.source, "config");
  assert.equal(issue.error, "Missing runtime file: ./missing-connections.toml");
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectRuntimeFilePreflightIssue classifies a scrubbed stub without secure storage as an unavailable saved secret", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const sourcePath = path.join(projectRoot, "connections.toml");
  fs.writeFileSync(sourcePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");

  const issue = detectRuntimeFilePreflightIssue(
    "snowflake",
    {
      runtime_files: [
        {
          source: "./connections.toml",
          target: "/root/.snowflake/connections.toml",
          sensitive: true,
        },
      ],
    },
    {
      projectRoot,
      isSensitiveRuntimeFilePersisted() {
        return false;
      },
    },
  );

  assert.equal(issue.errorCode, "SAVED_SECRET_UNAVAILABLE");
  assert.equal(issue.configurationIssue, "saved_secret_unavailable");
  assert.equal(issue.requiresConfiguration, true);
  assert.equal(issue.requiresSecretReplacement, true);
  assert.equal(issue.requiredAction, "replace_saved_secret");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.recoveryPrompt, SNOWFLAKE_SECRET_RECOVERY_PROMPT);
  assert.match(issue.message, /saved Snowflake connection is unavailable/i);
  assert.equal(isSavedSecretUnavailableIssue(issue), true);
  assert.equal(isConfigurationRequiredPreflightIssue(issue), true);
  assert.doesNotMatch(JSON.stringify(issue), /token\s*=|SECRET_PAT/);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue forwards secure persistence checks for healthy and stale placeholders", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const sourcePath = path.join(projectRoot, "connections.toml");
  const yamlPath = path.join(projectRoot, "snowflake.yaml");
  fs.writeFileSync(sourcePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");
  fs.writeFileSync(yamlPath, "required_env_vars: []\n", "utf8");
  const options = {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return {
        required_env_vars: [],
        runtime_files: [
          {
            source: "./connections.toml",
            target: "/root/.snowflake/connections.toml",
            sensitive: true,
          },
        ],
      };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  };

  const healthy = detectToggleEnablePreflightIssue("snowflake", {
    ...options,
    isSensitiveRuntimeFilePersisted() {
      return true;
    },
  });
  assert.equal(healthy, null);

  const stale = detectToggleEnablePreflightIssue("snowflake", {
    ...options,
    isSensitiveRuntimeFilePersisted() {
      return false;
    },
  });
  assert.equal(stale.errorCode, "SAVED_SECRET_UNAVAILABLE");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("saved-secret classification wins over a separate missing non-secret runtime file", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  fs.writeFileSync(
    path.join(projectRoot, "connections.toml"),
    SENSITIVE_RUNTIME_FILE_STUB,
    "utf8",
  );

  const issue = detectRuntimeFilePreflightIssue(
    "snowflake",
    {
      runtime_files: [
        {
          source: "./connections.toml",
          target: "/root/.snowflake/connections.toml",
          sensitive: true,
        },
        {
          source: "./missing-mcp-config.yaml",
          target: "/root/.snowflake/mcp_config.yaml",
        },
      ],
    },
    {
      projectRoot,
      isSensitiveRuntimeFilePersisted() {
        return false;
      },
    },
  );

  assert.equal(issue.errorCode, "SAVED_SECRET_UNAVAILABLE");
  assert.equal(issue.configurationIssue, "saved_secret_unavailable");
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectRuntimeFilePreflightIssue rejects missing sensitive runtime_files source from legacy runtime-secret cache", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const cacheDir = path.join(projectRoot, "runtime-secret-cache");
  const target = "/root/.snowflake/connections.toml";
  const env = {
    PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
    PORTICO_RUNTIME_SECRET_CACHE_DIR: cacheDir,
  };
  const cachePath = sensitiveRuntimeFileCachePath("snowflake", target, {
    env,
    homeDir: projectRoot,
    platform: "darwin",
  });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, 'token = "cached"\n', "utf8");

  const issue = detectRuntimeFilePreflightIssue(
    "snowflake",
    {
      runtime_files: [
        {
          source: "./missing-connections.toml",
          target,
          sensitive: true,
        },
      ],
    },
    {
      projectRoot,
      env,
      homeDir: projectRoot,
    },
  );

  assert.equal(issue.errorCode, "NOT_CONFIGURED");
  assert.equal(issue.stage, "config_generation");
  assert.equal(issue.source, "config");
  assert.equal(issue.error, "Missing runtime file: ./missing-connections.toml");
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue accepts existing runtime_files sources with relative and home paths", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-home-"));
  fs.writeFileSync(path.join(projectRoot, "local.yaml"), "ok\n", "utf8");
  fs.writeFileSync(path.join(homeDir, "home.yaml"), "ok\n", "utf8");
  const yamlPath = path.join(projectRoot, "runtime-server.yaml");
  fs.writeFileSync(yamlPath, "required_env_vars: []\n", "utf8");

  const issue = detectToggleEnablePreflightIssue("runtime-server", {
    projectRoot,
    homeDir,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml() {
      return {
        required_env_vars: [],
        runtime_files: [
          { source: "./local.yaml", filename: "local.yaml" },
          { source: "~/home.yaml", target: "/root/.config/example/home.yaml" },
        ],
      };
    },
    parseEnvFile() {
      return {};
    },
    checkServerConfigured() {
      return true;
    },
  });

  assert.equal(issue, null);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("detectRuntimeFilePreflightIssue rejects malformed runtime_files definitions", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const runtimeDir = path.join(projectRoot, "runtime");
  fs.mkdirSync(runtimeDir);
  const runtimeFile = path.join(runtimeDir, "config.yaml");
  fs.writeFileSync(runtimeFile, "ok\n", "utf8");

  const cases = [
    {
      name: "non-list",
      runtime_files: { source: "./runtime/config.yaml" },
      error: "runtime_files must be a list",
    },
    {
      name: "scalar entry",
      runtime_files: ["./runtime/config.yaml"],
      error: "runtime_files entries must be mappings",
    },
    {
      name: "target plus filename",
      runtime_files: [
        {
          source: "./runtime/config.yaml",
          target: "/app/runtime/config.yaml",
          filename: "config.yaml",
        },
      ],
      error: "runtime_files target cannot be combined with filename",
    },
    {
      name: "duplicate target",
      runtime_files: [
        { source: "./runtime/config.yaml", filename: "same.yaml" },
        { source: "./runtime/config.yaml", filename: "same.yaml" },
      ],
      error: "duplicate runtime_files target '/app/runtime/same.yaml'",
    },
    {
      name: "invalid target",
      runtime_files: [
        { source: "./runtime/config.yaml", target: "app/runtime/config.yaml" },
      ],
      error: "runtime_files target must be an absolute container file path",
    },
    {
      name: "directory source",
      runtime_files: [{ source: "./runtime", target: "/app/runtime/config.yaml" }],
      error: "runtime_files source './runtime' must be a regular file",
    },
    {
      name: "non-boolean sensitive",
      runtime_files: [
        {
          source: "./runtime/config.yaml",
          target: "/app/runtime/config.yaml",
          sensitive: "yes",
        },
      ],
      error: "runtime_files sensitive must be true or false",
    },
  ];

  for (const testCase of cases) {
    const issue = detectRuntimeFilePreflightIssue(
      "runtime-server",
      { runtime_files: testCase.runtime_files },
      { projectRoot },
    );
    assert.equal(issue.errorCode, "INVALID_RUNTIME_FILES", testCase.name);
    assert.match(issue.error, new RegExp(testCase.error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), testCase.name);
  }

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("detectToggleEnablePreflightIssue returns null when config is complete", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toggle-fast-fail-"));
  const yamlPath = path.join(projectRoot, "google_workspace.yaml");
  fs.writeFileSync(
    yamlPath,
    "required_env_vars:\n  - GOOGLE_CLIENT_ID\n  - GOOGLE_CLIENT_SECRET\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    "GOOGLE_CLIENT_ID=abc\nGOOGLE_CLIENT_SECRET=def\n",
    "utf8",
  );

  const issue = detectToggleEnablePreflightIssue("google_workspace", {
    projectRoot,
    findServerYaml() {
      return yamlPath;
    },
    parseYaml(raw) {
      const vars = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => ({ name: line.slice(2) }));
      return { required_env_vars: vars };
    },
    parseEnvFile(raw) {
      return Object.fromEntries(
        raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=", 2)),
      );
    },
    checkServerConfigured(serverData, envData) {
      return serverData.required_env_vars.every((entry) => envData[entry.name]);
    },
  });

  assert.equal(issue, null);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("buildStartingToggleReadiness returns starting for enable and disabled for disable", () => {
  assert.deepEqual(buildStartingToggleReadiness(true), {
    healthy: false,
    readinessPhase: "starting",
  });
  assert.deepEqual(buildStartingToggleReadiness(false), {
    healthy: false,
    readinessPhase: "disabled",
  });
});
