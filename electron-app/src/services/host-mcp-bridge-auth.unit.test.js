const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureBridgeAuthRegistry,
  ensureClientBridgeToken,
  ensureScopedBridgeToken,
  getBridgeAuthRedactedStatus,
  getBridgeClientTokenPath,
  getBridgeTokenRegistryPath,
  hashBridgeToken,
  loadBridgeAuthRegistry,
  revokeClientBridgeToken,
  verifyBridgeTokenHash,
} = require("./host-mcp-bridge-auth");

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "host-mcp-bridge-auth-"));
}

const FIXTURE_DIR = path.resolve(
  __dirname,
  "../../../test-fixtures/host-mcp-bridge-auth",
);
const silentLogger = { info() {}, warn() {}, log() {} };

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info(message) {
      lines.push(String(message));
    },
    warn(message) {
      lines.push(String(message));
    },
    log(message) {
      lines.push(String(message));
    },
  };
}

test("Host MCP Bridge registry stores token hashes and redacted status only", () => {
  const userDataPath = tempUserData();
  const registryPath = ensureBridgeAuthRegistry({ userDataPath });
  assert.equal(registryPath, getBridgeTokenRegistryPath(userDataPath));

  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-code",
    displayName: "Atlas Code",
  });

  assert.match(tokenInfo.token, /^portico_mcp_/);
  assert.equal(fs.readFileSync(tokenInfo.tokenPath, "utf8").trim(), tokenInfo.token);

  const registryText = fs.readFileSync(registryPath, "utf8");
  assert.doesNotMatch(registryText, new RegExp(tokenInfo.token));
  const registry = loadBridgeAuthRegistry({ registryPath });
  assert.equal(registry.tokens.length, 1);
  assert.equal(registry.tokens[0].clientId, "atlas-code");
  assert.equal(verifyBridgeTokenHash(tokenInfo.token, registry.tokens[0].tokenHash), true);

  const status = getBridgeAuthRedactedStatus({ userDataPath });
  assert.equal(status.success, true);
  assert.equal(status.clients[0].configured, true);
  assert.equal(status.clients[0].tokenFileExists, true);
  assert.deepEqual(
    Object.keys(status.clients[0]).sort(),
    ["clientId", "configured", "createdAt", "displayName", "revoked", "tokenFileExists", "updatedAt"].sort(),
  );
  assert.doesNotMatch(JSON.stringify(status), new RegExp(tokenInfo.token));
});

test("Host MCP Bridge client token can be revoked", () => {
  const userDataPath = tempUserData();
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "cursor",
    displayName: "Cursor",
  });
  assert.equal(fs.existsSync(getBridgeClientTokenPath(userDataPath, "cursor")), true);

  const result = revokeClientBridgeToken({ userDataPath, clientId: "cursor" });
  assert.deepEqual(result, { success: true, revoked: true });
  assert.equal(fs.existsSync(tokenInfo.tokenPath), false);

  const registry = loadBridgeAuthRegistry({ userDataPath });
  assert.equal(registry.tokens[0].revoked, true);
});

test("Host MCP Bridge scoped token preserves exact scopes without storing token plaintext", () => {
  const userDataPath = tempUserData();
  const tokenInfo = ensureScopedBridgeToken({
    userDataPath,
    clientId: "mcpo-slack",
    displayName: "Slack OAuth runtime",
    scopes: ["oauth:access-token:slack", "oauth:access-token:slack"],
  });
  assert.deepEqual(tokenInfo.scopes, ["oauth:access-token:slack"]);

  const registry = loadBridgeAuthRegistry({ userDataPath });
  assert.equal(registry.tokens.length, 1);
  assert.deepEqual(registry.tokens[0].scopes, ["oauth:access-token:slack"]);
  assert.doesNotMatch(JSON.stringify(registry), new RegExp(tokenInfo.token));

  const reused = ensureScopedBridgeToken({
    userDataPath,
    clientId: "mcpo-slack",
    displayName: "Slack OAuth runtime",
    scopes: ["oauth:access-token:slack"],
  });
  assert.equal(reused.created, false);
  assert.equal(reused.token, tokenInfo.token);
});

test("bridge token hash verification rejects malformed or wrong tokens", () => {
  const tokenHash = hashBridgeToken("portico_mcp_real", "0123456789abcdef0123456789abcdef");
  assert.equal(verifyBridgeTokenHash("portico_mcp_real", tokenHash), true);
  assert.equal(verifyBridgeTokenHash("portico_mcp_wrong", tokenHash), false);
  assert.equal(verifyBridgeTokenHash("portico_mcp_real", "sha256:salt"), false);
  assert.equal(verifyBridgeTokenHash("", tokenHash), false);
});


