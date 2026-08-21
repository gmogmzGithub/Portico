const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildRuntimeSecretEnv,
  clearLegacySlackOAuthArtifacts,
  cleanupLegacyBundledSlackKeychainCredentials,
  deleteRuntimeSecret,
  discoverSensitiveRuntimeFiles,
  discoverSensitiveRequiredEnvVars,
  dockerSecretNameForEnvVar,
  getMcpSensitiveSecretPresence,
  isMalformedPorticoLlmApiKey,
  isSensitiveRuntimeFilePersisted,
  listRuntimeWritableSecretKeys,
  parseEnvFile,
  resolveAiMarketplaceApiKey,
  validateUltraMultiAgentSigningSecret,
  resolveBifrostLocalApiKey,
  resolveCloudsmithApiKey,
  resolveCloudsmithEntitlementToken,
  secureCloudsmithBootstrapSecrets,
  resolvePorticoLlmApiKey,
  resolveLocalStackApiKey,
  runtimeSecretEnvFileKeys,
  resetSensitiveRuntimeFileImportSessionStateForTests,
  resolveMcpSensitiveRuntimeFileSecrets,
  resolveMcpSensitiveEnvSecrets,
  SENSITIVE_RUNTIME_FILE_STUB,
  sensitiveRuntimeFileCachePath,
  sensitiveRuntimeFileKeychainAccount,
  sensitiveRuntimeFileSecretEnvVar,
  sensitiveRuntimeFileSecretName,
  staticSecretAvailabilityEnvVar,
  stripLegacyPorticoLlmApiKeyFromRuntimeFiles,
  upsertRuntimeSecret,
} = require("./runtime-secrets-config");

function withTempManagedRoot(run) {
  const managedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-secrets-config-"),
  );
  try {
    return run(managedRoot);
  } finally {
    fs.rmSync(managedRoot, { recursive: true, force: true });
  }
}

function writeMcpServerYaml(projectRoot, serverId, body) {
  const serverDir = path.join(projectRoot, "mcp-configs", serverId);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, `${serverId}.yaml`), body, "utf8");
}

function withMockKeychain(mockExports, run) {
  const modulePath = require.resolve("../services/llm-keychain");
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: mockExports,
  };
  try {
    return run();
  } finally {
    if (previous) {
      require.cache[modulePath] = previous;
    } else {
      delete require.cache[modulePath];
    }
  }
}

test("resolveLocalStackApiKey persists a generated per-install secret", () => {
  withTempManagedRoot((managedRoot) => {
    const generated = resolveLocalStackApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });

    assert.match(generated, /^sk-local-/);
    const runtimeSecrets = parseEnvFile(path.join(managedRoot, "runtime-secrets.env"));
    assert.equal(runtimeSecrets.LOCAL_STACK_API_KEY, generated);
  });
});

test("resolveBifrostLocalApiKey generates a dedicated local bearer key", () => {
  withTempManagedRoot((managedRoot) => {
    const localStack = resolveLocalStackApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });
    const bifrostLocal = resolveBifrostLocalApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });

    assert.match(localStack, /^sk-local-/);
    assert.match(bifrostLocal, /^sk-bifrost-local-/);
    assert.notEqual(bifrostLocal, localStack);
  });
});

test("resolvePorticoLlmApiKey prefers non-malformed environment value", () => {
  withTempManagedRoot((managedRoot) => {
    assert.equal(
      resolvePorticoLlmApiKey({
        env: {
          PORTICO_LLM_API_KEY: "from-env",
          PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
        },
        managedRoot,
        projectRoot: managedRoot,
        resourcesPath: "",
      }),
      "from-env",
    );
  });
});

test("resolvePorticoLlmApiKey reads from installer-managed cloudsmith config", () => {
  withTempManagedRoot((managedRoot) => {
    fs.writeFileSync(
      path.join(managedRoot, "cloudsmith.env"),
      'PORTICO_LLM_API_KEY="sk-portico-cloudsmith"\n',
      "utf8",
    );
    const resolved = resolvePorticoLlmApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });
    assert.equal(resolved, "sk-portico-cloudsmith");
  });
});

test("resolveCloudsmithEntitlementToken reads read-only token from cloudsmith env", () => {
  withTempManagedRoot((managedRoot) => {
    fs.writeFileSync(
      path.join(managedRoot, "cloudsmith.env"),
      'CLOUDSMITH_ENTITLEMENT_TOKEN="cloudsmith-read-token"\n',
      "utf8",
    );
    const resolved = resolveCloudsmithEntitlementToken({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });
    assert.equal(resolved, "cloudsmith-read-token");
  });
});

test("packaged macOS imports a trusted Cloudsmith bootstrap token into Keychain and scrubs only the managed copy", () => {
  withTempManagedRoot((managedRoot) => {
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    const signedResource = path.join(resourcesPath, "cloudsmith.env");
    const managedResource = path.join(managedRoot, "cloudsmith.env");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      signedResource,
      'CLOUDSMITH_ENTITLEMENT_TOKEN="trusted-bootstrap-token"\n',
      "utf8",
    );
    fs.writeFileSync(
      managedResource,
      'CLOUDSMITH_ENTITLEMENT_TOKEN="trusted-bootstrap-token"\n',
      "utf8",
    );

    const keychain = new Map();
    let cacheClearedBeforeReadback = false;
    withMockKeychain(
      {
        clearKeychainCache() {
          cacheClearedBeforeReadback = true;
        },
        readPorticoLlmApiKeyFromKeychainSync({ env }) {
          return keychain.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          keychain.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          return value;
        },
      },
      () => {
        const resolved = resolveCloudsmithEntitlementToken({
          env: {},
          managedRoot,
          projectRoot: managedRoot,
          resourcesPath,
          isPackagedApp: true,
          platform: "darwin",
          throwOnPersistenceFailure: true,
        });
        assert.equal(resolved, "trusted-bootstrap-token");
      },
    );

    assert.equal(
      keychain.get("CLOUDSMITH_ENTITLEMENT_TOKEN"),
      "trusted-bootstrap-token",
    );
    assert.equal(cacheClearedBeforeReadback, true);
    assert.match(
      fs.readFileSync(signedResource, "utf8"),
      /CLOUDSMITH_ENTITLEMENT_TOKEN="trusted-bootstrap-token"/,
    );
    assert.doesNotMatch(
      fs.readFileSync(managedResource, "utf8"),
      /CLOUDSMITH_ENTITLEMENT_TOKEN/,
    );
  });
});

test("packaged macOS securely rotates the Cloudsmith API key before scrubbing the managed copy", () => {
  withTempManagedRoot((managedRoot) => {
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    const signedResource = path.join(resourcesPath, "cloudsmith.env");
    const managedResource = path.join(managedRoot, "cloudsmith.env");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      signedResource,
      'CLOUDSMITH_API_KEY="current-signed-api-key"\n',
      "utf8",
    );
    fs.writeFileSync(
      managedResource,
      [
        'CLOUDSMITH_API_KEY="stale-managed-api-key"',
        'CLOUDSMITH_OWNER="portico"',
        "",
      ].join("\n"),
      "utf8",
    );

    const keychain = new Map([["CLOUDSMITH_API_KEY", "older-api-key"]]);
    let cacheClearCount = 0;
    withMockKeychain(
      {
        clearKeychainCache() {
          cacheClearCount += 1;
        },
        readPorticoLlmApiKeyFromKeychainSync({ env }) {
          return keychain.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          keychain.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          return value;
        },
      },
      () => {
        assert.equal(
          resolveCloudsmithApiKey({
            env: {},
            managedRoot,
            resourcesPath,
            isPackagedApp: true,
            platform: "darwin",
            throwOnPersistenceFailure: true,
          }),
          "current-signed-api-key",
        );
        assert.equal(
          resolveCloudsmithApiKey({
            env: {},
            managedRoot,
            resourcesPath: "",
            isPackagedApp: true,
            platform: "darwin",
            throwOnPersistenceFailure: true,
          }),
          "current-signed-api-key",
          "update discovery must continue from Keychain after plaintext scrubbing",
        );
      },
    );

    assert.equal(keychain.get("CLOUDSMITH_API_KEY"), "current-signed-api-key");
    assert.equal(cacheClearCount, 1);
    assert.match(
      fs.readFileSync(signedResource, "utf8"),
      /CLOUDSMITH_API_KEY="current-signed-api-key"/,
    );
    const managedContents = fs.readFileSync(managedResource, "utf8");
    assert.doesNotMatch(managedContents, /CLOUDSMITH_API_KEY/);
    assert.match(managedContents, /CLOUDSMITH_OWNER="portico"/);
  });
});

