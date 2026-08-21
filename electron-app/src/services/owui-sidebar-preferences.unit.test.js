const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OWUI_SIDEBAR_PREFERENCES_FILENAME,
  OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
  defaultOwuiSidebarPreferences,
  getOwuiSidebarPreferencesPath,
  normalizeOwuiSidebarPreferences,
  readOwuiSidebarPreferences,
  saveOwuiSidebarPreferences,
} = require("./owui-sidebar-preferences");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "owui-sidebar-preferences-"));
}

test("missing OWUI sidebar preferences file falls back to defaults", () => {
  const root = makeTempDir();
  const result = readOwuiSidebarPreferences({ userDataPath: root });

  assert.equal(result.success, true);
  assert.equal(result.exists, false);
  assert.equal(result.parseError, null);
  assert.equal(result.data.normalWindowSidebarOpen, null);
  assert.equal(
    result.path,
    path.join(root, OWUI_SIDEBAR_PREFERENCES_FILENAME),
  );
});

test("OWUI sidebar preferences round-trip true and false", () => {
  const root = makeTempDir();

  const openSaveResult = saveOwuiSidebarPreferences({
    userDataPath: root,
    normalWindowSidebarOpen: true,
  });
  assert.equal(openSaveResult.success, true);
  assert.equal(openSaveResult.data.normalWindowSidebarOpen, true);

  const openReadResult = readOwuiSidebarPreferences({ userDataPath: root });
  assert.equal(openReadResult.success, true);
  assert.equal(openReadResult.exists, true);
  assert.equal(openReadResult.parseError, null);
  assert.equal(openReadResult.data.normalWindowSidebarOpen, true);

  const closedSaveResult = saveOwuiSidebarPreferences({
    userDataPath: root,
    normalWindowSidebarOpen: false,
  });
  assert.equal(closedSaveResult.success, true);
  assert.equal(closedSaveResult.data.normalWindowSidebarOpen, false);

  const closedReadResult = readOwuiSidebarPreferences({ userDataPath: root });
  assert.equal(closedReadResult.success, true);
  assert.equal(closedReadResult.exists, true);
  assert.equal(closedReadResult.parseError, null);
  assert.equal(closedReadResult.data.normalWindowSidebarOpen, false);
  assert.match(closedReadResult.data.updatedAt, /\d{4}-\d{2}-\d{2}T/);
});

test("invalid OWUI sidebar preferences JSON falls back safely", () => {
  const root = makeTempDir();
  const preferencesPath = path.join(root, OWUI_SIDEBAR_PREFERENCES_FILENAME);
  fs.writeFileSync(preferencesPath, "{broken-json", "utf8");

  const result = readOwuiSidebarPreferences({ userDataPath: root });
  assert.equal(result.success, true);
  assert.equal(result.exists, true);
  assert.deepEqual(result.data, defaultOwuiSidebarPreferences());
  assert.match(result.parseError, /Unexpected token|Expected property name/);
});

test("unsupported OWUI sidebar preferences content falls back to defaults with a parse error", () => {
  const root = makeTempDir();
  const preferencesPath = path.join(root, OWUI_SIDEBAR_PREFERENCES_FILENAME);
  fs.writeFileSync(
    preferencesPath,
    JSON.stringify({
      schemaVersion: 999,
      normalWindowSidebarOpen: true,
    }),
    "utf8",
  );

  const result = readOwuiSidebarPreferences({ userDataPath: root });
  assert.equal(result.success, true);
  assert.equal(result.exists, true);
  assert.deepEqual(result.data, defaultOwuiSidebarPreferences());
  assert.equal(
    result.parseError,
    "unsupported OWUI sidebar preferences schemaVersion: 999",
  );
});

test("OWUI sidebar preferences helpers normalize supported data and reject malformed payloads", () => {
  assert.deepEqual(defaultOwuiSidebarPreferences(), {
    schemaVersion: OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
    normalWindowSidebarOpen: null,
    updatedAt: null,
  });

  assert.equal(
    getOwuiSidebarPreferencesPath("/tmp/preferences-root"),
    "/tmp/preferences-root/owui-sidebar-preferences.json",
  );

  assert.deepEqual(
    normalizeOwuiSidebarPreferences({
      schemaVersion: "1",
      normalWindowSidebarOpen: false,
      updatedAt: " 2026-04-08T16:00:00.000Z ",
    }),
    {
      success: true,
      data: {
        schemaVersion: OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
        normalWindowSidebarOpen: false,
        updatedAt: "2026-04-08T16:00:00.000Z",
      },
    },
  );

  assert.deepEqual(normalizeOwuiSidebarPreferences(null), {
    success: false,
    error: "OWUI sidebar preferences must be a JSON object",
  });
  assert.deepEqual(normalizeOwuiSidebarPreferences([]), {
    success: false,
    error: "OWUI sidebar preferences must be a JSON object",
  });
  assert.deepEqual(
    normalizeOwuiSidebarPreferences({
      schemaVersion: 2,
      normalWindowSidebarOpen: true,
    }),
    {
      success: false,
      error: "unsupported OWUI sidebar preferences schemaVersion: 2",
    },
  );
});

test("OWUI sidebar preferences guard invalid inputs when reading or saving", () => {
  const missingPathResult = readOwuiSidebarPreferences({ userDataPath: "" });
  assert.equal(missingPathResult.success, false);
  assert.equal(missingPathResult.exists, false);
  assert.equal(missingPathResult.path, null);
  assert.equal(missingPathResult.error, "userDataPath is required");
  assert.deepEqual(missingPathResult.data, defaultOwuiSidebarPreferences());

  const invalidSaveResult = saveOwuiSidebarPreferences({
    userDataPath: "/tmp/preferences-root",
    normalWindowSidebarOpen: "open",
  });
  assert.equal(invalidSaveResult.success, false);
  assert.equal(
    invalidSaveResult.error,
    "normalWindowSidebarOpen must be true, false, or null",
  );
  assert.equal(
    invalidSaveResult.path,
    "/tmp/preferences-root/owui-sidebar-preferences.json",
  );

  const missingSavePath = saveOwuiSidebarPreferences({
    userDataPath: null,
    normalWindowSidebarOpen: null,
  });
  assert.deepEqual(missingSavePath, {
    success: false,
    error: "userDataPath is required",
    path: null,
  });
});
