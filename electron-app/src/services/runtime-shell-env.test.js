const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildEnhancedPath,
  createRuntimeShellEnv,
} = require("./runtime-shell-env");

function withTempManagedRoot(run) {
  const managedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-shell-env-"),
  );
  try {
    return run(managedRoot);
  } finally {
    fs.rmSync(managedRoot, { recursive: true, force: true });
  }
}

function withMockKeychain(run) {
  const modulePath = require.resolve("./llm-keychain");
  const previous = require.cache[modulePath];
  const stored = new Map();
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      readPorticoLlmApiKeyFromKeychainSync({ env = {} } = {}) {
        return stored.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
      },
      upsertPorticoLlmApiKeyInKeychainSync(value, { env = {} } = {}) {
        stored.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
        return value;
      },
      deletePorticoLlmApiKeyFromKeychainSync() {
        return false;
      },
    },
  };
  try {
    return run(stored);
  } finally {
    if (previous) {
      require.cache[modulePath] = previous;
    } else {
      delete require.cache[modulePath];
    }
  }
}

test("buildEnhancedPath prioritizes OrbStack-aware fallback paths without duplicating entries", () => {
  const localBin = `${os.homedir()}/.local/bin`;
  const pathValue = buildEnhancedPath(`/usr/bin:${localBin}:/custom/bin:/usr/bin`);
  const entries = pathValue.split(":");

  assert.deepEqual(entries.slice(0, 6), [
    "/Applications/OrbStack.app/Contents/MacOS/xbin",
    "/Applications/OrbStack.app/Contents/MacOS/bin",
    `${os.homedir()}/Applications/OrbStack.app/Contents/MacOS/xbin`,
    `${os.homedir()}/Applications/OrbStack.app/Contents/MacOS/bin`,
    `${os.homedir()}/.orbstack/bin`,
    localBin,
  ]);
  assert.ok(entries.includes("/usr/local/bin"));
  assert.ok(entries.includes("/opt/homebrew/bin"));
  assert.ok(entries.includes("/custom/bin"));
  assert.equal(
    entries.filter((entry) => entry === localBin).length,
    1,
  );
  assert.equal(
    entries.filter((entry) => entry === "/usr/bin").length,
    1,
  );
});

test("createRuntimeShellEnv adds packaged mcp-orc context for packaged runs", () => {
  withTempManagedRoot((managedRoot) => {
    const env = createRuntimeShellEnv({
      baseEnv: {
        PATH: "/usr/bin",
        PORTICO_MANAGED_ROOT: managedRoot,
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      },
      overrides: { EXAMPLE: "value" },
      isPackagedApp: true,
      resourcesPath: "/Applications/Portico.app/Contents/Resources",
    });

    assert.equal(env.EXAMPLE, "value");
    assert.equal(env.HOST_MCP_IS_PACKAGED, "1");
    assert.equal(
      env.HOST_MCP_RESOURCES_ROOT,
      "/Applications/Portico.app/Contents/Resources",
    );
    assert.match(env.PATH, /\/Applications\/OrbStack\.app\/Contents\/MacOS\/xbin/);
    assert.match(
      env.PATH,
      new RegExp(`${os.homedir()}/Applications/OrbStack\\.app/Contents/MacOS/xbin`),
    );
    assert.equal(env.FORCE_COLOR, "1");
    assert.equal(env.TERM, "xterm-256color");
    assert.match(env.LOCAL_STACK_API_KEY, /^sk-local-/);
    assert.match(env.BIFROST_BRIDGE_LOCAL_API_KEY, /^sk-bifrost-local-/);
    assert.match(env.OWUI_AUTH_BRIDGE_SECRET, /^owui-bridge-/);
    assert.match(env.WEBUI_SECRET_KEY, /^[A-Za-z0-9_-]{48,}$/);
    assert.notEqual(env.BIFROST_BRIDGE_LOCAL_API_KEY, env.LOCAL_STACK_API_KEY);
    assert.notEqual(env.OWUI_AUTH_BRIDGE_SECRET, env.WEBUI_SECRET_KEY);
  });
});