test("post-Phase-1 Cloudsmith reconciliation scrubs managed copies already persisted in Keychain", () => {
  withTempManagedRoot((managedRoot) => {
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    const signedResource = path.join(resourcesPath, "cloudsmith.env");
    const managedResource = path.join(managedRoot, "cloudsmith.env");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      signedResource,
      [
        'CLOUDSMITH_API_KEY="signed-api-key"',
        'CLOUDSMITH_ENTITLEMENT_TOKEN="signed-entitlement-token"',
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      managedResource,
      [
        'CLOUDSMITH_API_KEY="signed-api-key"',
        'CLOUDSMITH_ENTITLEMENT_TOKEN="signed-entitlement-token"',
        'CLOUDSMITH_OWNER="portico"',
        "",
      ].join("\n"),
      "utf8",
    );

    const keychain = new Map([
      ["CLOUDSMITH_API_KEY", "signed-api-key"],
      ["CLOUDSMITH_ENTITLEMENT_TOKEN", "signed-entitlement-token"],
    ]);
    let writeCount = 0;
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env }) {
          return keychain.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          writeCount += 1;
          keychain.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          return value;
        },
      },
      () => {
        assert.deepEqual(
          secureCloudsmithBootstrapSecrets({
            env: {},
            managedRoot,
            projectRoot: managedRoot,
            resourcesPath,
            isPackagedApp: true,
            platform: "darwin",
          }),
          {
            apiKeyPersisted: true,
            entitlementTokenPersisted: true,
          },
        );

        assert.equal(
          resolveCloudsmithApiKey({
            env: {},
            managedRoot,
            resourcesPath: "",
            isPackagedApp: true,
            platform: "darwin",
          }),
          "signed-api-key",
          "update discovery must continue from Keychain after Phase 1",
        );
      },
    );

    assert.equal(writeCount, 0, "matching verified Keychain values must not be rewritten");
    assert.match(
      fs.readFileSync(signedResource, "utf8"),
      /CLOUDSMITH_API_KEY="signed-api-key"/,
    );
    const managedContents = fs.readFileSync(managedResource, "utf8");
    assert.doesNotMatch(managedContents, /CLOUDSMITH_API_KEY/);
    assert.doesNotMatch(managedContents, /CLOUDSMITH_ENTITLEMENT_TOKEN/);
    assert.match(managedContents, /CLOUDSMITH_OWNER="portico"/);
  });
});

test("packaged Cloudsmith API key readback failure preserves the managed bootstrap", () => {
  withTempManagedRoot((managedRoot) => {
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    const managedResource = path.join(managedRoot, "cloudsmith.env");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      path.join(resourcesPath, "cloudsmith.env"),
      'CLOUDSMITH_API_KEY="must-not-be-vended"\n',
      "utf8",
    );
    fs.writeFileSync(
      managedResource,
      'CLOUDSMITH_API_KEY="must-remain-recoverable"\n',
      "utf8",
    );

    withMockKeychain(
      {
        clearKeychainCache() {},
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value) {
          return value;
        },
      },
      () => {
        assert.throws(
          () =>
            resolveCloudsmithApiKey({
              env: {},
              managedRoot,
              resourcesPath,
              isPackagedApp: true,
              platform: "darwin",
              throwOnPersistenceFailure: true,
            }),
          /Cloudsmith API key could not be secured.*readback verification failed/,
        );
      },
    );

    assert.match(
      fs.readFileSync(managedResource, "utf8"),
      /CLOUDSMITH_API_KEY="must-remain-recoverable"/,
    );
  });
});

test("packaged Cloudsmith bootstrap readback failure blocks token vending without scrubbing recovery sources", () => {
  withTempManagedRoot((managedRoot) => {
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    const signedResource = path.join(resourcesPath, "cloudsmith.env");
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      signedResource,
      'CLOUDSMITH_ENTITLEMENT_TOKEN="must-not-be-vended"\n',
      "utf8",
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value) {
          return value;
        },
      },
      () => {
        assert.throws(
          () =>
            resolveCloudsmithEntitlementToken({
              env: {},
              managedRoot,
              projectRoot: managedRoot,
              resourcesPath,
              isPackagedApp: true,
              platform: "darwin",
              throwOnPersistenceFailure: true,
            }),
          /Keychain readback verification failed.*Reinstall the signed app or repair Keychain access/,
        );
      },
    );

    assert.match(
      fs.readFileSync(signedResource, "utf8"),
      /CLOUDSMITH_ENTITLEMENT_TOKEN="must-not-be-vended"/,
    );
  });
});

test("packaged Cloudsmith bootstrap never reads a project-root plaintext token", () => {
  withTempManagedRoot((managedRoot) => {
    const projectRoot = path.join(managedRoot, "cloned-project");
    const resourcesPath = path.join(managedRoot, "signed-app-resources");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "cloudsmith.env"),
      'CLOUDSMITH_ENTITLEMENT_TOKEN="untrusted-project-token"\n',
      "utf8",
    );

    let writeCalled = false;
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          writeCalled = true;
          return "untrusted-project-token";
        },
      },
      () => {
        assert.equal(
          resolveCloudsmithEntitlementToken({
            env: {},
            managedRoot,
            projectRoot,
            resourcesPath,
            isPackagedApp: true,
            platform: "darwin",
            throwOnPersistenceFailure: true,
          }),
          "",
        );
      },
    );
    assert.equal(writeCalled, false);
  });
});

test("resolvePorticoLlmApiKey requires explicit runtime configuration", () => {
  withTempManagedRoot((managedRoot) => {
    const resolved = resolvePorticoLlmApiKey({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: path.join(managedRoot, "no-secrets-here"),
      resourcesPath: "",
    });
    assert.equal(resolved, "");
  });
});

test("upsertRuntimeSecret persists PORTICO_LLM_API_KEY in runtime secrets file", () => {
  withTempManagedRoot((managedRoot) => {
    const persisted = upsertRuntimeSecret(
      "PORTICO_LLM_API_KEY",
      "portico-live-token-1234567890abcd",
      {
      managedRoot,
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      },
    );
    assert.equal(persisted, "portico-live-token-1234567890abcd");

    const runtimeSecrets = parseEnvFile(path.join(managedRoot, "runtime-secrets.env"));
    assert.equal(
      runtimeSecrets.PORTICO_LLM_API_KEY,
      "portico-live-token-1234567890abcd",
    );
  });
});

test("stripLegacyPorticoLlmApiKeyFromRuntimeFiles removes leaked key from managed files", () => {
  withTempManagedRoot((managedRoot) => {
    const runtimeSecretsPath = path.join(managedRoot, "runtime-secrets.env");
    fs.writeFileSync(
      runtimeSecretsPath,
      'PORTICO_LLM_API_KEY="sk-portico-legacy"\nLOCAL_STACK_API_KEY="abc"\n',
      "utf8",
    );

    const stripped = stripLegacyPorticoLlmApiKeyFromRuntimeFiles({
      env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });

    assert.deepEqual(stripped, [runtimeSecretsPath]);
    const updated = fs.readFileSync(runtimeSecretsPath, "utf8");
    assert.doesNotMatch(updated, /PORTICO_LLM_API_KEY=/);
    assert.match(updated, /LOCAL_STACK_API_KEY="abc"/);
  });
});

test("upsertRuntimeSecret rejects malformed PORTICO_LLM_API_KEY values", () => {
  withTempManagedRoot((managedRoot) => {
    assert.throws(
      () =>
        upsertRuntimeSecret("PORTICO_LLM_API_KEY", "your-key-here", {
          managedRoot,
          env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
        }),
      /malformed/,
    );
  });
});

test("upsertRuntimeSecret rejects non-runtime secret keys", () => {
  withTempManagedRoot((managedRoot) => {
    assert.throws(
      () =>
        upsertRuntimeSecret("CLOUDSMITH_API_KEY", "dev-only-api-key", {
          managedRoot,
          env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
        }),
      /not allowed/,
    );
  });
});

