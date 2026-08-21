const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveOAuthTokenStorage,
  persistOAuthRecord,
  loadOAuthRecord,
  migrateLegacyOAuthRecord,
  migrateAllLegacyOAuthRecords,
  clearSecureOAuthRecord,
  invalidateSecureOAuthRecord,
  clearLegacyOAuthFiles,
  clearPersistedOAuthTokens,
  checkPersistedOAuthTokens,
  readMigrationStatus,
} = require("./oauth-token-storage");

function withPaths(run) {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "oauth-token-storage-project-"),
  );
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "oauth-token-storage-user-data-"),
  );
  try {
    return run({ projectRoot, userDataPath });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

function createSafeStorage(backend = "os_crypt") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) =>
      Buffer.from(`enc:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
    decryptString: (buffer) => {
      const value = Buffer.from(buffer).toString("utf8");
      if (!value.startsWith("enc:")) {
        throw new Error("invalid ciphertext");
      }
      return Buffer.from(value.slice(4), "base64").toString("utf8");
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

test("resolveOAuthTokenStorage uses canonical server_id safeStorage record path", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const storage = resolveOAuthTokenStorage("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });

    assert.equal(storage.serverId, "data-plat-mcp");
    assert.equal(storage.storageScope, "electron_safe_storage");
    assert.equal(
      storage.recordFile,
      path.join(userDataPath, "mcp-oauth-records", "data-plat-mcp.json.enc"),
    );
    assert.deepEqual(
      storage.legacy.roots.map((root) => root.storageRootName),
      ["mcpo-oauth-tokens", "mcpo-core-oauth-tokens"],
    );
  });
});

test("persistOAuthRecord and loadOAuthRecord round-trip through safeStorage only", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const oauthRecord = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      client_secret: "client-secret",
    };

    const result = persistOAuthRecord("slack", oauthRecord, {
      projectRoot,
      userDataPath,
      safeStorage,
    });

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(result.recordFile), true);
    assert.equal(fs.existsSync(path.join(projectRoot, "mcpo-oauth-tokens")), false);
    const raw = fs.readFileSync(result.recordFile, "utf8");
    assert(!raw.includes("refresh-token"));
    assert(!raw.includes("client-secret"));
    assert.deepEqual(
      loadOAuthRecord("slack", { projectRoot, userDataPath, safeStorage }),
      oauthRecord,
    );
  });
});

test("checkPersistedOAuthTokens validates secure safeStorage records", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    persistOAuthRecord(
      "skills",
      { access_token: "access-token" },
      { projectRoot, userDataPath, safeStorage },
    );

    const result = checkPersistedOAuthTokens("skills", {
      projectRoot,
      userDataPath,
      safeStorage,
    });

    assert.equal(result.exists, true);
    assert.equal(result.serverId, "skills");
    assert.equal(result.storageScope, "electron_safe_storage");
  });
});

test("legacy OAuth files require migration rather than counting as valid state", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "google_workspace",
      "tokens",
    );
    writeJson(path.join(legacyTokensDir, "abcd_tokens.json"), {
      access_token: "legacy-access-token",
    });
    writeJson(path.join(legacyTokensDir, "abcd_client.json"), {
      client_id: "legacy-client-id",
    });

    const result = checkPersistedOAuthTokens("google_workspace", {
      projectRoot,
      userDataPath,
      safeStorage: createSafeStorage(),
    });

    assert.equal(result.exists, false);
    assert.equal(result.reason, "legacy_oauth_store_requires_migration");
    assert.equal(result.legacyTokenFiles, 1);
    assert.equal(result.legacyClientFiles, 1);
  });
});

test("migrateLegacyOAuthRecord replaces stale secure state from legacy files and then removes plaintext", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    persistOAuthRecord(
      "slack",
      {
        token: { access_token: "stale-secure-token" },
        client_info: { client_id: "stale-secure-client" },
      },
      { projectRoot, userDataPath, safeStorage },
    );
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "slack",
      "tokens",
    );
    const legacyServerDir = path.dirname(legacyTokensDir);
    const legacyRootDir = path.dirname(legacyServerDir);
    const tokenPath = path.join(legacyTokensDir, "c25033a9_tokens.json");
    const clientPath = path.join(legacyTokensDir, "c25033a9_client.json");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "legacy-client-id" });

    const result = migrateLegacyOAuthRecord("slack", {
      projectRoot,
      userDataPath,
      safeStorage,
      exportLegacyOAuthRecord: (serverId, root) => {
        assert.equal(serverId, "slack");
        assert.equal(root.tokensDir, legacyTokensDir);
        return {
          server_id: "slack",
          token: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          },
          client_info: {
            client_id: "client-id",
            client_secret: "client-secret",
          },
        };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.imported, true);
    assert.equal(result.removedLegacyFiles, 2);
    assert.deepEqual(loadOAuthRecord("slack", { projectRoot, userDataPath, safeStorage }), {
      token: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      },
      client_info: {
        client_id: "client-id",
        client_secret: "client-secret",
      },
    });
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(fs.existsSync(clientPath), false);
    assert.equal(fs.existsSync(legacyTokensDir), false);
    assert.equal(fs.existsSync(legacyServerDir), false);
    assert.equal(fs.existsSync(legacyRootDir), false);
    assert.deepEqual(
      fs.readdirSync(path.join(userDataPath, "mcp-oauth-records")),
      ["slack.json.enc"],
    );
    const status = readMigrationStatus({ projectRoot, userDataPath }).servers.slack;
    assert.equal(status.state, "imported");
    assert.equal(status.removedLegacyFiles, 2);
  });
});

test("migrateLegacyOAuthRecord preserves legacy files when import fails", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const existingSecureRecord = {
      token: { access_token: "existing-secure-token" },
      client_info: { client_id: "existing-secure-client" },
    };
    persistOAuthRecord("glean", existingSecureRecord, {
      projectRoot,
      userDataPath,
      safeStorage,
    });
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "glean",
      "tokens",
    );
    const tokenPath = path.join(legacyTokensDir, "39621ca5_tokens.json");
    const clientPath = path.join(legacyTokensDir, "39621ca5_client.json");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "legacy-client-id" });

    const result = migrateLegacyOAuthRecord("glean", {
      projectRoot,
      userDataPath,
      safeStorage,
      exportLegacyOAuthRecord: () => {
        throw new Error("legacy encrypted OAuth token file is unsupported");
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.state, "requires_reauth");
    assert.equal(result.reason, "legacy_oauth_store_requires_reauth");
    assert.equal(result.errorClass, "legacy_oauth_encrypted_store_unsupported");
    assert.equal(fs.existsSync(tokenPath), true);
    assert.equal(fs.existsSync(clientPath), true);
    assert.deepEqual(
      loadOAuthRecord("glean", { projectRoot, userDataPath, safeStorage }),
      existingSecureRecord,
    );
    const check = checkPersistedOAuthTokens("glean", {
      projectRoot,
      userDataPath,
      safeStorage,
    });
    assert.equal(check.reason, "legacy_oauth_store_requires_reauth");
    assert.equal(check.errorClass, "legacy_oauth_encrypted_store_unsupported");
  });
});

test("migrateLegacyOAuthRecord treats orphan legacy client files as stale when secure record exists", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const existingSecureRecord = {
      token: { access_token: "existing-secure-token" },
      client_info: { client_id: "existing-secure-client" },
    };
    persistOAuthRecord("google_workspace", existingSecureRecord, {
      projectRoot,
      userDataPath,
      safeStorage,
    });
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "google_workspace",
      "tokens",
    );
    const clientPath = path.join(legacyTokensDir, "b31e64bd_client.json");
    writeJson(clientPath, { client_id: "orphan-legacy-client" });

    const result = migrateLegacyOAuthRecord("google_workspace", {
      projectRoot,
      userDataPath,
      safeStorage,
    });

    assert.equal(result.success, true);
    assert.equal(result.state, "skipped");
    assert.equal(result.reason, "secure_record_present");
    assert.equal(result.legacyTokenFiles, 0);
    assert.equal(result.legacyClientFiles, 1);
    assert.equal(result.removedLegacyFiles, 1);
    assert.equal(fs.existsSync(clientPath), false);
    assert.deepEqual(
      loadOAuthRecord("google_workspace", {
        projectRoot,
        userDataPath,
        safeStorage,
      }),
      existingSecureRecord,
    );
    assert.equal(
      checkPersistedOAuthTokens("google_workspace", {
        projectRoot,
        userDataPath,
        safeStorage,
      }).exists,
      true,
    );
    const status = readMigrationStatus({ projectRoot, userDataPath }).servers
      .google_workspace;
    assert.equal(status.state, "skipped");
    assert.equal(status.reason, "secure_record_present");
    assert.equal(status.removedLegacyFiles, 1);
  });
});

test("migrateLegacyOAuthRecord retries while authoritative physical files remain", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "slack",
      "tokens",
    );
    writeJson(path.join(legacyTokensDir, "39621ca5_tokens.json"), {
      access_token: "legacy-access-token",
    });
    writeJson(path.join(legacyTokensDir, "39621ca5_client.json"), {
      client_id: "legacy-client-id",
    });

    let attempts = 0;
    const options = {
      projectRoot,
      userDataPath,
      safeStorage,
      exportLegacyOAuthRecord: () => {
        attempts += 1;
        throw new Error("legacy encrypted OAuth token file is unsupported");
      },
    };

    const first = migrateLegacyOAuthRecord("slack", options);
    const second = migrateLegacyOAuthRecord("slack", options);

    assert.equal(first.state, "requires_reauth");
    assert.equal(second.state, "requires_reauth");
    assert.equal(attempts, 2);
  });
});

test("migrateAllLegacyOAuthRecords scans both legacy roots before startup", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    for (const [rootName, serverId] of [
      ["mcpo-oauth-tokens", "productkit-mcp"],
      ["mcpo-core-oauth-tokens", "core-demo"],
    ]) {
      const tokensDir = path.join(projectRoot, rootName, serverId, "tokens");
      writeJson(path.join(tokensDir, `${serverId}_tokens.json`), {
        access_token: `${serverId}-legacy-token`,
      });
      writeJson(path.join(tokensDir, `${serverId}_client.json`), {
        client_id: `${serverId}-legacy-client`,
      });
    }

    const result = migrateAllLegacyOAuthRecords({
      projectRoot,
      userDataPath,
      safeStorage,
      exportLegacyOAuthRecord: (serverId) => ({
        server_id: serverId,
        token: { access_token: `${serverId}-secure-token` },
        client_info: { client_id: `${serverId}-secure-client` },
      }),
    });

    assert.equal(result.success, true);
    assert.equal(result.imported, 2);
    assert.equal(result.requiresReauth, 0);
    assert.equal(fs.existsSync(path.join(projectRoot, "mcpo-oauth-tokens")), false);
    assert.equal(fs.existsSync(path.join(projectRoot, "mcpo-core-oauth-tokens")), false);
  });
});

test("migrateLegacyOAuthRecord does not repeatedly decrypt a terminal bad secure record", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const storage = resolveOAuthTokenStorage("slack", {
      projectRoot,
      userDataPath,
    });
    fs.mkdirSync(path.dirname(storage.recordFile), { recursive: true });
    fs.writeFileSync(storage.recordFile, "not-a-valid-safe-storage-record", {
      mode: 0o600,
    });

    let decryptAttempts = 0;
    const safeStorage = {
      ...createSafeStorage(),
      decryptString: () => {
        decryptAttempts += 1;
        throw new Error("invalid ciphertext");
      },
    };

    const options = { projectRoot, userDataPath, safeStorage };
    const first = migrateLegacyOAuthRecord("slack", options);
    const second = migrateLegacyOAuthRecord("slack", options);

    assert.equal(first.state, "requires_reauth");
    assert.equal(first.reason, "secure_oauth_record_requires_reauth");
    assert.equal(second.state, "requires_reauth");
    assert.equal(second.reason, "secure_oauth_record_requires_reauth");
    assert.equal(decryptAttempts, 1);
    const status = readMigrationStatus({ projectRoot, userDataPath }).servers.slack;
    assert.equal(status.reason, "secure_oauth_record_requires_reauth");
  });
});

test("clearSecureOAuthRecord does not delete legacy files needed for migration", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const storage = resolveOAuthTokenStorage("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });
    persistOAuthRecord(
      "data-plat-mcp",
      { access_token: "access-token" },
      { projectRoot, userDataPath, safeStorage },
    );
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "data-plat-mcp",
      "tokens",
    );
    const tokenPath = path.join(legacyTokensDir, "4473fd2a_tokens.json");
    const clientPath = path.join(legacyTokensDir, "4473fd2a_client.json");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "client-id" });

    const result = clearSecureOAuthRecord("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });

    assert.equal(result.success, true);
    assert.equal(result.cleared, true);
    assert.equal(result.clearMode, "secure_oauth_record");
    assert.equal(fs.existsSync(storage.recordFile), false);
    assert.equal(fs.existsSync(tokenPath), true);
    assert.equal(fs.existsSync(clientPath), true);
  });
});

test("terminal secure OAuth invalidation persists reauth until a fresh record is saved", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const productPalConfig = path.join(
      projectRoot,
      "mcp-configs",
      "product-pal",
      "configuration.json",
    );
    writeJson(productPalConfig, { api_key: "preserved-product-pal-config" });
    const options = { projectRoot, userDataPath, safeStorage };
    const storage = resolveOAuthTokenStorage("product-pal", options);
    persistOAuthRecord(
      "product-pal",
      {
        token: {
          access_token: "dead-access-token",
          refresh_token: "dead-refresh-token",
        },
        client_info: { client_id: "dynamic-client" },
      },
      options,
    );

    const invalidated = invalidateSecureOAuthRecord("product-pal", {
      ...options,
      errorClass: "oauth_terminal_refresh_failure",
    });

    assert.equal(invalidated.cleared, true);
    assert.equal(invalidated.state, "requires_reauth");
    assert.equal(
      invalidated.reason,
      "secure_oauth_record_requires_reauth",
    );
    assert.equal(
      invalidated.errorClass,
      "oauth_terminal_refresh_failure",
    );
    assert.equal(fs.existsSync(storage.recordFile), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(productPalConfig, "utf8")), {
      api_key: "preserved-product-pal-config",
    });

    const check = checkPersistedOAuthTokens("product-pal", options);
    assert.equal(check.exists, false);
    assert.equal(check.reason, "secure_oauth_record_requires_reauth");
    assert.equal(check.errorClass, "oauth_terminal_refresh_failure");
    const migration = migrateLegacyOAuthRecord("product-pal", options);
    assert.equal(migration.state, "requires_reauth");
    assert.equal(
      migration.reason,
      "secure_oauth_record_requires_reauth",
    );

    persistOAuthRecord(
      "product-pal",
      {
        token: {
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
        },
        client_info: { client_id: "fresh-dynamic-client" },
      },
      options,
    );
    assert.equal(checkPersistedOAuthTokens("product-pal", options).exists, true);
    const status = readMigrationStatus(options).servers["product-pal"];
    assert.equal(status.state, "skipped");
    assert.equal(status.reason, "secure_record_present");
  });
});

test("clearLegacyOAuthFiles preserves secure safeStorage records", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const storage = resolveOAuthTokenStorage("google_workspace", {
      projectRoot,
      userDataPath,
    });
    const oauthRecord = {
      access_token: "access-token",
      refresh_token: "refresh-token",
    };
    persistOAuthRecord("google_workspace", oauthRecord, {
      projectRoot,
      userDataPath,
      safeStorage,
    });
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "google_workspace",
      "tokens",
    );
    const tokenPath = path.join(legacyTokensDir, "4473fd2a_tokens.json");
    const clientPath = path.join(legacyTokensDir, "4473fd2a_client.json");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "client-id" });

    const result = clearLegacyOAuthFiles("google_workspace", {
      projectRoot,
      userDataPath,
    });

    assert.equal(result.success, true);
    assert.equal(result.cleared, true);
    assert.equal(result.clearMode, "legacy_oauth_files");
    assert.equal(fs.existsSync(storage.recordFile), true);
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(fs.existsSync(clientPath), false);
    assert.deepEqual(
      loadOAuthRecord("google_workspace", { projectRoot, userDataPath, safeStorage }),
      oauthRecord,
    );
  });
});

test("clearPersistedOAuthTokens deletes safeStorage records and legacy token/client files", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    const storage = resolveOAuthTokenStorage("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });
    persistOAuthRecord(
      "data-plat-mcp",
      { access_token: "access-token" },
      { projectRoot, userDataPath, safeStorage },
    );
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "data-plat-mcp",
      "tokens",
    );
    const legacyServerDir = path.dirname(legacyTokensDir);
    const legacyRootDir = path.dirname(legacyServerDir);
    const tokenPath = path.join(legacyTokensDir, "4473fd2a_tokens.json");
    const clientPath = path.join(legacyTokensDir, "4473fd2a_client.json");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "client-id" });

    const result = clearPersistedOAuthTokens("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });

    assert.equal(result.success, true);
    assert.equal(result.cleared, true);
    assert.equal(result.clearedCount, 3);
    assert.equal(fs.existsSync(storage.recordFile), false);
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(fs.existsSync(clientPath), false);
    assert.equal(fs.existsSync(legacyTokensDir), false);
    assert.equal(fs.existsSync(legacyServerDir), false);
    assert.equal(fs.existsSync(legacyRootDir), false);
  });
});

test("clearPersistedOAuthTokens preserves non-empty legacy directories", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    const safeStorage = createSafeStorage();
    persistOAuthRecord(
      "data-plat-mcp",
      { access_token: "access-token" },
      { projectRoot, userDataPath, safeStorage },
    );
    const legacyTokensDir = path.join(
      projectRoot,
      "mcpo-oauth-tokens",
      "data-plat-mcp",
      "tokens",
    );
    const legacyServerDir = path.dirname(legacyTokensDir);
    const legacyRootDir = path.dirname(legacyServerDir);
    const tokenPath = path.join(legacyTokensDir, "4473fd2a_tokens.json");
    const clientPath = path.join(legacyTokensDir, "4473fd2a_client.json");
    const unrelatedPath = path.join(legacyTokensDir, "notes.txt");
    writeJson(tokenPath, { access_token: "legacy-access-token" });
    writeJson(clientPath, { client_id: "client-id" });
    fs.writeFileSync(unrelatedPath, "keep\n");

    const result = clearPersistedOAuthTokens("data-plat-mcp", {
      projectRoot,
      userDataPath,
    });

    assert.equal(result.success, true);
    assert.equal(result.cleared, true);
    assert.equal(result.clearedCount, 3);
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(fs.existsSync(clientPath), false);
    assert.equal(fs.existsSync(unrelatedPath), true);
    assert.equal(fs.existsSync(legacyTokensDir), true);
    assert.equal(fs.existsSync(legacyServerDir), true);
    assert.equal(fs.existsSync(legacyRootDir), true);
  });
});

test("safeStorage basic_text backend fails closed", () => {
  withPaths(({ projectRoot, userDataPath }) => {
    assert.throws(
      () =>
        persistOAuthRecord(
          "slack",
          { access_token: "access-token" },
          {
            projectRoot,
            userDataPath,
            safeStorage: createSafeStorage("basic_text"),
          },
        ),
      /basic_text/,
    );
  });
});
