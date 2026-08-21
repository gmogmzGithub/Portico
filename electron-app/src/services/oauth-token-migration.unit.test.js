const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  checkPersistedOAuthTokens,
  loadOAuthRecord,
  migrateLegacyOAuthRecord,
  persistOAuthRecord,
} = require("./oauth-token-storage");

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "os_crypt",
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (buffer) =>
      Buffer.from(buffer).toString("utf8").slice("encrypted:".length),
  };
}

function withStorage(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-migration-project-"));
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-migration-user-"));
  try {
    run({ projectRoot, userDataPath, safeStorage: safeStorage() });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

function writeLegacyPair(projectRoot, serverId) {
  const tokensDir = path.join(
    projectRoot,
    "mcpo-oauth-tokens",
    serverId,
    "tokens",
  );
  fs.mkdirSync(tokensDir, { recursive: true });
  fs.writeFileSync(
    path.join(tokensDir, "legacy_tokens.json"),
    JSON.stringify({ access_token: "legacy-access" }),
  );
  fs.writeFileSync(
    path.join(tokensDir, "legacy_client.json"),
    JSON.stringify({ client_id: "legacy-client" }),
  );
  return tokensDir;
}

test("physical legacy OAuth state replaces secure state exactly once", () => {
  withStorage((options) => {
    persistOAuthRecord(
      "product-pal",
      {
        token: { access_token: "stale-secure" },
        client_info: { client_id: "stale-client" },
      },
      options,
    );
    const tokensDir = writeLegacyPair(options.projectRoot, "product-pal");

    const migrated = migrateLegacyOAuthRecord("product-pal", {
      ...options,
      exportLegacyOAuthRecord: () => ({
        server_id: "product-pal",
        token: { access_token: "migrated-access" },
        client_info: { client_id: "migrated-client" },
      }),
    });

    assert.equal(migrated.imported, true);
    assert.equal(fs.existsSync(tokensDir), false);
    assert.equal(
      loadOAuthRecord("product-pal", options).token.access_token,
      "migrated-access",
    );
    assert.equal(
      migrateLegacyOAuthRecord("product-pal", options).reason,
      "secure_record_present",
    );
  });
});

test("failed legacy OAuth import preserves plaintext and blocks secure vending", () => {
  withStorage((options) => {
    const tokensDir = writeLegacyPair(options.projectRoot, "productkit-mcp");
    const result = migrateLegacyOAuthRecord("productkit-mcp", {
      ...options,
      exportLegacyOAuthRecord: () => {
        throw new Error("legacy encrypted OAuth token file is unsupported");
      },
    });

    assert.equal(result.state, "requires_reauth");
    assert.equal(fs.existsSync(tokensDir), true);
    const persisted = checkPersistedOAuthTokens("productkit-mcp", options);
    assert.equal(persisted.exists, false);
    assert.equal(persisted.reason, "legacy_oauth_store_requires_reauth");
  });
});