test("listRuntimeWritableSecretKeys excludes dev-only cloudsmith api key", () => {
  const keys = listRuntimeWritableSecretKeys();
  assert.equal(keys.includes("PORTICO_LLM_API_KEY"), true);
  assert.equal(keys.includes("AI_MARKETPLACE_API_KEY"), true);
  assert.equal(keys.includes("CLOUDSMITH_ENTITLEMENT_TOKEN"), true);
  assert.equal(keys.includes("ULTRA_MULTI_AGENT_SIGNING_SECRET"), true);
  assert.equal(keys.includes("OWUI_AUTH_BRIDGE_SECRET"), true);
  assert.equal(keys.includes("WEBUI_SECRET_KEY"), true);
  assert.equal(keys.includes("CLOUDSMITH_API_KEY"), false);
});

test("resolveAiMarketplaceApiKey persists direct env values via shared keychain path", () => {
  let persistedAccount = null;
  let persistedValue = null;

  withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync: () => "",
      upsertPorticoLlmApiKeyInKeychainSync: (value, { env }) => {
        persistedAccount = env.PORTICO_LLM_KEYCHAIN_ACCOUNT;
        persistedValue = value;
        return value;
      },
      deletePorticoLlmApiKeyFromKeychainSync: () => true,
    },
    () => {
      const resolved = resolveAiMarketplaceApiKey({
        env: {
          AI_MARKETPLACE_API_KEY: "marketplace-env-token",
        },
        managedRoot: os.tmpdir(),
        projectRoot: os.tmpdir(),
        resourcesPath: "",
      });

      assert.equal(resolved, "marketplace-env-token");
      assert.equal(persistedAccount, "AI_MARKETPLACE_API_KEY");
      assert.equal(persistedValue, "marketplace-env-token");
    },
  );
});

test("resolveAiMarketplaceApiKey falls back to the bundled marketplace key", () => {
  let persistedAccount = null;
  let persistedValue = null;

  withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync: () => "",
      upsertPorticoLlmApiKeyInKeychainSync: (value, { env }) => {
        persistedAccount = env.PORTICO_LLM_KEYCHAIN_ACCOUNT;
        persistedValue = value;
        return value;
      },
      deletePorticoLlmApiKeyFromKeychainSync: () => true,
    },
    () => {
      const resolved = resolveAiMarketplaceApiKey({
        env: {},
        managedRoot: os.tmpdir(),
        projectRoot: os.tmpdir(),
        resourcesPath: "",
      });

      assert.equal(typeof resolved, "string");
      assert.notEqual(resolved, "");
      assert.equal(persistedAccount, "AI_MARKETPLACE_API_KEY");
      assert.equal(persistedValue, resolved);
    },
  );
});

test("deleteRuntimeSecret removes AI_MARKETPLACE_API_KEY from shared stores", () => {
  withTempManagedRoot((managedRoot) => {
    fs.writeFileSync(
      path.join(managedRoot, "runtime-secrets.env"),
      'AI_MARKETPLACE_API_KEY="marketplace-managed-token"\n',
      "utf8",
    );

    let deletedAccount = null;
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync: () => "",
        upsertPorticoLlmApiKeyInKeychainSync: (value) => value,
        deletePorticoLlmApiKeyFromKeychainSync: ({ env }) => {
          deletedAccount = env.PORTICO_LLM_KEYCHAIN_ACCOUNT;
          return true;
        },
      },
      () => {
        const deleted = deleteRuntimeSecret("AI_MARKETPLACE_API_KEY", {
          managedRoot,
          env: {},
        });

        assert.equal(deleted, true);
      },
    );

    const runtimeSecrets = parseEnvFile(path.join(managedRoot, "runtime-secrets.env"));
    assert.equal(runtimeSecrets.AI_MARKETPLACE_API_KEY, undefined);
    assert.equal(deletedAccount, "AI_MARKETPLACE_API_KEY");
  });
});

test("discovers sensitive required env vars from MCP YAML metadata", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "sourcegraph",
      [
        "name: Sourcegraph",
        "required_env_vars:",
        "  - name: SOURCEGRAPH_TOKEN",
        "    placeholder: src_...",
        "    description: Sourcegraph bearer",
        "    sensitive: true",
        "  - name: SOURCEGRAPH_ENDPOINT",
        "    sensitive: false",
        "",
      ].join("\n"),
    );

    assert.deepEqual(discoverSensitiveRequiredEnvVars({ projectRoot: managedRoot }), [
      "SOURCEGRAPH_TOKEN",
    ]);
    assert.equal(dockerSecretNameForEnvVar("SOURCEGRAPH_TOKEN"), "sourcegraph_token");

    const envFileKeys = runtimeSecretEnvFileKeys({ projectRoot: managedRoot });
    assert.equal(envFileKeys.includes("SOURCEGRAPH_TOKEN"), true);
    assert.equal(envFileKeys.includes("SOURCEGRAPH_TOKEN_FILE"), true);

    const writableKeys = listRuntimeWritableSecretKeys({ projectRoot: managedRoot });
    assert.equal(writableKeys.includes("SOURCEGRAPH_TOKEN"), true);
    assert.equal(writableKeys.includes("SOURCEGRAPH_ENDPOINT"), false);
  });
});

test("dynamic sensitive registry fails on conflicting sensitivity", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "gitlab-mcp",
      [
        "name: GitLab",
        "required_env_vars:",
        "  - name: SHARED_TOKEN",
        "    sensitive: true",
        "",
      ].join("\n"),
    );
    writeMcpServerYaml(
      managedRoot,
      "other",
      [
        "name: Other",
        "required_env_vars:",
        "  - name: SHARED_TOKEN",
        "    sensitive: false",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => discoverSensitiveRequiredEnvVars({ projectRoot: managedRoot }),
      /sensitivity conflict for SHARED_TOKEN/,
    );
  });
});

test("discovers and imports sensitive runtime files from MCP YAML metadata", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    const sourceBytes = Buffer.from([0x00, 0x01, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0xff]);
    fs.writeFileSync(sourcePath, sourceBytes);
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const persisted = [];
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          persisted.push({
            account: env.PORTICO_LLM_KEYCHAIN_ACCOUNT,
            value,
          });
          return value;
        },
      },
      () => {
        const discovered = discoverSensitiveRuntimeFiles({ projectRoot: managedRoot });
        assert.equal(discovered.length, 1);
        assert.equal(discovered[0].serverId, "snowflake");
        assert.equal(discovered[0].sourcePath, sourcePath);
        assert.equal(discovered[0].target, "/root/.snowflake/connections.toml");

        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].importedFromSource, true);
        assert.equal(imported[0].sourceScrubbed, false);
        assert.match(
          sensitiveRuntimeFileSecretEnvVar(imported[0].secretName),
          /^PORTICO_RUNTIME_FILE_SNOWFLAKE_CONNECTIONS_TOML_[A-F0-9]{12}_FILE$/,
        );
      },
    );

    assert.deepEqual(persisted, [
      {
        account: sensitiveRuntimeFileKeychainAccount(
          "snowflake",
          "/root/.snowflake/connections.toml",
        ),
        value: sourceBytes.toString("base64"),
      },
    ]);
    const cachePath = sensitiveRuntimeFileCachePath(
      "snowflake",
      "/root/.snowflake/connections.toml",
      { env },
    );
    assert.equal(
      fs.existsSync(cachePath),
      false,
      "sensitive runtime files must not be materialized into a durable host cache",
    );
    assert.equal(
      fs.existsSync(path.join(managedRoot, "runtime-secrets.env")),
      false,
      "sensitive runtime files must not create plaintext managed mirrors",
    );
    assert.equal(
      fs.readFileSync(sourcePath).equals(sourceBytes),
      true,
      "the user-owned source file must stay untouched after secure import",
    );
  });
});

