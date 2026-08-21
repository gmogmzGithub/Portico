const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MIGRATION_MARKER_FILE,
  discoverCollisions,
  migrateUserMcpCollisions,
  rewriteCanonicalYaml,
} = require("./mcp-user-collision-migration");
const {
  loadOAuthRecord,
  persistOAuthRecord,
} = require("./oauth-token-storage");
const {
  ensureClientBridgeToken,
  getBridgeClientTokenPath,
  loadBridgeAuthRegistry,
} = require("./host-mcp-bridge-auth");

const quietLogger = {
  info() {},
  log() {},
  warn() {},
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8"),
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portico-mcp-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const userDataPath = path.join(root, "user-data");
  const systemDir = path.join(projectRoot, "mcp-configs", "demo-mcp");
  const userDir = path.join(projectRoot, "mcp-configs-user", "demo-mcp");
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, "demo-mcp.yaml"),
    'id: "demo-mcp"\nuser_installed: false\n',
  );
  if (options.withYaml !== false) {
    fs.writeFileSync(
      path.join(userDir, "demo-mcp.yaml"),
      options.yaml || 'id: "demo-mcp"\nuser_installed: true\n',
    );
  }
  fs.writeFileSync(
    path.join(userDir, "demo-mcp.fragment"),
    options.fragment || '{"type":"streamable-http","url":"https://example.test/mcp"}\n',
  );
  fs.writeFileSync(path.join(userDir, "demo-mcp.png"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(userDir, "setup.md"), "# Keep me\n");
  fs.chmodSync(path.join(userDir, "setup.md"), 0o640);
  fs.mkdirSync(path.join(userDir, "extra"));
  fs.writeFileSync(path.join(userDir, "extra", "custom.txt"), "custom\n");

  writeJson(path.join(projectRoot, "mcp_toggles.json"), {
    "demo-mcp": options.enabled !== false,
    ...(options.extraToggles || {}),
  });
  writeJson(path.join(projectRoot, "mcp_tools_config.json"), {
    "demo-mcp": { disabled_tools: ["dangerous_tool"] },
  });
  writeJson(path.join(projectRoot, "mcp-container-groups.json"), {
    groups: { ux: ["demo-mcp", "other-mcp", "demo-mcp"] },
  });
  writeJson(
    path.join(projectRoot, "health-status", "mcp_startup_failures.json"),
    {
      version: 1,
      failures: {
        "demo-mcp": {
          serverId: "demo-mcp",
          error: "old failure",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  );

  return { projectRoot, userDataPath, systemDir, userDir };
}

function runMigration(fixture, options = {}) {
  return migrateUserMcpCollisions({
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    safeStorage,
    logger: quietLogger,
    ...options,
  });
}

test("collision migration preserves the user bundle and moves keyed state", (t) => {
  const fixture = createFixture(t);
  const oauthRecord = {
    access_token: "redacted-test-token",
    token_type: "Bearer",
  };
  persistOAuthRecord("demo-mcp", oauthRecord, {
    projectRoot: fixture.projectRoot,
    userDataPath: fixture.userDataPath,
    safeStorage,
  });
  const bridgeClientId = "oauth-access-token-demo-mcp";
  ensureClientBridgeToken({
    userDataPath: fixture.userDataPath,
    clientId: bridgeClientId,
    scopes: ["demo-mcp"],
    logger: quietLogger,
  });

  const result = runMigration(fixture);
  assert.equal(result.migrated, 1);
  assert.deepEqual(result.migrations[0], {
    sourceId: "demo-mcp",
    systemId: "demo-mcp",
    targetId: "demo-mcp-user",
    sourceEnabled: true,
    resumed: false,
  });

  const targetDir = path.join(
    fixture.projectRoot,
    "mcp-configs-user",
    "demo-mcp-user",
  );
  assert.equal(fs.existsSync(fixture.userDir), false);
  assert.match(
    fs.readFileSync(path.join(targetDir, "demo-mcp-user.yaml"), "utf8"),
    /^id: "demo-mcp-user"/m,
  );
  assert.equal(
    fs.readFileSync(path.join(targetDir, "demo-mcp-user.fragment"), "utf8"),
    '{"type":"streamable-http","url":"https://example.test/mcp"}\n',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(targetDir, "demo-mcp-user.png")),
    Buffer.from([0, 1, 2, 3]),
  );
  assert.equal(
    fs.readFileSync(path.join(targetDir, "extra", "custom.txt"), "utf8"),
    "custom\n",
  );
  assert.equal(fs.existsSync(path.join(targetDir, MIGRATION_MARKER_FILE)), true);
  assert.equal(
    readJson(path.join(targetDir, MIGRATION_MARKER_FILE)).completed,
    true,
  );
  assert.equal(
    fs.statSync(path.join(targetDir, "setup.md")).mode & 0o777,
    0o640,
  );

  assert.deepEqual(
    readJson(path.join(fixture.projectRoot, "mcp_toggles.json")),
    { "demo-mcp": false, "demo-mcp-user": true },
  );
  assert.deepEqual(
    readJson(path.join(fixture.projectRoot, "mcp_tools_config.json")),
    { "demo-mcp-user": { disabled_tools: ["dangerous_tool"] } },
  );
  assert.deepEqual(
    readJson(path.join(fixture.projectRoot, "mcp-container-groups.json")),
    { groups: { ux: ["demo-mcp-user", "other-mcp"] } },
  );
  assert.deepEqual(
    loadOAuthRecord("demo-mcp-user", {
      projectRoot: fixture.projectRoot,
      userDataPath: fixture.userDataPath,
      safeStorage,
    }),
    oauthRecord,
  );
  assert.equal(
    loadOAuthRecord("demo-mcp", {
      projectRoot: fixture.projectRoot,
      userDataPath: fixture.userDataPath,
      safeStorage,
    }),
    null,
  );
  const registry = loadBridgeAuthRegistry({
    userDataPath: fixture.userDataPath,
  });
  assert.equal(
    registry.tokens.find((entry) => entry.clientId === bridgeClientId).revoked,
    true,
  );
  assert.equal(
    fs.existsSync(getBridgeClientTokenPath(fixture.userDataPath, bridgeClientId)),
    false,
  );
  assert.equal(discoverCollisions(fixture.projectRoot).length, 0);
});

test("collision migration suffixes a target ID reserved by existing state", (t) => {
  const fixture = createFixture(t, {
    extraToggles: { "demo-mcp-user": false },
  });
  const result = runMigration(fixture);
  assert.equal(result.migrations[0].targetId, "demo-mcp-user-2");
  assert.equal(
    fs.existsSync(
      path.join(
        fixture.projectRoot,
        "mcp-configs-user",
        "demo-mcp-user-2",
        "demo-mcp-user-2.yaml",
      ),
    ),
    true,
  );
  assert.deepEqual(
    readJson(path.join(fixture.projectRoot, "mcp_toggles.json")),
    {
      "demo-mcp": false,
      "demo-mcp-user": false,
      "demo-mcp-user-2": true,
    },
  );
});

test("collision migration isolates an incomplete bundle without inventing config", (t) => {
  const fixture = createFixture(t, {
    withYaml: false,
    fragment: "not valid json\n",
  });
  runMigration(fixture);
  const targetDir = path.join(
    fixture.projectRoot,
    "mcp-configs-user",
    "demo-mcp-user",
  );
  assert.equal(
    fs.existsSync(path.join(targetDir, "demo-mcp-user.yaml")),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(targetDir, "demo-mcp-user.fragment"), "utf8"),
    "not valid json\n",
  );
  assert.equal(fs.existsSync(fixture.userDir), false);
});

test("collision migration resumes the same target after target creation", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      runMigration(fixture, {
        onPhase(phase) {
          if (phase === "after_target_created") {
            throw new Error("injected interruption");
          }
        },
      }),
    /injected interruption/,
  );
  assert.equal(fs.existsSync(fixture.userDir), true);
  assert.equal(
    fs.existsSync(
      path.join(fixture.projectRoot, "mcp-configs-user", "demo-mcp-user"),
    ),
    true,
  );

  const result = runMigration(fixture);
  assert.equal(result.migrations[0].targetId, "demo-mcp-user");
  assert.equal(result.migrations[0].resumed, true);
  assert.equal(fs.existsSync(fixture.userDir), false);
});