test("shared v1 registry fixtures preserve legacy and scoped authority", () => {
  const legacyPath = path.join(FIXTURE_DIR, "valid-v1-legacy-scopes.json");
  const scopedPath = path.join(FIXTURE_DIR, "valid-v1-scoped.json");
  const legacy = loadBridgeAuthRegistry({ registryPath: legacyPath });
  const scoped = loadBridgeAuthRegistry({ registryPath: scopedPath });

  assert.equal(legacy.version, 1);
  assert.deepEqual(legacy.tokens[0].scopes, []);
  assert.equal(legacy.tokens[0].revoked, false);
  assert.equal(
    verifyBridgeTokenHash(
      "portico_mcp_fixture_unscoped_AZaz09-._~",
      legacy.tokens[0].tokenHash,
    ),
    true,
  );
  assert.deepEqual(scoped.tokens[0].scopes, [
    "bridge:status",
    "oauth:access-token:fixture",
  ]);
  assert.equal(
    verifyBridgeTokenHash(
      "portico_mcp_fixture_scoped_AZaz09-._~",
      scoped.tokens[0].tokenHash,
    ),
    true,
  );
});

test("semantic registry corruption fails without rewriting registry or token bytes", () => {
  const invalidMutations = [
    ["unsupported version", (raw) => { raw.version = 2; }],
    ["non-array tokens", (raw) => { raw.tokens = {}; }],
    ["missing revoked", (raw) => { delete raw.tokens[0].revoked; }],
    ["string revoked", (raw) => { raw.tokens[0].revoked = "false"; }],
    ["whitespace scope", (raw) => { raw.tokens[0].scopes = [" bridge:status"]; }],
    ["noncanonical scopes", (raw) => { raw.tokens[0].scopes = ["z", "a", "a"]; }],
    ["non-ASCII scope", (raw) => { raw.tokens[0].scopes = ["bridge:status", "é"]; }],
    ["uppercase hash", (raw) => { raw.tokens[0].tokenHash = raw.tokens[0].tokenHash.toUpperCase(); }],
    ["unsafe client id", (raw) => { raw.tokens[0].clientId = "unsafe client"; }],
    ["exact duplicate", (raw) => { raw.tokens.push({ ...raw.tokens[0] }); }],
    ["case-fold duplicate", (raw) => {
      raw.tokens.push({ ...raw.tokens[0], clientId: raw.tokens[0].clientId.toUpperCase() });
    }],
  ];

  for (const [label, mutate] of invalidMutations) {
    const userDataPath = tempUserData();
    const tokenInfo = ensureClientBridgeToken({
      userDataPath,
      clientId: "atlas-code",
      displayName: "Atlas Code",
      logger: silentLogger,
    });
    const registryPath = getBridgeTokenRegistryPath(userDataPath);
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    mutate(raw);
    const invalidBytes = JSON.stringify(raw, null, 2) + "\n";
    fs.writeFileSync(registryPath, invalidBytes, "utf8");
    const tokenBytes = fs.readFileSync(tokenInfo.tokenPath);

    assert.throws(
      () => loadBridgeAuthRegistry({ registryPath }),
      /Failed to read Host MCP Bridge auth registry/,
      label,
    );
    assert.equal(fs.readFileSync(registryPath, "utf8"), invalidBytes, label);
    assert.deepEqual(fs.readFileSync(tokenInfo.tokenPath), tokenBytes, label);
  }
});

test("case-folded ensure and revoke resolve the stored client ID before touching files", () => {
  const userDataPath = tempUserData();
  const first = ensureClientBridgeToken({
    userDataPath,
    clientId: "Foo",
    displayName: "Case Fixture",
    logger: silentLogger,
  });
  const tokenBytes = fs.readFileSync(first.tokenPath);

  const reused = ensureClientBridgeToken({
    userDataPath,
    clientId: "foo",
    displayName: "Case Fixture",
    logger: silentLogger,
  });
  assert.equal(reused.clientId, "Foo");
  assert.equal(reused.token, first.token);
  assert.deepEqual(fs.readFileSync(first.tokenPath), tokenBytes);

  const result = revokeClientBridgeToken({
    userDataPath,
    clientId: "foo",
    logger: silentLogger,
  });
  assert.deepEqual(result, { success: true, revoked: true });
  assert.equal(fs.existsSync(first.tokenPath), false);
  const registry = loadBridgeAuthRegistry({ userDataPath });
  assert.equal(registry.tokens[0].clientId, "Foo");
  assert.equal(registry.tokens[0].revoked, true);
});