test("legacy sensitive runtime file stubs are restored from secure storage once per session", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env }) {
          return env.PORTICO_LLM_KEYCHAIN_ACCOUNT ===
            sensitiveRuntimeFileKeychainAccount(
              "snowflake",
              "/root/.snowflake/connections.toml",
            )
            ? Buffer.from("persisted-token").toString("base64")
            : "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("stub restoration must not rewrite secure storage");
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].importedFromSource, false);
        assert.equal(imported[0].sourceScrubbed, false);
        assert.equal(fs.readFileSync(sourcePath, "utf8"), "persisted-token");
        assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o600);

        // The restored (unchanged) file must not re-persist on later resolves.
        const second = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(second.length, 1);
        assert.equal(second[0].available, true);
        assert.equal(fs.readFileSync(sourcePath, "utf8"), "persisted-token");

        // A stub reappearing later in the same session is not restored again,
        // but secure-storage provisioning stays available.
        fs.writeFileSync(sourcePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");
        const third = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(third.length, 1);
        assert.equal(third[0].available, true);
        assert.equal(third[0].sourceScrubbed, true);
        assert.equal(fs.readFileSync(sourcePath, "utf8"), SENSITIVE_RUNTIME_FILE_STUB);
      },
    );
    const cachePath = sensitiveRuntimeFileCachePath(
      "snowflake",
      "/root/.snowflake/connections.toml",
      { env },
    );
    assert.equal(
      fs.existsSync(cachePath),
      false,
      "persisted sensitive runtime files must remain in secure storage until container materialization",
    );
  });
});

test("buildRuntimeSecretEnv exports secure runtime-file availability without plaintext ingress", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_LLM_API_KEY: "portico-live-token-1234567890abcd",
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "connections.toml"),
      SENSITIVE_RUNTIME_FILE_STUB,
      "utf8",
    );
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const target = "/root/.snowflake/connections.toml";
    const account = sensitiveRuntimeFileKeychainAccount("snowflake", target);
    const keychain = new Map([
      [account, Buffer.from("persisted-token").toString("base64")],
    ]);
    const secretName = sensitiveRuntimeFileSecretName("snowflake", target);
    const availabilityKey = staticSecretAvailabilityEnvVar(
      "snowflake",
      secretName,
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env: keychainEnv }) {
          return keychain.get(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env: keychainEnv }) {
          keychain.set(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          return value;
        },
      },
      () => {
        const configured = buildRuntimeSecretEnv({
          env,
          managedRoot,
          projectRoot: managedRoot,
          resourcesPath: "",
        });
        assert.equal(configured[availabilityKey], "1");
        assert.equal(
          configured[sensitiveRuntimeFileSecretEnvVar(secretName)],
          undefined,
        );

        // Recreate the legacy-stub state (the first pass restored the source
        // from secure storage) with the Keychain now empty: inherited
        // availability must fail closed.
        fs.writeFileSync(
          path.join(runtimeDir, "connections.toml"),
          SENSITIVE_RUNTIME_FILE_STUB,
          "utf8",
        );
        keychain.delete(account);
        resetSensitiveRuntimeFileImportSessionStateForTests();
        const missing = buildRuntimeSecretEnv({
          env: {
            ...env,
            [availabilityKey]: "1",
          },
          managedRoot,
          projectRoot: managedRoot,
          resourcesPath: "",
        });
        assert.equal(
          missing[availabilityKey],
          "",
          "unverified inherited availability must fail closed",
        );
      },
    );
  });
});

test("sensitive runtime file stubs without secure storage are not configured", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "connections.toml"),
      SENSITIVE_RUNTIME_FILE_STUB,
      "utf8",
    );
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("stub-only runtime file must not be persisted");
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env: {
            PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
            PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "empty-cache"),
          },
          projectRoot: managedRoot,
        });
        assert.deepEqual(imported, []);
        assert.equal(
          fs.readFileSync(path.join(runtimeDir, "connections.toml"), "utf8"),
          SENSITIVE_RUNTIME_FILE_STUB,
          "a stub must stay untouched when secure storage has nothing to restore",
        );
      },
    );
  });
});

test("changed sensitive runtime file source content rotates the persisted value without touching the source", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, 'token = "new-token"\n', "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const persisted = [];
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return Buffer.from("old-token").toString("base64");
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          persisted.push({ account: env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value });
          return value;
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].importedFromSource, true);
        assert.equal(imported[0].sourceScrubbed, false);
      },
    );

    assert.deepEqual(persisted, [
      {
        account: sensitiveRuntimeFileKeychainAccount(
          "snowflake",
          "/root/.snowflake/connections.toml",
        ),
        value: Buffer.from('token = "new-token"\n').toString("base64"),
      },
    ]);
    const cachePath = sensitiveRuntimeFileCachePath(
      "snowflake",
      "/root/.snowflake/connections.toml",
      { env },
    );
    assert.equal(
      fs.existsSync(cachePath),
      false,
      "rotated sensitive runtime files must not be written to the host cache",
    );
    assert.equal(fs.readFileSync(sourcePath, "utf8"), 'token = "new-token"\n');
  });
});

test("unchanged sensitive runtime file sources persist to secure storage once per session", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, 'token = "stable-token"\n', "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const keychain = new Map();
    const persisted = [];
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env: keychainEnv }) {
          return keychain.get(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env: keychainEnv }) {
          keychain.set(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          persisted.push(value);
          return value;
        },
      },
      () => {
        for (let round = 0; round < 3; round += 1) {
          const imported = resolveMcpSensitiveRuntimeFileSecrets({
            env,
            projectRoot: managedRoot,
          });
          assert.equal(imported.length, 1);
          assert.equal(imported[0].available, true);
        }
        assert.equal(
          persisted.length,
          1,
          "recurring resolves of an unchanged source must not rewrite secure storage",
        );

        fs.writeFileSync(sourcePath, 'token = "rotated-token"\n', "utf8");
        const rotated = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(rotated.length, 1);
        assert.equal(rotated[0].importedFromSource, true);
        assert.equal(persisted.length, 2);
        assert.equal(
          Buffer.from(persisted[1], "base64").toString("utf8"),
          'token = "rotated-token"\n',
        );
        assert.equal(fs.readFileSync(sourcePath, "utf8"), 'token = "rotated-token"\n');
      },
    );
  });
});

test("sensitive runtime file import re-persists when secure storage is wiped mid-session", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, 'token = "stable-token"\n', "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const keychain = new Map();
    const persisted = [];
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env: keychainEnv }) {
          return keychain.get(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env: keychainEnv }) {
          keychain.set(keychainEnv.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          persisted.push(value);
          return value;
        },
      },
      () => {
        resolveMcpSensitiveRuntimeFileSecrets({ env, projectRoot: managedRoot });
        assert.equal(persisted.length, 1);

        keychain.clear();
        const healed = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(healed.length, 1);
        assert.equal(healed[0].available, true);
        assert.equal(
          persisted.length,
          2,
          "a vanished Keychain entry must be re-imported from the source file",
        );
        assert.equal(persisted[0], persisted[1]);
      },
    );
  });
});

test("stubs carrying user content below the marker are never rewritten", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    const bypassContent = `${SENSITIVE_RUNTIME_FILE_STUB}[cortex]\ntoken = "bypass"\n`;
    fs.writeFileSync(sourcePath, bypassContent, "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return Buffer.from("persisted-token").toString("base64");
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("stub-headed files must not be re-persisted");
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].available, true);
        assert.equal(imported[0].importedFromSource, false);
        assert.equal(imported[0].sourceScrubbed, true);
        assert.equal(fs.readFileSync(sourcePath, "utf8"), bypassContent);
      },
    );

    resetSensitiveRuntimeFileImportSessionStateForTests();
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("stub-headed files must not be re-persisted");
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.deepEqual(imported, []);
        assert.equal(fs.readFileSync(sourcePath, "utf8"), bypassContent);
      },
    );
  });
});

test("a failed stub restore keeps secure-storage provisioning available", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("directory write permissions are not enforced for root");
    return;
  }
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    fs.chmodSync(runtimeDir, 0o500);
    try {
      withMockKeychain(
        {
          readPorticoLlmApiKeyFromKeychainSync() {
            return Buffer.from("persisted-token").toString("base64");
          },
          upsertPorticoLlmApiKeyInKeychainSync() {
            throw new Error("a failed restore must not rewrite secure storage");
          },
        },
        () => {
          const imported = resolveMcpSensitiveRuntimeFileSecrets({
            env,
            projectRoot: managedRoot,
          });
          assert.equal(imported.length, 1);
          assert.equal(imported[0].available, true);
          assert.equal(imported[0].sourceScrubbed, true);
        },
      );
    } finally {
      fs.chmodSync(runtimeDir, 0o700);
    }
    assert.equal(fs.readFileSync(sourcePath, "utf8"), SENSITIVE_RUNTIME_FILE_STUB);
  });
});