test("collision migration resumes after the toggle commit point", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      runMigration(fixture, {
        onPhase(phase) {
          if (phase === "after_toggle_commit") {
            throw new Error("injected post-commit interruption");
          }
        },
      }),
    /post-commit interruption/,
  );
  assert.equal(fs.existsSync(fixture.userDir), true);
  assert.deepEqual(
    readJson(path.join(fixture.projectRoot, "mcp_toggles.json")),
    { "demo-mcp": false, "demo-mcp-user": true },
  );

  const result = runMigration(fixture);
  assert.equal(result.migrations[0].resumed, true);
  assert.equal(fs.existsSync(fixture.userDir), false);
});

test("completed migration allocates a new suffix when the collision reappears", (t) => {
  const fixture = createFixture(t);
  runMigration(fixture);
  const firstTarget = path.join(
    fixture.projectRoot,
    "mcp-configs-user",
    "demo-mcp-user",
  );
  fs.appendFileSync(path.join(firstTarget, "setup.md"), "user edit\n");

  fs.mkdirSync(fixture.userDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.userDir, "demo-mcp.yaml"),
    'id: "demo-mcp"\nname: Reinstalled custom copy\n',
  );
  fs.writeFileSync(
    path.join(fixture.userDir, "demo-mcp.fragment"),
    '{"url":"https://second.example/mcp"}\n',
  );
  writeJson(path.join(fixture.projectRoot, "mcp_toggles.json"), {
    "demo-mcp": true,
    "demo-mcp-user": false,
  });

  const result = runMigration(fixture);
  assert.equal(result.migrations[0].targetId, "demo-mcp-user-2");
  assert.match(
    fs.readFileSync(
      path.join(
        fixture.projectRoot,
        "mcp-configs-user",
        "demo-mcp-user-2",
        "demo-mcp-user-2.yaml",
      ),
      "utf8",
    ),
    /Reinstalled custom copy/,
  );
  assert.match(
    fs.readFileSync(path.join(firstTarget, "setup.md"), "utf8"),
    /user edit/,
  );
});

