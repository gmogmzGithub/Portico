const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  discoverServerYamlPaths,
  ensureMcpCreateDirs,
  expandCreateDirPath,
  tryEnsureMcpCreateDirs,
} = require("./mcp-create-dirs");

function makeTempRoot(prefix = "mcp-create-dirs-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeServerYaml(projectRoot, rootName, serverId, content) {
  const serverDir = path.join(projectRoot, rootName, serverId);
  fs.mkdirSync(serverDir, { recursive: true });
  const yamlPath = path.join(serverDir, `${serverId}.yaml`);
  fs.writeFileSync(yamlPath, content, "utf8");
  return yamlPath;
}

function createLogger() {
  return {
    logs: [],
    warnings: [],
    log(message) {
      this.logs.push(message);
    },
    warn(message) {
      this.warnings.push(message);
    },
  };
}

test("ensureMcpCreateDirs creates missing home directories recursively and accepts existing directories", () => {
  const projectRoot = makeTempRoot();
  const homeDir = makeTempRoot("mcp-create-dirs-home-");
  const existingDir = path.join(projectRoot, "already", "there");
  fs.mkdirSync(existingDir, { recursive: true });
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "snowflake",
    [
      "id: snowflake",
      "create_dirs:",
      "  - ~/.snowflake/",
      `  - ${existingDir}`,
      "",
    ].join("\n"),
  );

  const logger = createLogger();
  const result = ensureMcpCreateDirs(projectRoot, { homeDir, logger });

  assert.equal(fs.statSync(path.join(homeDir, ".snowflake")).isDirectory(), true);
  assert.equal(fs.statSync(existingDir).isDirectory(), true);
  assert.equal(result.ensuredDirs.length, 2);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, []);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("ensureMcpCreateDirs scans system and user MCP configs and deduplicates directories", () => {
  const projectRoot = makeTempRoot();
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "system-server",
    "id: system-server\ncreate_dirs:\n  - shared-cache\n",
  );
  writeServerYaml(
    projectRoot,
    "mcp-configs-user",
    "user-server",
    "id: user-server\ncreate_dirs:\n  - shared-cache\n  - user-cache\n",
  );
  const mkdirCalls = [];
  const fsModule = {
    ...fs,
    mkdirSync(dirPath, options) {
      mkdirCalls.push(dirPath);
      return fs.mkdirSync(dirPath, options);
    },
  };

  const result = ensureMcpCreateDirs(projectRoot, {
    fsModule,
    logger: createLogger(),
  });

  assert.deepEqual(
    new Set(result.ensuredDirs),
    new Set([
      path.join(projectRoot, "shared-cache"),
      path.join(projectRoot, "user-cache"),
    ]),
  );
  assert.equal(mkdirCalls.length, 2);
  assert.equal(fs.statSync(path.join(projectRoot, "shared-cache")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(projectRoot, "user-cache")).isDirectory(), true);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("ensureMcpCreateDirs logs and skips malformed create_dirs entries without blocking startup", () => {
  const projectRoot = makeTempRoot();
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "bad-list",
    "id: bad-list\ncreate_dirs: ./not-a-list\n",
  );
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "bad-entry",
    [
      "id: bad-entry",
      "create_dirs:",
      "  - ''",
      "  - 123",
      "  - ~other/cache",
      "  - valid-cache",
      "",
    ].join("\n"),
  );
  const logger = createLogger();

  const result = ensureMcpCreateDirs(projectRoot, { logger });

  assert.equal(fs.statSync(path.join(projectRoot, "valid-cache")).isDirectory(), true);
  assert.equal(result.ensuredDirs.length, 1);
  assert.equal(result.skipped.length, 4);
  assert.equal(result.errors.length, 0);
  assert.equal(logger.warnings.length >= 4, true);

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("expandCreateDirPath resolves home, absolute, and project-relative paths", () => {
  const projectRoot = path.join(os.tmpdir(), "project-root");
  const homeDir = path.join(os.tmpdir(), "home-root");

  assert.equal(
    expandCreateDirPath(projectRoot, "~/.snowflake/", { homeDir }),
    path.join(homeDir, ".snowflake"),
  );
  assert.equal(
    expandCreateDirPath(projectRoot, "/tmp/example-cache", { homeDir }),
    path.resolve("/tmp/example-cache"),
  );
  assert.equal(
    expandCreateDirPath(projectRoot, "relative/cache", { homeDir }),
    path.join(projectRoot, "relative", "cache"),
  );
  assert.throws(
    () => expandCreateDirPath(projectRoot, "~other/cache", { homeDir }),
    /unsupported '~user' expansion/,
  );
});

test("discoverServerYamlPaths only returns matching server YAML files", () => {
  const projectRoot = makeTempRoot();
  const systemYaml = writeServerYaml(
    projectRoot,
    "mcp-configs",
    "system-server",
    "id: system-server\n",
  );
  const userYaml = writeServerYaml(
    projectRoot,
    "mcp-configs-user",
    "user-server",
    "id: user-server\n",
  );
  fs.mkdirSync(path.join(projectRoot, "mcp-configs", "missing-yaml"), {
    recursive: true,
  });

  assert.deepEqual(
    new Set(discoverServerYamlPaths(projectRoot)),
    new Set([systemYaml, userYaml]),
  );

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// The former "main startup wires MCP create_dirs..." test here was a banned
// source pin (AGENTS.md "Testing Rules — Source-Pin Assertions Are BANNED").
// Behavioral home: the tryEnsureMcpCreateDirs tests below cover the init-pass
// contract (re-ensure after deletion, never-throw, loading-screen gating) and
// mcp-orc-cli.test.js covers the before-every-generator-invocation hook. The
// one-line call sites in main.js (module load + start-initialization
// preamble) are wiring, verified live: delete ~/.snowflake -> Restart
// Services -> directory recreated.

test("tryEnsureMcpCreateDirs re-ensures a deleted create_dirs directory (Restart Services scenario)", () => {
  const projectRoot = makeTempRoot();
  const homeDir = makeTempRoot("mcp-create-dirs-home-");
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "snowflake",
    "id: snowflake\ncreate_dirs:\n  - ~/.snowflake/\n",
  );
  const logger = createLogger();
  const snowflakeDir = path.join(homeDir, ".snowflake");

  tryEnsureMcpCreateDirs(projectRoot, { homeDir, logger });
  assert.equal(fs.statSync(snowflakeDir).isDirectory(), true);

  // The user deletes the directory mid-session; the next init pass must
  // bring it back without touching the loading screen.
  fs.rmSync(snowflakeDir, { recursive: true, force: true });
  const initLogs = [];
  const result = tryEnsureMcpCreateDirs(projectRoot, {
    homeDir,
    logger,
    sendInitLog: (text, type) => initLogs.push({ text, type }),
  });

  assert.equal(fs.statSync(snowflakeDir).isDirectory(), true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(initLogs, []);

  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("tryEnsureMcpCreateDirs never throws and surfaces failures as a single loading-screen warning", () => {
  const logger = createLogger();
  const initLogs = [];
  const sendInitLog = (text, type) => initLogs.push({ text, type });

  const crashResult = tryEnsureMcpCreateDirs(undefined, {
    logger,
    sendInitLog,
  });

  assert.equal(crashResult.errors.length, 1);
  assert.equal(crashResult.ensuredDirs.length, 0);
  assert.equal(initLogs.length, 1);
  assert.equal(initLogs[0].type, "warning");
  assert.equal(logger.warnings.length, 1);

  const projectRoot = makeTempRoot();
  writeServerYaml(
    projectRoot,
    "mcp-configs",
    "srv",
    "id: srv\ncreate_dirs:\n  - cache\n",
  );
  const failingFs = {
    ...fs,
    mkdirSync() {
      throw new Error("EACCES: permission denied");
    },
  };
  initLogs.length = 0;

  const failResult = tryEnsureMcpCreateDirs(projectRoot, {
    logger,
    sendInitLog,
    fsModule: failingFs,
  });

  assert.equal(failResult.errors.length, 1);
  assert.equal(initLogs.length, 1);
  assert.equal(initLogs[0].type, "warning");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});