test("sensitive runtime files can be configured from persisted secure storage when source is absent", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/missing-connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env }) {
          return env.PORTICO_LLM_KEYCHAIN_ACCOUNT ===
            sensitiveRuntimeFileKeychainAccount(
              "snowflake",
              "/root/.snowflake/connections.toml",
            )
            ? Buffer.from("persisted-token").toString("base64")
            : "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("source-absent runtime files must not be re-persisted");
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].importedFromSource, false);
        assert.equal(imported[0].target, "/root/.snowflake/connections.toml");
      },
    );
    const cachePath = sensitiveRuntimeFileCachePath(
      "snowflake",
      "/root/.snowflake/connections.toml",
      { env },
    );
    assert.equal(
      fs.existsSync(cachePath),
      false,
      "source-absent sensitive runtime files must not be written to the host cache",
    );
  });
});

test("sensitive runtime files reject legacy runtime-secret cache files", () => {
  withTempManagedRoot((managedRoot) => {
    const cacheDir = path.join(managedRoot, "cache", "runtime-secrets");
    const env = {
      PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      PORTICO_RUNTIME_SECRET_CACHE_DIR: cacheDir,
    };
    const target = "/root/.snowflake/connections.toml";
    const cachePath = sensitiveRuntimeFileCachePath("snowflake", target, {
      env,
      homeDir: managedRoot,
      platform: "darwin",
    });
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, 'token = "cached"\n', "utf8");

    assert.equal(
      isSensitiveRuntimeFilePersisted({
        serverId: "snowflake",
        target,
        env,
        homeDir: managedRoot,
        platform: "darwin",
      }),
      false,
      "host-cache sensitive runtime files must not count as persisted secure storage after broker migration",
    );

    fs.writeFileSync(cachePath, SENSITIVE_RUNTIME_FILE_STUB, "utf8");
    assert.equal(
      isSensitiveRuntimeFilePersisted({
        serverId: "snowflake",
        target,
        env,
        homeDir: managedRoot,
        platform: "darwin",
      }),
      false,
      "scrubbed source stubs must not count as persisted secure cache content",
    );

    fs.writeFileSync(cachePath, "", "utf8");
    assert.equal(
      isSensitiveRuntimeFilePersisted({
        serverId: "snowflake",
        target,
        env,
        homeDir: managedRoot,
        platform: "darwin",
      }),
      false,
    );
  });
});

test("sensitive runtime files reject non-boolean sensitive flags", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: yes",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => discoverSensitiveRuntimeFiles({ projectRoot: managedRoot }),
      /runtime_files sensitive must be true or false/,
    );
  });
});

test("upsertRuntimeSecret refuses plaintext fallback for sensitive MCP env vars", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "n8n",
      [
        "name: N8N",
        "required_env_vars:",
        "  - name: N8N_API_KEY",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    assert.throws(
      () =>
        upsertRuntimeSecret("N8N_API_KEY", "n8n-secret", {
          managedRoot,
          projectRoot: managedRoot,
          env: { PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1" },
        }),
      /Keychain persistence is required for sensitive MCP env var N8N_API_KEY/,
    );

    assert.equal(
      fs.existsSync(path.join(managedRoot, "runtime-secrets.env")),
      false,
      "sensitive MCP env vars must not be written to plaintext runtime secret mirrors",
    );
  });
});

test("upsertRuntimeSecret verifies sensitive MCP Keychain replacements", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "trust-kit-mcp",
      [
        "name: Trust Kit",
        "required_env_vars:",
        "  - name: waldoapikey",
        "    sensitive: true",
        "",
      ].join("\n"),
    );
    const stored = new Map();

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync({ env = {} } = {}) {
          return stored.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env = {} } = {}) {
          stored.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
          return value;
        },
      },
      () => {
        assert.equal(
          upsertRuntimeSecret("waldoapikey", "replacement-key", {
            managedRoot,
            projectRoot: managedRoot,
            env: {},
          }),
          "replacement-key",
        );
      },
    );

    assert.equal(stored.get("waldoapikey"), "replacement-key");
    assert.equal(
      fs.existsSync(path.join(managedRoot, "runtime-secrets.env")),
      false,
    );
  });
});

test("resolveMcpSensitiveEnvSecrets migrates direct env sensitive required vars and scrubs mirrors", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "matrix",
      [
        "name: Matrix",
        "required_env_vars:",
        "  - name: MATRIX_SECRET_TOKEN",
        "    sensitive: true",
        "  - name: MATRIX_PUBLIC_MODE",
        "    sensitive: false",
        "",
      ].join("\n"),
    );

    const runtimeSecretsPath = path.join(managedRoot, "runtime-secrets.env");
    const envPath = path.join(managedRoot, ".env");
    const envRuntimePath = path.join(managedRoot, ".env.runtime");
    const content = [
      "MATRIX_SECRET_TOKEN=plaintext-secret",
      "MATRIX_SECRET_TOKEN_FILE=/tmp/plaintext-secret",
      "MATRIX_PUBLIC_MODE=read-only",
      "",
    ].join("\n");
    fs.writeFileSync(runtimeSecretsPath, content, "utf8");
    fs.writeFileSync(envPath, content, "utf8");
    fs.writeFileSync(envRuntimePath, content, "utf8");

    const keychain = require("../services/llm-keychain");
    const originalRead = keychain.readPorticoLlmApiKeyFromKeychainSync;
    const originalUpsert = keychain.upsertPorticoLlmApiKeyInKeychainSync;
    const persisted = [];
    const stored = new Map();
    keychain.readPorticoLlmApiKeyFromKeychainSync = ({ env = {} } = {}) =>
      stored.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
    keychain.upsertPorticoLlmApiKeyInKeychainSync = (value, { env = {} } = {}) => {
      persisted.push({
        account: env.PORTICO_LLM_KEYCHAIN_ACCOUNT,
        value,
      });
      stored.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
      return value;
    };

    try {
      const resolved = resolveMcpSensitiveEnvSecrets({
        env: { MATRIX_SECRET_TOKEN: "direct-secret" },
        managedRoot,
        projectRoot: managedRoot,
        resourcesPath: "",
      });

      assert.deepEqual(resolved, {
        MATRIX_SECRET_TOKEN: "direct-secret",
      });
      assert.deepEqual(persisted, [
        {
          account: "MATRIX_SECRET_TOKEN",
          value: "direct-secret",
        },
      ]);
      for (const filePath of [runtimeSecretsPath, envPath, envRuntimePath]) {
        const updated = fs.readFileSync(filePath, "utf8");
        assert.doesNotMatch(updated, /MATRIX_SECRET_TOKEN=/);
        assert.doesNotMatch(updated, /MATRIX_SECRET_TOKEN_FILE=/);
        assert.match(updated, /MATRIX_PUBLIC_MODE=read-only/);
      }
    } finally {
      keychain.readPorticoLlmApiKeyFromKeychainSync = originalRead;
      keychain.upsertPorticoLlmApiKeyInKeychainSync = originalUpsert;
    }
  });
});

