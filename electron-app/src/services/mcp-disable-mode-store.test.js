const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  HARD_DISABLE_MODE,
  applyDisableModeMutationToPath,
  buildMcpDisableModeSnapshot,
  computeMcpDisableModeRevision,
  loadRawMcpDisableModesFromPath,
  normalizeMcpDisableModeSourceAtPath,
  normalizeDisableModeValue,
  sanitizeDisableModeMap,
  writeMcpDisableModesAtomicToPath,
} = require("./mcp-disable-mode-store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-disable-mode-store-"));
}

test("normalizeDisableModeValue keeps only the hard mode", () => {
  assert.equal(normalizeDisableModeValue("hard"), HARD_DISABLE_MODE);
  assert.equal(normalizeDisableModeValue(" HARD "), HARD_DISABLE_MODE);
  assert.equal(normalizeDisableModeValue("soft"), null);
  assert.equal(normalizeDisableModeValue(true), null);
  assert.equal(normalizeDisableModeValue(1), null);
  assert.equal(normalizeDisableModeValue(null), null);
});

test("sanitizeDisableModeMap drops invalid values instead of rejecting the map", () => {
  assert.deepEqual(
    sanitizeDisableModeMap({
      n8n: "hard",
      slack: "soft",
      gitlab: true,
      jira: "HARD",
    }),
    { n8n: "hard", jira: "hard" },
  );
});

test("loadRawMcpDisableModesFromPath fails open on malformed files", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(modesPath, "{not-json", "utf8");

  const warnings = [];
  const result = loadRawMcpDisableModesFromPath(modesPath, {
    includeMeta: true,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(result.modes, {});
  assert.equal(result.exists, true);
  assert.ok(result.parseError instanceof Error);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to parse mcp_disable_modes\.json/);
});

test("loadRawMcpDisableModesFromPath treats a blank file as an empty map without a parse error", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(modesPath, "   \n", "utf8");

  const result = loadRawMcpDisableModesFromPath(modesPath, { includeMeta: true });
  assert.deepEqual(result.modes, {});
  assert.equal(result.parseError, null);
});

test("loadRawMcpDisableModesFromPath keeps valid entries and drops invalid ones", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(
    modesPath,
    JSON.stringify({ n8n: "hard", slack: false, other: "sideways" }),
    "utf8",
  );

  const result = loadRawMcpDisableModesFromPath(modesPath);
  assert.deepEqual(result, { n8n: "hard" });
});

test("writeMcpDisableModesAtomicToPath persists sanitized modes and a revisioned snapshot", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  const snapshotPath = path.join(
    tempDir,
    "health-status",
    "mcp_disable_modes_snapshot.json",
  );

  const persisted = writeMcpDisableModesAtomicToPath(
    modesPath,
    { n8n: "hard", drop: "soft" },
    { reason: "unit-test", snapshotPath },
  );

  assert.deepEqual(persisted.modes, { n8n: "hard" });
  assert.deepEqual(JSON.parse(fs.readFileSync(modesPath, "utf8")), {
    n8n: "hard",
  });

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.modes, { n8n: "hard" });
  assert.equal(snapshot.revision, computeMcpDisableModeRevision({ n8n: "hard" }));
  assert.equal(persisted.revision, snapshot.revision);
});

test("buildMcpDisableModeSnapshot canonicalizes key order into the revision", () => {
  const a = buildMcpDisableModeSnapshot({ b: "hard", a: "hard" });
  const b = buildMcpDisableModeSnapshot({ a: "hard", b: "hard" });
  assert.equal(a.revision, b.revision);
  assert.deepEqual(Object.keys(a.modes), ["a", "b"]);
});

test("normalizeMcpDisableModeSourceAtPath creates a missing file as an empty map", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");

  const result = normalizeMcpDisableModeSourceAtPath(modesPath, {
    reason: "unit-test",
  });

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "missing");
  assert.deepEqual(JSON.parse(fs.readFileSync(modesPath, "utf8")), {});
});

test("normalizeMcpDisableModeSourceAtPath replaces a directory-shadowed file", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.mkdirSync(modesPath);

  const warnings = [];
  const result = normalizeMcpDisableModeSourceAtPath(modesPath, {
    reason: "unit-test",
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "directory");
  assert.ok(fs.statSync(modesPath).isFile());
  assert.ok(warnings.some((message) => /Directory found/.test(message)));
});

test("normalizeMcpDisableModeSourceAtPath drops invalid entries and reports them", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(
    modesPath,
    JSON.stringify({ keep: "hard", bad: 42, alsoBad: "soft" }),
    "utf8",
  );

  const result = normalizeMcpDisableModeSourceAtPath(modesPath, {
    reason: "unit-test",
    logger: { warn() {} },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "normalized");
  assert.deepEqual(result.droppedKeys.sort(), ["alsoBad", "bad"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(modesPath, "utf8")), {
    keep: "hard",
  });
});

test("normalizeMcpDisableModeSourceAtPath backs up an unreadable file before replacing it", () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(modesPath, "{definitely broken", "utf8");

  const result = normalizeMcpDisableModeSourceAtPath(modesPath, {
    reason: "unit-test",
    logger: { warn() {} },
  });

  assert.equal(result.repaired, true);
  assert.equal(result.repairReason, "parse_error");
  assert.ok(result.backupPath, "expected a backup path");
  assert.ok(fs.existsSync(result.backupPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(modesPath, "utf8")), {});
});

test("applyDisableModeMutationToPath sets and clears entries through the draft", async () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");

  const setResult = await applyDisableModeMutationToPath(
    modesPath,
    (draft) => {
      draft.n8n = "hard";
    },
    { reason: "unit-test" },
  );
  assert.deepEqual(setResult.modes, { n8n: "hard" });

  const clearResult = await applyDisableModeMutationToPath(
    modesPath,
    (draft) => {
      delete draft.n8n;
    },
    { reason: "unit-test" },
  );
  assert.deepEqual(clearResult.modes, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(modesPath, "utf8")), {});
});

test("applyDisableModeMutationToPath recovers from a corrupt existing file", async () => {
  const tempDir = makeTempDir();
  const modesPath = path.join(tempDir, "mcp_disable_modes.json");
  fs.writeFileSync(modesPath, "{broken", "utf8");

  const result = await applyDisableModeMutationToPath(
    modesPath,
    (draft) => {
      draft.n8n = "hard";
    },
    { reason: "unit-test", logger: { warn() {} } },
  );

  assert.equal(result.recoveredFromParseError, true);
  assert.deepEqual(result.modes, { n8n: "hard" });
});