test("client IDs retain safe sanitization and tokenPath overrides are rejected", () => {
  const userDataPath = tempUserData();
  const sanitized = ensureClientBridgeToken({
    userDataPath,
    clientId: "my.company tool",
    displayName: "Dotted broker ID",
    logger: silentLogger,
  });
  assert.equal(sanitized.clientId, "my-company-tool");
  assert.equal(
    sanitized.tokenPath,
    getBridgeClientTokenPath(userDataPath, "my.company tool"),
  );
  assert.deepEqual(
    revokeClientBridgeToken({
      userDataPath,
      clientId: "my.company tool",
      logger: silentLogger,
    }),
    { success: true, revoked: true },
  );

  const overridePath = path.join(userDataPath, "shared.token");
  assert.throws(
    () => ensureClientBridgeToken({
      userDataPath,
      clientId: "workbench",
      displayName: "Workbench",
      tokenPath: overridePath,
      logger: silentLogger,
    }),
    /tokenPath overrides are not supported/,
  );
  assert.equal(fs.existsSync(overridePath), false);
  assert.throws(
    () => ensureScopedBridgeToken({
      userDataPath,
      clientId: "unicode-scope",
      scopes: ["oauth:access-token:é"],
      logger: silentLogger,
    }),
    /printable-ASCII/,
  );
  assert.equal(
    loadBridgeAuthRegistry({ userDataPath }).tokens.some(
      (entry) => entry.clientId === "unicode-scope",
    ),
    false,
  );
});

test("unrelated scoped token ensures never change an external token", () => {
  const userDataPath = tempUserData();
  const external = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-code",
    displayName: "Atlas Code",
    logger: silentLogger,
  });
  const beforeFile = fs.readFileSync(external.tokenPath);
  const beforeRegistry = loadBridgeAuthRegistry({ userDataPath });
  const beforeHash = beforeRegistry.tokens.find((entry) => entry.clientId === "atlas-code").tokenHash;

  for (let index = 0; index < 20; index += 1) {
    ensureScopedBridgeToken({
      userDataPath,
      clientId: "oauth-access-token-fixture-" + index,
      displayName: "Fixture scoped token",
      scopes: ["oauth:access-token:fixture-" + index],
      logger: silentLogger,
    });
  }

  const reused = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-code",
    displayName: "Atlas Code",
    logger: silentLogger,
  });
  const afterRegistry = loadBridgeAuthRegistry({ userDataPath });
  assert.equal(reused.created, false);
  assert.equal(reused.token, external.token);
  assert.deepEqual(fs.readFileSync(external.tokenPath), beforeFile);
  assert.equal(
    afterRegistry.tokens.find((entry) => entry.clientId === "atlas-code").tokenHash,
    beforeHash,
  );
});

test("active token bytes stay stable until explicit revoke", () => {
  const userDataPath = tempUserData();
  const logger = capturingLogger();
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "cursor",
    displayName: "Cursor",
    logger,
  });
  const originalTokenBytes = fs.readFileSync(tokenInfo.tokenPath);
  const registryPath = getBridgeTokenRegistryPath(userDataPath);
  const originalHash = loadBridgeAuthRegistry({ registryPath }).tokens[0].tokenHash;

  fs.rmSync(tokenInfo.tokenPath);
  assert.throws(
    () => ensureClientBridgeToken({
      userDataPath,
      clientId: "cursor",
      displayName: "Cursor",
      logger,
    }),
    /cannot be replaced implicitly/,
  );
  assert.equal(loadBridgeAuthRegistry({ registryPath }).tokens[0].tokenHash, originalHash);

  fs.writeFileSync(tokenInfo.tokenPath, originalTokenBytes);
  fs.writeFileSync(tokenInfo.tokenPath, "portico_mcp_wrong\n");
  assert.throws(
    () => ensureClientBridgeToken({
      userDataPath,
      clientId: "cursor",
      displayName: "Cursor",
      logger,
    }),
    /cannot be replaced implicitly/,
  );
  assert.equal(loadBridgeAuthRegistry({ registryPath }).tokens[0].tokenHash, originalHash);

  fs.writeFileSync(tokenInfo.tokenPath, originalTokenBytes);
  const scopeUpdated = ensureClientBridgeToken({
    userDataPath,
    clientId: "cursor",
    displayName: "Cursor",
    scopes: ["bridge:status"],
    logger,
  });
  assert.equal(scopeUpdated.created, false);
  assert.equal(scopeUpdated.token, tokenInfo.token);
  assert.deepEqual(fs.readFileSync(tokenInfo.tokenPath), originalTokenBytes);
  const updatedEntry = loadBridgeAuthRegistry({ registryPath }).tokens[0];
  assert.equal(updatedEntry.tokenHash, originalHash);
  assert.deepEqual(updatedEntry.scopes, ["bridge:status"]);

  revokeClientBridgeToken({ userDataPath, clientId: "cursor", logger });
  const output = logger.lines.join("\n");
  for (const reason of [
    "reason=fresh",
    "reason=token_file_unavailable",
    "reason=hash_mismatch",
    "reason=scope_changed",
    "reason=explicit",
  ]) {
    assert.match(output, new RegExp(reason));
  }
  assert.equal(output.includes(tokenInfo.token), false);
  assert.equal(output.includes(userDataPath), false);
  assert.doesNotMatch(output, /sha256:[0-9a-f]+:[0-9a-f]+/);
});