test("resolveMcpSensitiveEnvSecrets imports beta-style plaintext once and survives restart from Keychain", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "trust-kit-mcp",
      [
        "name: Trust Kit",
        "required_env_vars:",
        "  - name: waldoapikey",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const runtimeSecretsPath = path.join(managedRoot, "runtime-secrets.env");
    const envPath = path.join(managedRoot, ".env");
    const envRuntimePath = path.join(managedRoot, ".env.runtime");
    const content = [
      "waldoapikey=beta-waldo-secret",
      "waldoapikey_FILE=/tmp/plaintext-secret",
      "MATRIX_PUBLIC_MODE=read-only",
      "",
    ].join("\n");
    fs.writeFileSync(runtimeSecretsPath, content, "utf8");
    fs.writeFileSync(envPath, content, "utf8");
    fs.writeFileSync(envRuntimePath, content, "utf8");

    const keychain = require("../services/llm-keychain");
    const originalRead = keychain.readPorticoLlmApiKeyFromKeychainSync;
    const originalUpsert = keychain.upsertPorticoLlmApiKeyInKeychainSync;
    const persisted = [];
    const stored = new Map();
    keychain.readPorticoLlmApiKeyFromKeychainSync = ({ env = {} } = {}) =>
      stored.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
    keychain.upsertPorticoLlmApiKeyInKeychainSync = (value, { env = {} } = {}) => {
      persisted.push({
        account: env.PORTICO_LLM_KEYCHAIN_ACCOUNT,
        value,
      });
      stored.set(env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value);
      return value;
    };

    try {
      const resolved = resolveMcpSensitiveEnvSecrets({
        env: {},
        managedRoot,
        projectRoot: managedRoot,
        resourcesPath: "",
      });

      assert.deepEqual(resolved, { waldoapikey: "beta-waldo-secret" });
      assert.deepEqual(persisted, [
        {
          account: "waldoapikey",
          value: "beta-waldo-secret",
        },
      ]);
      for (const filePath of [runtimeSecretsPath, envPath, envRuntimePath]) {
        const updated = fs.readFileSync(filePath, "utf8");
        assert.doesNotMatch(updated, /waldoapikey=/);
        assert.doesNotMatch(updated, /waldoapikey_FILE=/);
        assert.match(updated, /MATRIX_PUBLIC_MODE=read-only/);
      }
      const markerPath = path.join(
        managedRoot,
        "open-webui-data",
        "runtime-migrations",
        "mcp-sensitive-env-keychain-v1",
      );
      assert.equal(fs.existsSync(markerPath), true);

      const presence = getMcpSensitiveSecretPresence("trust-kit-mcp", {
        env: {},
        managedRoot,
        projectRoot: managedRoot,
        resourcesPath: "",
      });
      assert.deepEqual(presence, { waldoapikey: true });
      assert.equal(persisted.length, 1, "restart must reuse the Keychain record");
    } finally {
      keychain.readPorticoLlmApiKeyFromKeychainSync = originalRead;
      keychain.upsertPorticoLlmApiKeyInKeychainSync = originalUpsert;
    }
  });
});

test("sensitive MCP env migration preserves plaintext when Keychain readback fails", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "trust-kit-mcp",
      [
        "name: Trust Kit",
        "required_env_vars:",
        "  - name: waldoapikey",
        "    sensitive: true",
        "",
      ].join("\n"),
    );
    const envPath = path.join(managedRoot, ".env");
    fs.writeFileSync(envPath, "waldoapikey=must-remain\n", "utf8");

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value) {
          return value;
        },
      },
      () => {
        assert.throws(
          () =>
            resolveMcpSensitiveEnvSecrets({
              env: {},
              managedRoot,
              projectRoot: managedRoot,
              resourcesPath: "",
            }),
          /Keychain readback verification failed/,
        );
      },
    );

    assert.match(fs.readFileSync(envPath, "utf8"), /waldoapikey=must-remain/);
    assert.equal(
      fs.existsSync(
        path.join(
          managedRoot,
          "open-webui-data",
          "runtime-migrations",
          "mcp-sensitive-env-keychain-v1",
        ),
      ),
      false,
    );
  });
});

test("missing sensitive MCP Keychain and legacy source fail closed", () => {
  withTempManagedRoot((managedRoot) => {
    writeMcpServerYaml(
      managedRoot,
      "trust-kit-mcp",
      [
        "name: Trust Kit",
        "required_env_vars:",
        "  - name: waldoapikey",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync() {
          throw new Error("no write expected");
        },
      },
      () => {
        assert.deepEqual(
          getMcpSensitiveSecretPresence("trust-kit-mcp", {
            env: {},
            managedRoot,
            projectRoot: managedRoot,
            resourcesPath: "",
          }),
          { waldoapikey: false },
        );
        const runtimeEnv = buildRuntimeSecretEnv({
          env: { PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK: "1" },
          managedRoot,
          projectRoot: managedRoot,
          resourcesPath: "",
          platform: "linux",
        });
        assert.equal(
          runtimeEnv.PORTICO_STATIC_SECRET_AVAILABLE_TRUST_KIT_MCP_WALDOAPIKEY,
          "",
        );
        assert.equal(Object.hasOwn(runtimeEnv, "waldoapikey"), false);
      },
    );
  });
});

test("isMalformedPorticoLlmApiKey rejects placeholders and JWT-like values", () => {
  assert.equal(isMalformedPorticoLlmApiKey(""), true);
  assert.equal(isMalformedPorticoLlmApiKey("your-key-here"), true);
  assert.equal(isMalformedPorticoLlmApiKey("sk-portico-0001"), true);
  assert.equal(
    isMalformedPorticoLlmApiKey("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature"),
    true,
  );
  assert.equal(
    isMalformedPorticoLlmApiKey("portico-live-token-1234567890abcd"),
    false,
  );
});


test("Ultra signing secret validation rejects weak and shared secrets", () => {
  const secret = `ultra-sign-v1-${"a".repeat(64)}`;
  assert.equal(
    validateUltraMultiAgentSigningSecret(secret, {
      localStackApiKey: "local",
      bifrostLocalApiKey: "bifrost",
      owuiAuthBridgeSecret: "owui",
      webuiSecretKey: "webui",
      upstreamKey: "upstream",
    }),
    secret,
  );
  assert.throws(
    () => validateUltraMultiAgentSigningSecret("ultra-sign-v1-short"),
    /strong ultra-sign-v1 format/,
  );
  for (const peerName of [
    "localStackApiKey",
    "bifrostLocalApiKey",
    "owuiAuthBridgeSecret",
    "webuiSecretKey",
    "upstreamKey",
  ]) {
    assert.throws(
      () => validateUltraMultiAgentSigningSecret(secret, { [peerName]: secret }),
      /must be distinct/,
    );
  }
});

test("buildRuntimeSecretEnv fails closed on a shared Ultra signing secret", () => {
  withTempManagedRoot((managedRoot) => {
    const secret = `ultra-sign-v1-${"b".repeat(64)}`;
    assert.throws(
      () =>
        buildRuntimeSecretEnv({
          env: {
            ULTRA_MULTI_AGENT_SIGNING_SECRET: secret,
            OWUI_AUTH_BRIDGE_SECRET: secret,
            PORTICO_LLM_API_KEY: "portico-live-token-1234567890abcd",
            CLOUDSMITH_ENTITLEMENT_TOKEN: "cloudsmith-read-token-1234",
            PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
          },
          managedRoot,
          projectRoot: managedRoot,
          resourcesPath: "",
        }),
      /must be distinct/,
    );
  });
});
test("buildRuntimeSecretEnv fans the local stack key into dependent variables", () => {
  withTempManagedRoot((managedRoot) => {
    const runtimeEnv = buildRuntimeSecretEnv({
      env: {
        PORTICO_LLM_API_KEY: "portico-live-token-1234567890abcd",
        CLOUDSMITH_ENTITLEMENT_TOKEN: "cloudsmith-read-token-1234",
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
      },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
    });

    assert.equal(runtimeEnv.LOCAL_STACK_API_KEY, runtimeEnv.OPENAI_API_KEY);
    assert.equal(runtimeEnv.LOCAL_STACK_API_KEY, runtimeEnv.INTERNAL_OPENAI_API_KEY);
    assert.match(
      runtimeEnv.BIFROST_BRIDGE_LOCAL_API_KEY,
      /^sk-bifrost-local-/,
    );
    assert.notEqual(
      runtimeEnv.BIFROST_BRIDGE_LOCAL_API_KEY,
      runtimeEnv.LOCAL_STACK_API_KEY,
    );
    assert.match(
      runtimeEnv.ULTRA_MULTI_AGENT_SIGNING_SECRET,
      /^ultra-sign-v1-/,
    );
    assert.notEqual(runtimeEnv.ULTRA_MULTI_AGENT_SIGNING_SECRET, runtimeEnv.BIFROST_BRIDGE_LOCAL_API_KEY);
    assert.notEqual(runtimeEnv.ULTRA_MULTI_AGENT_SIGNING_SECRET, runtimeEnv.WEBUI_SECRET_KEY);
    assert.match(runtimeEnv.OWUI_AUTH_BRIDGE_SECRET, /^owui-bridge-/);
    assert.match(runtimeEnv.WEBUI_SECRET_KEY, /^[A-Za-z0-9_-]{48,}$/);
    assert.notEqual(runtimeEnv.OWUI_AUTH_BRIDGE_SECRET, runtimeEnv.WEBUI_SECRET_KEY);
    assert.equal(runtimeEnv.PORTICO_LLM_API_KEY, "portico-live-token-1234567890abcd");
    assert.equal(
      runtimeEnv.CLOUDSMITH_ENTITLEMENT_TOKEN,
      "cloudsmith-read-token-1234",
    );
  });
});

