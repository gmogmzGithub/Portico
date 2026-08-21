const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  applyToggleMutation,
  applyToggleMutationToPath,
  buildMcpToggleSnapshot,
  computeMcpToggleRevision,
  loadRawMcpTogglesFromPath,
  normalizeMcpToggleSourceAtPath,
  normalizeToggleValue,
  sanitizeToggleMap,
  writeMcpTogglesAtomicToPath,
} = require("./mcp-toggle-store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toggle-store-"));
}

test("normalizeToggleValue accepts boolean-compatible values and rejects invalid ones", () => {
  assert.equal(normalizeToggleValue(true), true);
  assert.equal(normalizeToggleValue(false), false);
  assert.equal(normalizeToggleValue("true"), true);
  assert.equal(normalizeToggleValue("false"), false);
  assert.equal(normalizeToggleValue("yes"), null);
  assert.equal(normalizeToggleValue(1), null);
});

test("sanitizeToggleMap strips invalid toggle values", () => {
  assert.deepEqual(
    sanitizeToggleMap({
      validTrue: true,
      validFalse: false,
      stringTrue: "true",
      stringFalse: "false",
      invalid: "maybe",
    }),
    {
      validTrue: true,
      validFalse: false,
      stringTrue: true,
      stringFalse: false,
    },
  );
});

test("loadRawMcpTogglesFromPath treats malformed files as empty and records parse metadata", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.writeFileSync(togglesPath, "{not-json", "utf8");

  const warnings = [];
  const result = loadRawMcpTogglesFromPath(togglesPath, {
    includeMeta: true,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(result.toggles, {});
  assert.equal(result.exists, true);
  assert.ok(result.parseError instanceof Error);
  assert.equal(result.togglesPath, togglesPath);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to parse mcp_toggles\.json/);
});

test("writeMcpTogglesAtomicToPath persists sanitized toggles", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");

  const persisted = writeMcpTogglesAtomicToPath(
    togglesPath,
    { keep: true, drop: "maybe", alsoKeep: "false" },
    { reason: "unit-test" },
  );

  assert.deepEqual(persisted.toggles, { keep: true, alsoKeep: false });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(togglesPath, "utf8")),
    { keep: true, alsoKeep: false },
  );
});

test("normalizeMcpToggleSourceAtPath converts string booleans and writes a revisioned snapshot", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  const snapshotPath = path.join(tempDir, "health-status", "mcp_toggles_snapshot.json");
  fs.writeFileSync(
    togglesPath,
    JSON.stringify({ slack: "true", snowflake: "false", invalid: "maybe" }),
    "utf8",
  );

  const warnings = [];
  const result = normalizeMcpToggleSourceAtPath(togglesPath, {
    snapshotPath,
    reason: "unit-test",
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "normalized");
  assert.deepEqual(result.droppedKeys, ["invalid"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(togglesPath, "utf8")), {
    slack: true,
    snowflake: false,
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, result.revision);
  assert.deepEqual(snapshot.toggles, { slack: true, snowflake: false });
  assert.match(warnings[0], /Normalized mcp_toggles\.json/);
});

test("normalizeMcpToggleSourceAtPath backs up malformed toggle files and repairs to empty map", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  const snapshotPath = path.join(tempDir, "health-status", "mcp_toggles_snapshot.json");
  fs.writeFileSync(togglesPath, "{not-json", "utf8");

  const warnings = [];
  const result = normalizeMcpToggleSourceAtPath(togglesPath, {
    snapshotPath,
    reason: "unit-test",
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });
  const backupEntry = fs
    .readdirSync(tempDir)
    .find((entry) => entry.startsWith("mcp_toggles.json.invalid-backup-"));
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "parse_error");
  assert.ok(backupEntry, "expected malformed toggle file to be backed up");
  assert.equal(fs.readFileSync(path.join(tempDir, backupEntry), "utf8"), "{not-json");
  assert.deepEqual(JSON.parse(fs.readFileSync(togglesPath, "utf8")), {});
  assert.deepEqual(snapshot.toggles, {});
  assert.equal(snapshot.revision, result.revision);
  assert.match(warnings.join("\n"), /Backed up invalid mcp_toggles\.json/);
});

test("normalizeMcpToggleSourceAtPath creates missing toggle files and snapshots", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  const snapshotPath = path.join(tempDir, "health-status", "mcp_toggles_snapshot.json");

  const result = normalizeMcpToggleSourceAtPath(togglesPath, {
    snapshotPath,
    reason: "unit-test",
    logger: { warn() {} },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "missing");
  assert.deepEqual(JSON.parse(fs.readFileSync(togglesPath, "utf8")), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath, "utf8")).toggles, {});
});

