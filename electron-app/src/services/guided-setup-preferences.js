const fs = require("node:fs");
const path = require("node:path");

const GUIDED_SETUP_PREFERENCES_FILENAME = "guided-setup-preferences.json";
const GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION = 1;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOnboardingMode(value) {
  return value === "basic" || value === "power" ? value : null;
}

function defaultGuidedSetupPreferences() {
  return {
    schemaVersion: GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
    onboardingMode: null,
    updatedAt: null,
  };
}

function getGuidedSetupPreferencesPath(userDataPath) {
  return path.join(userDataPath, GUIDED_SETUP_PREFERENCES_FILENAME);
}

function normalizeGuidedSetupPreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      error: "guided setup preferences must be a JSON object",
    };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported guided setup preferences schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  return {
    success: true,
    data: {
      schemaVersion: GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
      onboardingMode: normalizeOnboardingMode(raw.onboardingMode),
      updatedAt: isNonEmptyString(raw.updatedAt) ? raw.updatedAt.trim() : null,
    },
  };
}

function readGuidedSetupPreferences({ userDataPath }) {
  if (!isNonEmptyString(userDataPath)) {
    return {
      success: false,
      exists: false,
      path: null,
      error: "userDataPath is required",
      data: defaultGuidedSetupPreferences(),
    };
  }

  const preferencesPath = getGuidedSetupPreferencesPath(userDataPath);
  if (!fs.existsSync(preferencesPath)) {
    return {
      success: true,
      exists: false,
      path: preferencesPath,
      data: defaultGuidedSetupPreferences(),
      parseError: null,
    };
  }

  try {
    const normalized = normalizeGuidedSetupPreferences(
      JSON.parse(fs.readFileSync(preferencesPath, "utf8")),
    );
    if (!normalized.success) {
      return {
        success: true,
        exists: true,
        path: preferencesPath,
        data: defaultGuidedSetupPreferences(),
        parseError: normalized.error,
      };
    }

    return {
      success: true,
      exists: true,
      path: preferencesPath,
      data: normalized.data,
      parseError: null,
    };
  } catch (error) {
    return {
      success: true,
      exists: true,
      path: preferencesPath,
      data: defaultGuidedSetupPreferences(),
      parseError: error.message,
    };
  }
}

function saveGuidedSetupPreferences({ userDataPath, onboardingMode }) {
  if (!isNonEmptyString(userDataPath)) {
    return { success: false, error: "userDataPath is required", path: null };
  }

  const normalizedMode = normalizeOnboardingMode(onboardingMode);
  if (onboardingMode !== null && normalizedMode === null) {
    return {
      success: false,
      error: "onboardingMode must be 'basic', 'power', or null",
      path: getGuidedSetupPreferencesPath(userDataPath),
    };
  }

  const preferencesPath = getGuidedSetupPreferencesPath(userDataPath);
  const data = {
    schemaVersion: GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
    onboardingMode: normalizedMode,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.writeFileSync(preferencesPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  return {
    success: true,
    path: preferencesPath,
    data,
  };
}

module.exports = {
  GUIDED_SETUP_PREFERENCES_FILENAME,
  GUIDED_SETUP_PREFERENCES_SCHEMA_VERSION,
  defaultGuidedSetupPreferences,
  getGuidedSetupPreferencesPath,
  normalizeGuidedSetupPreferences,
  readGuidedSetupPreferences,
  saveGuidedSetupPreferences,
};