test("clearLegacySlackOAuthArtifacts removes old Slack token and client files once", () => {
  withTempManagedRoot((managedRoot) => {
    const tokensDir = path.join(
      managedRoot,
      "mcpo-oauth-tokens",
      "slack",
      "tokens",
    );
    const coreTokensDir = path.join(
      managedRoot,
      "mcpo-core-oauth-tokens",
      "slack",
      "tokens",
    );
    const coreRootDir = path.join(managedRoot, "mcpo-core-oauth-tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.mkdirSync(coreTokensDir, { recursive: true });
    const tokenFile = path.join(tokensDir, "slack_tokens.json");
    const clientFile = path.join(tokensDir, "slack_client.json");
    const coreClientFile = path.join(coreTokensDir, "slack_client.json");
    const unrelatedFile = path.join(tokensDir, "notes.txt");
    fs.writeFileSync(tokenFile, '{"access_token":"old"}\n');
    fs.writeFileSync(clientFile, '{"client_secret":"old"}\n');
    fs.writeFileSync(coreClientFile, '{"client_secret":"old-core"}\n');
    fs.writeFileSync(unrelatedFile, "keep\n");

    const cleared = clearLegacySlackOAuthArtifacts({ projectRoot: managedRoot });

    assert.equal(cleared.cleared, true);
    assert.equal(fs.existsSync(tokenFile), false);
    assert.equal(fs.existsSync(clientFile), false);
    assert.equal(fs.existsSync(coreClientFile), false);
    assert.equal(fs.existsSync(unrelatedFile), true);
    assert.equal(fs.existsSync(coreTokensDir), false);
    assert.equal(fs.existsSync(coreRootDir), false);
    assert.equal(fs.existsSync(cleared.markerPath), true);

    fs.writeFileSync(tokenFile, '{"access_token":"new"}\n');
    const second = clearLegacySlackOAuthArtifacts({ projectRoot: managedRoot });

    assert.equal(second.reason, "already_migrated");
    assert.equal(fs.existsSync(tokenFile), true);
  });
});

test("clearLegacySlackOAuthArtifacts prunes empty roots after prior migration", () => {
  withTempManagedRoot((managedRoot) => {
    const markerPath = path.join(
      managedRoot,
      "open-webui-data",
      "runtime-migrations",
      "slack-pkce-public-client-artifacts-cleared-v2",
    );
    const tokensDir = path.join(
      managedRoot,
      "mcpo-oauth-tokens",
      "slack",
      "tokens",
    );
    const coreTokensDir = path.join(
      managedRoot,
      "mcpo-core-oauth-tokens",
      "slack",
      "tokens",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}\n");
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.mkdirSync(coreTokensDir, { recursive: true });

    const result = clearLegacySlackOAuthArtifacts({ projectRoot: managedRoot });

    assert.equal(result.reason, "already_migrated");
    assert.equal(fs.existsSync(tokensDir), false);
    assert.equal(fs.existsSync(coreTokensDir), false);
    assert.equal(fs.existsSync(path.join(managedRoot, "mcpo-oauth-tokens")), false);
    assert.equal(fs.existsSync(path.join(managedRoot, "mcpo-core-oauth-tokens")), false);
  });
});

test("cleanupLegacyBundledSlackKeychainCredentials deletes bundled-owned legacy Slack entries", () => {
  const keychain = new Map([
    [
      "SLACK_OAUTH_CREDENTIALS_METADATA",
      JSON.stringify({ schema_version: 1, owner: "bundled" }),
    ],
    ["SLACK_OAUTH_CLIENT_ID", "legacy-client-id"],
    ["SLACK_OAUTH_CLIENT_SECRET", "legacy-client-secret"],
  ]);
  const deleted = [];

  withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync({ env }) {
        return keychain.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
      },
      deletePorticoLlmApiKeyFromKeychainSync({ env }) {
        const account = env.PORTICO_LLM_KEYCHAIN_ACCOUNT;
        deleted.push(account);
        keychain.delete(account);
        return true;
      },
    },
    () => {
      const result = cleanupLegacyBundledSlackKeychainCredentials({
        env: {},
      });
      assert.equal(result.deleted, true);
      assert.equal(result.deletedCount, 3);
    },
  );

  assert.deepEqual(deleted.sort(), [
    "SLACK_OAUTH_CLIENT_ID",
    "SLACK_OAUTH_CLIENT_SECRET",
    "SLACK_OAUTH_CREDENTIALS_METADATA",
  ].sort());
  assert.equal(keychain.has("SLACK_OAUTH_CLIENT_ID"), false);
  assert.equal(keychain.has("SLACK_OAUTH_CLIENT_SECRET"), false);
  assert.equal(keychain.has("SLACK_OAUTH_CREDENTIALS_METADATA"), false);
});

test("cleanupLegacyBundledSlackKeychainCredentials preserves manual legacy Slack entries", () => {
  const keychain = new Map([
    [
      "SLACK_OAUTH_CREDENTIALS_METADATA",
      JSON.stringify({ schema_version: 1, owner: "manual" }),
    ],
    ["SLACK_OAUTH_CLIENT_ID", "manual-client-id"],
    ["SLACK_OAUTH_CLIENT_SECRET", "manual-client-secret"],
  ]);
  let deleteCalled = false;

  withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync({ env }) {
        return keychain.get(env.PORTICO_LLM_KEYCHAIN_ACCOUNT) || "";
      },
      deletePorticoLlmApiKeyFromKeychainSync() {
        deleteCalled = true;
        return true;
      },
    },
    () => {
      const result = cleanupLegacyBundledSlackKeychainCredentials({
        env: {},
      });
      assert.equal(result.deleted, false);
      assert.equal(result.reason, "not_bundled");
    },
  );

  assert.equal(deleteCalled, false);
  assert.equal(keychain.get("SLACK_OAUTH_CLIENT_ID"), "manual-client-id");
  assert.equal(keychain.get("SLACK_OAUTH_CLIENT_SECRET"), "manual-client-secret");
});

test("buildRuntimeSecretEnv does not export deprecated Slack OAuth client secrets", () => {
  withTempManagedRoot((managedRoot) => {
    const runtimeSecretsPath = path.join(managedRoot, "runtime-secrets.env");
    fs.writeFileSync(
      runtimeSecretsPath,
      [
        "SLACK_OAUTH_CLIENT_ID=legacy-cid",
        "SLACK_OAUTH_CLIENT_SECRET=legacy-secret",
        "SLACK_OAUTH_CLIENT_ID_FILE=/tmp/legacy-id",
        "SLACK_OAUTH_CLIENT_SECRET_FILE=/tmp/legacy-secret",
        "",
      ].join("\n"),
    );

    const runtimeSecrets = buildRuntimeSecretEnv({
      env: {
        PORTICO_RUNTIME_DISABLE_KEYCHAIN: "1",
        SLACK_OAUTH_CLIENT_ID: "legacy-cid",
        SLACK_OAUTH_CLIENT_SECRET: "legacy-secret",
      },
      managedRoot,
      projectRoot: managedRoot,
      resourcesPath: "",
      isPackagedApp: false,
      platform: "linux",
    });

    assert.equal(runtimeSecrets.SLACK_OAUTH_CLIENT_ID, undefined);
    assert.equal(runtimeSecrets.SLACK_OAUTH_CLIENT_SECRET, undefined);
    const updated = fs.readFileSync(runtimeSecretsPath, "utf8");
    assert.doesNotMatch(updated, /SLACK_OAUTH_CLIENT_ID=/);
    assert.doesNotMatch(updated, /SLACK_OAUTH_CLIENT_SECRET=/);
    assert.doesNotMatch(updated, /SLACK_OAUTH_CLIENT_ID_FILE=/);
    assert.doesNotMatch(updated, /SLACK_OAUTH_CLIENT_SECRET_FILE=/);
  });
});

// ---------------------------------------------------------------------------
// Round-8 legacy Snowflake connection migration: files generated before the
// token-key fix store the PAT under `password` while naming the PAT
// authenticator — a shape the connector cannot sign in with. The migration
// renames the key inside secure storage so the stored token starts working.
const {
  readSensitiveRuntimeFilePersistedBytes,
  migrateLegacySnowflakeRuntimeFileBytes,
} = require("./runtime-secrets-config");