test("failed fresh mint restores exact prior token and registry bytes", () => {
  const userDataPath = tempUserData();
  const registryPath = ensureBridgeAuthRegistry({ userDataPath });
  const tokenPath = getBridgeClientTokenPath(userDataPath, "rollback-client");
  const priorTokenBytes = Buffer.from("prior-unregistered-token-bytes\n", "utf8");
  fs.writeFileSync(tokenPath, priorTokenBytes);
  const priorRegistryBytes = fs.readFileSync(registryPath);
  const logger = capturingLogger();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function patchedRenameSync(source, destination) {
    if (path.resolve(destination) === path.resolve(registryPath)) {
      throw new Error("synthetic registry rename failure");
    }
    return originalRenameSync.call(fs, source, destination);
  };
  try {
    assert.throws(
      () => ensureClientBridgeToken({
        userDataPath,
        clientId: "rollback-client",
        displayName: "Rollback Client",
        logger,
      }),
      /synthetic registry rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(fs.readFileSync(tokenPath), priorTokenBytes);
  assert.deepEqual(fs.readFileSync(registryPath), priorRegistryBytes);
  assert.match(logger.lines.join("\n"), /reason=registry_write_failed/);
  assert.match(logger.lines.join("\n"), /changed=false/);
});

test("revoke commits its tombstone before token-file cleanup", () => {
  const userDataPath = tempUserData();
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "amp",
    displayName: "Amp",
    logger: silentLogger,
  });
  const registryPath = getBridgeTokenRegistryPath(userDataPath);
  const saveFailureLogger = capturingLogger();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function patchedRenameSync(source, destination) {
    if (path.resolve(destination) === path.resolve(registryPath)) {
      throw new Error("synthetic save failure");
    }
    return originalRenameSync.call(fs, source, destination);
  };
  try {
    assert.throws(
      () => revokeClientBridgeToken({
        userDataPath,
        clientId: "amp",
        logger: saveFailureLogger,
      }),
      /synthetic save failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.existsSync(tokenInfo.tokenPath), true);
  assert.equal(loadBridgeAuthRegistry({ userDataPath }).tokens[0].revoked, false);
  assert.match(saveFailureLogger.lines.join("\n"), /reason=registry_write_failed/);

  const deleteFailureLogger = capturingLogger();
  const originalRmSync = fs.rmSync;
  fs.rmSync = function patchedRmSync(target, options) {
    if (path.resolve(target) === path.resolve(tokenInfo.tokenPath)) {
      throw new Error("synthetic delete failure");
    }
    return originalRmSync.call(fs, target, options);
  };
  let result;
  try {
    result = revokeClientBridgeToken({
      userDataPath,
      clientId: "amp",
      logger: deleteFailureLogger,
    });
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.deepEqual(result, { success: true, revoked: true });
  assert.equal(fs.existsSync(tokenInfo.tokenPath), true);
  assert.equal(loadBridgeAuthRegistry({ userDataPath }).tokens[0].revoked, true);
  assert.match(deleteFailureLogger.lines.join("\n"), /reason=token_file_delete_failed/);
});

test("logger failures never change token lifecycle results", () => {
  const userDataPath = tempUserData();
  const throwingLogger = {
    info() {
      throw new Error("logger unavailable");
    },
    warn() {
      throw new Error("logger unavailable");
    },
  };
  const tokenInfo = ensureClientBridgeToken({
    userDataPath,
    clientId: "atlas-desktop",
    displayName: "Atlas Desktop",
    logger: throwingLogger,
  });
  assert.equal(verifyBridgeTokenHash(
    tokenInfo.token,
    loadBridgeAuthRegistry({ userDataPath }).tokens[0].tokenHash,
  ), true);
  assert.deepEqual(
    revokeClientBridgeToken({
      userDataPath,
      clientId: "atlas-desktop",
      logger: throwingLogger,
    }),
    { success: true, revoked: true },
  );
});