test("createRuntimeShellEnv clears packaged resource context for non-packaged runs", () => {
  withTempManagedRoot((managedRoot) => {
    const env = createRuntimeShellEnv({
      baseEnv: {
        PATH: "/usr/bin",
        HOST_MCP_RESOURCES_ROOT: "/Applications/Portico.app/Contents/Resources",
        PORTICO_MANAGED_ROOT: managedRoot,
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      },
      isPackagedApp: false,
    });

    assert.equal(env.HOST_MCP_IS_PACKAGED, "0");
    assert.equal(Object.hasOwn(env, "HOST_MCP_RESOURCES_ROOT"), false);
  });
});

test("createRuntimeShellEnv strips runtime Cloudsmith API key by default", () => {
  withTempManagedRoot((managedRoot) => {
    const env = createRuntimeShellEnv({
      baseEnv: {
        PATH: "/usr/bin",
        PORTICO_MANAGED_ROOT: managedRoot,
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
        CLOUDSMITH_API_KEY: "dev-upload-token",
      },
      overrides: {
        CLOUDSMITH_ENTITLEMENT_TOKEN: "cloudsmith-read-token",
      },
    });

    assert.equal(Object.hasOwn(env, "CLOUDSMITH_API_KEY"), false);
    assert.equal(env.CLOUDSMITH_ENTITLEMENT_TOKEN, "cloudsmith-read-token");
  });
});

test("createRuntimeShellEnv strips legacy Slack OAuth client credentials", () => {
  withTempManagedRoot((managedRoot) => {
    const env = createRuntimeShellEnv({
      baseEnv: {
        PATH: "/usr/bin",
        PORTICO_MANAGED_ROOT: managedRoot,
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
        SLACK_OAUTH_CLIENT_ID: "legacy-client-id",
        SLACK_OAUTH_CLIENT_SECRET: "legacy-client-secret",
        SLACK_OAUTH_CLIENT_ID_FILE: "/tmp/legacy-client-id",
        SLACK_OAUTH_CLIENT_SECRET_FILE: "/tmp/legacy-client-secret",
      },
      overrides: {
        SLACK_OAUTH_CLIENT_SECRET: "override-secret",
      },
    });

    assert.equal(Object.hasOwn(env, "SLACK_OAUTH_CLIENT_ID"), false);
    assert.equal(Object.hasOwn(env, "SLACK_OAUTH_CLIENT_SECRET"), false);
    assert.equal(Object.hasOwn(env, "SLACK_OAUTH_CLIENT_ID_FILE"), false);
    assert.equal(Object.hasOwn(env, "SLACK_OAUTH_CLIENT_SECRET_FILE"), false);
  });
});

test("createRuntimeShellEnv keeps runtime Cloudsmith API key when explicitly allowed", () => {
  withTempManagedRoot((managedRoot) => {
    const env = createRuntimeShellEnv({
      baseEnv: {
        PATH: "/usr/bin",
        PORTICO_MANAGED_ROOT: managedRoot,
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
        CLOUDSMITH_API_KEY: "dev-upload-token",
      },
      overrides: {
        PORTICO_ALLOW_RUNTIME_CLOUDSMITH_API_KEY: "1",
      },
    });

    assert.equal(env.CLOUDSMITH_API_KEY, "dev-upload-token");
  });
});

test("createRuntimeShellEnv exposes sensitive MCP presence without secret bytes", () => {
  withTempManagedRoot((managedRoot) => {
    const serverId = "trust-kit-mcp";
    const serverDir = path.join(managedRoot, "mcp-configs", serverId);
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, `${serverId}.yaml`),
      [
        "name: Trust Kit",
        "required_env_vars:",
        "  - name: waldoapikey",
        "    sensitive: true",
        "",
      ].join("\n"),
      "utf8",
    );

    withMockKeychain(() => {
      const env = createRuntimeShellEnv({
        baseEnv: {
          PATH: "/usr/bin",
          PROJECT_ROOT: managedRoot,
          PORTICO_MANAGED_ROOT: managedRoot,
          waldoapikey: "waldo-secret-value",
        },
      });

      assert.equal(Object.hasOwn(env, "waldoapikey"), false);
      assert.equal(
        env.portico_STATIC_SECRET_AVAILABLE_TRUST_KIT_MCP_WALDOAPIKEY,
        "1",
      );
      assert.equal(
        Object.values(env).includes("waldo-secret-value"),
        false,
        "child environments must not contain the sensitive value",
      );
    });
  });
});