const LEGACY_SNOWFLAKE_TOML = [
  "# Generated by Portico Snowflake Setup.",
  "# Do not share this file. It contains a Snowflake programmatic access token.",
  "",
  "[default]",
  'account = "PORTICOORG-PORTICO"',
  'user = "dsantiago"',
  'authenticator = "PROGRAMMATIC_ACCESS_TOKEN"',
  'password = "PAT_VALUE_NEVER_ECHO"',
  'role = "PUBLIC"',
  "",
].join("\n");
const MIGRATED_SNOWFLAKE_TOML = LEGACY_SNOWFLAKE_TOML.replace(
  'password = "PAT_VALUE_NEVER_ECHO"',
  'token = "PAT_VALUE_NEVER_ECHO"',
);

test("migrateLegacySnowflakeRuntimeFileBytes renames only the credential key", () => {
  const migrated = migrateLegacySnowflakeRuntimeFileBytes(
    "snowflake",
    Buffer.from(LEGACY_SNOWFLAKE_TOML),
  );
  assert.equal(migrated.toString("utf8"), MIGRATED_SNOWFLAKE_TOML);

  // Idempotent: the migrated shape is not touched again.
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes("snowflake", migrated),
    null,
  );
  // Scope guards: other servers, unmarked (hand-written) files, and files
  // without the PAT authenticator are never rewritten.
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes("glean", Buffer.from(LEGACY_SNOWFLAKE_TOML)),
    null,
  );
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes(
      "snowflake",
      Buffer.from(LEGACY_SNOWFLAKE_TOML.split("\n").slice(2).join("\n")),
    ),
    null,
  );
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes(
      "snowflake",
      Buffer.from(LEGACY_SNOWFLAKE_TOML.replace(/^authenticator[^\n]*\n/m, "")),
    ),
    null,
  );
  // Indented authenticator lines are not the generated shape.
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes(
      "snowflake",
      Buffer.from(
        LEGACY_SNOWFLAKE_TOML.replace(/^authenticator/m, "  authenticator"),
      ),
    ),
    null,
  );
  // Non-UTF-8 payloads are left untouched.
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes(
      "snowflake",
      Buffer.concat([Buffer.from("# Generated by"), Buffer.from([0xff, 0xfe])]),
    ),
    null,
  );
  // A file already carrying a token key is never double-migrated.
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes(
      "snowflake",
      Buffer.from(`${LEGACY_SNOWFLAKE_TOML}token = "second"\n`),
    ),
    null,
  );
});

test("read path migrates legacy snowflake bytes and persists them back", () => {
  const upserts = [];
  const result = withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync() {
        return Buffer.from(LEGACY_SNOWFLAKE_TOML).toString("base64");
      },
      upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
        upserts.push({ account: env.PORTICO_LLM_KEYCHAIN_ACCOUNT, value });
        return value;
      },
    },
    () =>
      readSensitiveRuntimeFilePersistedBytes({
        serverId: "snowflake",
        target: "/root/.snowflake/connections.toml",
        env: {},
      }),
  );

  assert.equal(result.toString("utf8"), MIGRATED_SNOWFLAKE_TOML);
  assert.equal(upserts.length, 1);
  assert.equal(
    upserts[0].account,
    sensitiveRuntimeFileKeychainAccount(
      "snowflake",
      "/root/.snowflake/connections.toml",
    ),
  );
  assert.equal(
    Buffer.from(upserts[0].value, "base64").toString("utf8"),
    MIGRATED_SNOWFLAKE_TOML,
  );
});

test("read path does not rewrite already-migrated or foreign bytes", () => {
  let upsertCalls = 0;
  const mock = (stored) => ({
    readPorticoLlmApiKeyFromKeychainSync() {
      return Buffer.from(stored).toString("base64");
    },
    upsertPorticoLlmApiKeyInKeychainSync(value) {
      upsertCalls += 1;
      return value;
    },
  });

  const migratedShape = withMockKeychain(mock(MIGRATED_SNOWFLAKE_TOML), () =>
    readSensitiveRuntimeFilePersistedBytes({
      serverId: "snowflake",
      target: "/root/.snowflake/connections.toml",
      env: {},
    }),
  );
  assert.equal(migratedShape.toString("utf8"), MIGRATED_SNOWFLAKE_TOML);

  const handWritten = "[default]\npassword = \"mine\"\n";
  const untouched = withMockKeychain(mock(handWritten), () =>
    readSensitiveRuntimeFilePersistedBytes({
      serverId: "snowflake",
      target: "/root/.snowflake/connections.toml",
      env: {},
    }),
  );
  assert.equal(untouched.toString("utf8"), handWritten);
  assert.equal(upsertCalls, 0);
});

test("a failed keychain write still serves migrated snowflake bytes", () => {
  const result = withMockKeychain(
    {
      readPorticoLlmApiKeyFromKeychainSync() {
        return Buffer.from(LEGACY_SNOWFLAKE_TOML).toString("base64");
      },
      upsertPorticoLlmApiKeyInKeychainSync() {
        throw new Error("keychain unavailable");
      },
    },
    () =>
      readSensitiveRuntimeFilePersistedBytes({
        serverId: "snowflake",
        target: "/root/.snowflake/connections.toml",
        env: {},
      }),
  );
  assert.equal(result.toString("utf8"), MIGRATED_SNOWFLAKE_TOML);
});

test("import path migrates legacy plaintext snowflake sources before persisting", () => {
  withTempManagedRoot((managedRoot) => {
    resetSensitiveRuntimeFileImportSessionStateForTests();
    const env = {
      PORTICO_RUNTIME_SECRET_CACHE_DIR: path.join(managedRoot, "runtime-secret-cache"),
    };
    const runtimeDir = path.join(managedRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const sourcePath = path.join(runtimeDir, "connections.toml");
    fs.writeFileSync(sourcePath, LEGACY_SNOWFLAKE_TOML, "utf8");
    writeMcpServerYaml(
      managedRoot,
      "snowflake",
      [
        "name: Snowflake",
        "runtime_files:",
        "  - source: ./runtime/connections.toml",
        "    target: /root/.snowflake/connections.toml",
        "    sensitive: true",
        "",
      ].join("\n"),
    );

    const persisted = [];
    withMockKeychain(
      {
        readPorticoLlmApiKeyFromKeychainSync() {
          return "";
        },
        upsertPorticoLlmApiKeyInKeychainSync(value, { env }) {
          persisted.push(value);
          return value;
        },
      },
      () => {
        const imported = resolveMcpSensitiveRuntimeFileSecrets({
          env,
          projectRoot: managedRoot,
        });
        assert.equal(imported.length, 1);
        assert.equal(imported[0].importedFromSource, true);
      },
    );

    assert.equal(persisted.length, 1);
    assert.equal(
      Buffer.from(persisted[0], "base64").toString("utf8"),
      MIGRATED_SNOWFLAKE_TOML,
    );
    assert.equal(
      fs.readFileSync(sourcePath, "utf8"),
      LEGACY_SNOWFLAKE_TOML,
      "migration transforms only the secure-storage payload, never the disk file",
    );
  });
});

test("migration refuses marker files the user extended with their own sections", () => {
  // A generated file the user extended: a `password` in a foreign section is
  // a real corporate credential the migration must never touch.
  const extended = `${LEGACY_SNOWFLAKE_TOML}\n[personal]\npassword = "corporate-password"\n`;
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes("snowflake", Buffer.from(extended)),
    null,
  );
  // A stray credential before [default] is also out of bounds — refuse when
  // [default] carries the authenticator but not the credential.
  const strayTop = LEGACY_SNOWFLAKE_TOML.replace(
    'password = "PAT_VALUE_NEVER_ECHO"\n',
    "",
  ).replace(
    "[default]",
    'password = "corporate-password"\n[default]',
  );
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes("snowflake", Buffer.from(strayTop)),
    null,
  );
  // Multi-line strings could hide key-shaped content; refuse them entirely.
  const withHeredoc = LEGACY_SNOWFLAKE_TOML.replace(
    'role = "PUBLIC"',
    'role = "PUBLIC"\ncomment = """\npassword = "fake"\n"""',
  );
  assert.equal(
    migrateLegacySnowflakeRuntimeFileBytes("snowflake", Buffer.from(withHeredoc)),
    null,
  );
});