test("toggle revision is canonical and independent of object key order", () => {
  assert.equal(
    computeMcpToggleRevision({ slack: true, snowflake: false }),
    computeMcpToggleRevision({ snowflake: false, slack: true }),
  );
  assert.notEqual(
    computeMcpToggleRevision({ slack: true }),
    computeMcpToggleRevision({ slack: false }),
  );
});

test("atomic toggle writes publish a revisioned directory-mounted snapshot", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  const snapshotPath = path.join(
    tempDir,
    "health-status",
    "mcp_toggles_snapshot.json",
  );
  const persisted = writeMcpTogglesAtomicToPath(
    togglesPath,
    { snowflake: true, slack: false },
    { snapshotPath },
  );
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, persisted.revision);
  assert.deepEqual(snapshot.toggles, { slack: false, snowflake: true });
  assert.deepEqual(
    buildMcpToggleSnapshot({ snowflake: true, slack: false }).toggles,
    snapshot.toggles,
  );
});

test("writeMcpTogglesAtomicToPath renames a directory target aside before persisting", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.mkdirSync(togglesPath, { recursive: true });
  fs.writeFileSync(path.join(togglesPath, "old.txt"), "keep", "utf8");

  const warnings = [];
  const persisted = writeMcpTogglesAtomicToPath(
    togglesPath,
    { keep: true, alsoKeep: "false" },
    {
      reason: "unit-test",
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  const entries = fs.readdirSync(tempDir);
  const backupEntry = entries.find((entry) =>
    entry.startsWith("mcp_toggles.json.dir-backup-"),
  );

  assert.deepEqual(persisted.toggles, { keep: true, alsoKeep: false });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(togglesPath, "utf8")),
    { keep: true, alsoKeep: false },
  );
  assert.ok(backupEntry, "expected the original toggles directory to be renamed aside");
  assert.equal(
    fs.readFileSync(path.join(tempDir, backupEntry, "old.txt"), "utf8"),
    "keep",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Found directory at .*mcp_toggles\.json; renamed it to/);
});

test("applyToggleMutation recovers from parse errors and persists the requested mutation", async () => {
  const warnings = [];
  const result = await applyToggleMutation(
    {
      toggles: {},
      parseError: new Error("bad json"),
      togglesPath: "/tmp/mcp_toggles.json",
    },
    async (draft) => {
      draft.time = false;
      draft.glean = true;
      return "mutated";
    },
    {
      reason: "toggle-disable",
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
      writeToggles(draft) {
        return {
          toggles: { ...draft },
          togglesPath: "/tmp/mcp_toggles.json",
        };
      },
    },
  );

  assert.equal(result.recoveredFromParseError, true);
  assert.equal(result.mutationResult, "mutated");
  assert.deepEqual(result.toggles, { time: false, glean: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Recovering from invalid mcp_toggles\.json/);
});

test("applyToggleMutation validates its inputs", async () => {
  await assert.rejects(
    () => applyToggleMutation(null, async () => undefined, { writeToggles() {} }),
    /rawToggleState \(object\) is required/,
  );
  await assert.rejects(
    () => applyToggleMutation({}, null, { writeToggles() {} }),
    /mutator \(function\) is required/,
  );
  await assert.rejects(
    () => applyToggleMutation({}, async () => undefined, {}),
    /writeToggles \(function\) is required/,
  );
});

test("applyToggleMutationToPath recovers from malformed toggle files and persists atomically", async () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.writeFileSync(togglesPath, "{broken-json", "utf8");

  const warnings = [];
  const result = await applyToggleMutationToPath(
    togglesPath,
    async (draft) => {
      draft.sourcegraph = true;
      draft.slack = false;
    },
    {
      reason: "restart-server",
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  assert.equal(result.recoveredFromParseError, true);
  assert.deepEqual(result.toggles, {
    sourcegraph: true,
    slack: false,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(togglesPath, "utf8")),
    {
      sourcegraph: true,
      slack: false,
    },
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Failed to parse mcp_toggles\.json/);
  assert.match(warnings[1], /Recovering from invalid mcp_toggles\.json/);
});

test("applyToggleMutationToPath recovers from directory-backed toggle paths", async () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.mkdirSync(togglesPath, { recursive: true });
  fs.writeFileSync(path.join(togglesPath, "old.txt"), "keep", "utf8");

  const warnings = [];
  const result = await applyToggleMutationToPath(
    togglesPath,
    async (draft) => {
      draft.sourcegraph = true;
    },
    {
      reason: "guided-setup",
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  );

  const backupEntry = fs
    .readdirSync(tempDir)
    .find((entry) => entry.startsWith("mcp_toggles.json.dir-backup-"));

  assert.equal(result.recoveredFromParseError, true);
  assert.deepEqual(result.toggles, { sourcegraph: true });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(togglesPath, "utf8")),
    { sourcegraph: true },
  );
  assert.ok(backupEntry, "expected the original toggles directory to be renamed aside");
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /Failed to parse mcp_toggles\.json/);
  assert.match(warnings[1], /Recovering from invalid mcp_toggles\.json/);
  assert.match(warnings[2], /Found directory at .*mcp_toggles\.json; renamed it to/);
});