test("a corrupt completed target marker is preserved and skipped", (t) => {
  const fixture = createFixture(t);
  runMigration(fixture);
  const firstTarget = path.join(
    fixture.projectRoot,
    "mcp-configs-user",
    "demo-mcp-user",
  );
  fs.writeFileSync(path.join(firstTarget, MIGRATION_MARKER_FILE), "{broken\n");
  fs.mkdirSync(fixture.userDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.userDir, "demo-mcp.yaml"),
    'id: "demo-mcp"\nname: Another copy\n',
  );
  writeJson(path.join(fixture.projectRoot, "mcp_toggles.json"), {
    "demo-mcp": true,
    "demo-mcp-user": false,
  });

  const result = runMigration(fixture);
  assert.equal(result.migrations[0].targetId, "demo-mcp-user-2");
  assert.equal(
    fs.readFileSync(path.join(firstTarget, MIGRATION_MARKER_FILE), "utf8"),
    "{broken\n",
  );
});

test("post-retirement interruption finalizes and cleans up on restart", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      runMigration(fixture, {
        onPhase(phase) {
          if (phase === "after_source_retired") {
            throw new Error("injected retirement interruption");
          }
        },
      }),
    /retirement interruption/,
  );
  assert.equal(fs.existsSync(fixture.userDir), false);
  const targetDir = path.join(
    fixture.projectRoot,
    "mcp-configs-user",
    "demo-mcp-user",
  );
  assert.equal(
    readJson(path.join(targetDir, MIGRATION_MARKER_FILE)).completed,
    true,
  );

  const result = runMigration(fixture);
  assert.equal(result.migrated, 0);
  const retiredEntries = fs
    .readdirSync(path.join(fixture.projectRoot, "mcp-configs-user"))
    .filter((name) => name.startsWith(".portico-user-collision-retired-"));
  assert.deepEqual(retiredEntries, []);
});

test("YAML ID rewrite stays inside an existing document start", () => {
  assert.equal(
    rewriteCanonicalYaml(
      Buffer.from("---\nname: Custom MCP\n", "utf8"),
      "custom-mcp-user",
    ).toString("utf8"),
    '---\nid: "custom-mcp-user"\nname: Custom MCP\n',
  );
});

test("collision migration fails closed on invalid toggle state", (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(
    path.join(fixture.projectRoot, "mcp_toggles.json"),
    "{invalid\n",
  );
  assert.throws(
    () => runMigration(fixture),
    /mcp_toggles.json is invalid/,
  );
  assert.equal(fs.existsSync(fixture.userDir), true);
  assert.equal(
    fs.existsSync(
      path.join(fixture.projectRoot, "mcp-configs-user", "demo-mcp-user"),
    ),
    false,
  );
});

test("collision migration rejects symbolic links without changing the source", (t) => {
  const fixture = createFixture(t);
  fs.symlinkSync(
    path.join(fixture.userDir, "setup.md"),
    path.join(fixture.userDir, "linked-setup.md"),
  );
  assert.throws(
    () => runMigration(fixture),
    /symbolic link/,
  );
  assert.equal(fs.existsSync(fixture.userDir), true);
  assert.equal(
    fs.existsSync(
      path.join(fixture.projectRoot, "mcp-configs-user", "demo-mcp-user"),
    ),
    false,
  );
});

test("startup wiring runs collision migration before Docker and fails closed", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const migrationCall = mainSource.indexOf("migrateUserMcpCollisions({");
  const dockerCall = mainSource.indexOf("const dockerReady = await ensureDockerRunning()", migrationCall);
  assert.ok(migrationCall > 0);
  assert.ok(dockerCall > migrationCall);
  const guardedBlock = mainSource.slice(migrationCall, dockerCall);
  assert.match(guardedBlock, /loading-error/);
  assert.match(guardedBlock, /stopInitLogging\(\);\s*return;/);
});

test("runtime resolvers reserve bundled MCP directories on incomplete collisions", () => {
  const dockerSource = fs.readFileSync(path.join(__dirname, "docker-mcp.js"), "utf8");
  const hostSource = fs.readFileSync(path.join(__dirname, "host-mcpo-runtime.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  assert.match(
    dockerSource,
    /if \(fs\.existsSync\(systemDir\)\) \{\s*return fs\.existsSync\(systemPath\) \? systemPath : null;/,
  );
  assert.match(
    hostSource,
    /if \(fs\.existsSync\(systemServerDir\)\) \{\s*return fs\.existsSync\(systemYaml\) \? systemYaml : null;/,
  );
  assert.match(ipcSource, /systemServerIds\.add\(entry\.name\)/);
});
