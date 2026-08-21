const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GUIDED_SETUP_PREFERENCES_FILENAME,
  GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
  defaultGuidedSetupPreferences,
  getGuidedSetupPreferencesPath,
  normalizeGuidedSetupPreferences,
  readGuidedSetupPreferences,
  saveGuidedSetupPreferences,
} = require("./guided-setup-preferences");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "guided-setup-preferences-"));
}

test("missing guided setup preferences file falls back to defaults", () => {
  const root = makeTempDir();
  const result = readGuidedSetupPreferences({ userDataPath: root });

  assert.equal(result.success, true);
  assert.equal(result.exists, false);
  assert.equal(result.parseError, null);
  assert.equal(result.data.onboardingMode, null);
  assert.equal(
    result.path,
    path.join(root, GUIDED_SETUP_PREFERENCES_FILENAME),
  );
});

test("guided setup preferences round-trip the saved onboarding mode", () => {
  const root = makeTempDir();
  const saveResult = saveGuidedSetupPreferences({
    userDataPath: root,
    onboardingMode: "basic",
  });

  assert.equal(saveResult.success, true);
  assert.equal(saveResult.data.onboardingMode, "basic");

  const result = readGuidedSetupPreferences({ userDataPath: root });
  assert.equal(result.success, true);
  assert.equal(result.exists, true);
  assert.equal(result.parseError, null);
  assert.equal(result.data.onboardingMode, "basic");
  assert.match(result.data.updatedAt, /\d{4}-\d{2}-\d{2}T/);
});

test("invalid guided setup preferences JSON falls back safely", () => {
  const root = makeTempDir();
  const preferencesPath = path.join(root, GUIDED_SETUP_PREFERENCES_FILENAME);
  fs.writeFileSync(preferencesPath, "{broken-json", "utf8");

  const result = readGuidedSetupPreferences({ userDataPath: root });
  assert.equal(result.success, true);
  assert.equal(result.exists, true);
  assert.equal(result.data.onboardingMode, null);
  assert.match(result.parseError, /Unexpected token|Expected property name/);
});

test("guided setup preferences helpers normalize supported data and reject malformed payloads", () => {
  assert.deepEqual(defaultGuidedSetupPreferences(), {
    schemaVersion: GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
    onboardingMode: null,
    updatedAt: null,
  });

  assert.equal(
    getGuidedSetupPreferencesPath("/tmp/preferences-root"),
    "/tmp/preferences-root/guided-setup-preferences.json",
  );

  assert.deepEqual(
    normalizeGuidedSetupPreferences({
      schemaVersion: "1",
      onboardingMode: "power",
      updatedAt: " 2026-03-13T12:00:00.000Z ",
    }),
    {
      success: true,
      data: {
        schemaVersion: GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
        onboardingMode: "power",
        updatedAt: "2026-03-13T12:00:00.000Z",
      },
    },
  );

  assert.deepEqual(normalizeGuidedSetupPreferences(null), {
    success: false,
    error: "guided setup preferences must be a JSON object",
  });
  assert.deepEqual(normalizeGuidedSetupPreferences([]), {
    success: false,
    error: "guided setup preferences must be a JSON object",
  });
  assert.deepEqual(
    normalizeGuidedSetupPreferences({
      schemaVersion: 2,
      onboardingMode: "power",
    }),
    {
      success: false,
      error: "unsupported guided setup preferences schemaVersion: 2",
    },
  );
});

test("guided setup preferences guard invalid inputs when reading or saving", () => {
  const missingPathResult = readGuidedSetupPreferences({ userDataPath: "" });
  assert.equal(missingPathResult.success, false);
  assert.equal(missingPathResult.exists, false);
  assert.equal(missingPathResult.path, null);
  assert.equal(missingPathResult.error, "userDataPath is required");
  assert.deepEqual(missingPathResult.data, defaultGuidedSetupPreferences());

  const invalidModeResult = saveGuidedSetupPreferences({
    userDataPath: "/tmp/preferences-root",
    onboardingMode: "invalid-mode",
  });
  assert.equal(invalidModeResult.success, false);
  assert.equal(
    invalidModeResult.error,
    "onboardingMode must be 'basic', 'power', or null",
  );
  assert.equal(
    invalidModeResult.path,
    "/tmp/preferences-root/guided-setup-preferences.json",
  );

  const missingSavePath = saveGuidedSetupPreferences({
    userDataPath: null,
    onboardingMode: null,
  });
  assert.deepEqual(missingSavePath, {
    success: false,
    error: "userDataPath is required",
    path: null,
  });
});

test("unsupported guided setup preferences content falls back to defaults with a parse error", () => {
  const root = makeTempDir();
  const preferencesPath = path.join(root, GUIDED_SETUP_PREFERENCES_FILENAME);
  fs.writeFileSync(
    preferencesPath,
    JSON.stringify({
      schemaVersion: 999,
      onboardingMode: "basic",
    }),
    "utf8",
  );

  const result = readGuidedSetupPreferences({ userDataPath: root });
  assert.equal(result.success, true);
  assert.equal(result.exists, true);
  assert.deepEqual(result.data, defaultGuidedSetupPreferences());
  assert.equal(
    result.parseError,
    "unsupported guided setup preferences schemaVersion: 999",
  );
});