test("writeMcpTogglesAtomicToPath surfaces a clear error when a directory target cannot be renamed aside", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.mkdirSync(togglesPath, { recursive: true });

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (sourcePath, targetPath) => {
    if (sourcePath === togglesPath) {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(sourcePath, targetPath);
  };

  try {
    assert.throws(
      () =>
        writeMcpTogglesAtomicToPath(togglesPath, { keep: true }, { reason: "unit-test" }),
      /mcp_toggles\.json is a directory and could not be renamed aside: permission denied/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
});

test("applyToggleMutationToPath validates togglesPath", async () => {
  await assert.rejects(
    () => applyToggleMutationToPath(null, async () => undefined),
    /togglesPath \(string\) is required/,
  );
});

test("applyToggleMutationToPath can fail closed on malformed toggle state", async () => {
  const dir = makeTempDir();
  const togglesPath = path.join(dir, "mcp_toggles.json");
  fs.writeFileSync(togglesPath, "{not-json", "utf8");

  try {
    await assert.rejects(
      () =>
        applyToggleMutationToPath(
          togglesPath,
          async (draft) => {
            draft.glean = true;
          },
          { recoverFromParseError: false, logger: { warn() {} } },
        ),
      (error) => error.code === "MCP_TOGGLES_PARSE_ERROR",
    );
    assert.equal(fs.readFileSync(togglesPath, "utf8"), "{not-json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// PORTICO-364: a blank / whitespace-only file is "no toggles set", not corruption.
// It must heal to {} with NO parseError, so reads and mutations recover (a
// 0-byte mcp_toggles.json otherwise dead-ends every enable).
test("loadRawMcpTogglesFromPath treats a blank file as an empty map (no parse error)", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.writeFileSync(togglesPath, "", "utf8"); // 0-byte file (the incident flavor)

  const result = loadRawMcpTogglesFromPath(togglesPath, { includeMeta: true });

  assert.deepEqual(result.toggles, {});
  assert.equal(result.exists, true);
  assert.equal(result.parseError, null);
});

test("loadRawMcpTogglesFromPath treats a whitespace-only file as an empty map", () => {
  const tempDir = makeTempDir();
  const togglesPath = path.join(tempDir, "mcp_toggles.json");
  fs.writeFileSync(togglesPath, "\n  \t\n", "utf8");

  const result = loadRawMcpTogglesFromPath(togglesPath, { includeMeta: true });

  assert.deepEqual(result.toggles, {});
  assert.equal(result.parseError, null);
});

// The enable/guided-setup mutation paths must self-heal a malformed file rather
// than dead-end (PORTICO-364 — Dionny: "self-heal whenever mcp_toggles.json is
// malformed"). Lock the two coordinator/ipc call sites to recoverFromParseError.
test("MCP toggle mutation call sites self-heal from a parse error (PORTICO-364)", () => {
  const coordinatorSrc = fs.readFileSync(
    path.join(__dirname, "mcp-operation-coordinator.js"), "utf8");
  const ipcSrc = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  assert.match(
    coordinatorSrc,
    /reason: `mcp-operation:\$\{operationId\}:\$\{kind\}`,[\s\S]{0,240}recoverFromParseError: true,/,
  );
  assert.match(
    ipcSrc,
    /reason: "guided-setup-explicit-toggle-changes",[\s\S]{0,240}recoverFromParseError: true,/,
  );
  assert.doesNotMatch(coordinatorSrc, /recoverFromParseError: false/);
});
