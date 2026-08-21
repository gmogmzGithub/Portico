const fs = require("node:fs");
const path = require("node:path");

const OWUI_SIDEBAR_PREFERENCES_FILENAME = "owui-sidebar-preferences.json";
const OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION = 1;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeNormalWindowSidebarOpen(value) {
  if (value === true || value === false) {
    return value;
  }

  return null;
}

function defaultOwuiSidebarPreferences() {
  return {
    schemaVersion: OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
    normalWindowSidebarOpen: null,
    updatedAt: null,
  };
}

function getOwuiSidebarPreferencesPath(userDataPath) {
  return path.join(userDataPath, OWUI_SIDEBAR_PREFERENCES_FILENAME);
}

function normalizeOwuiSidebarPreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      error: "OWUI sidebar preferences must be a JSON object",
    };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported OWUI sidebar preferences schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  return {
    success: true,
    data: {
      schemaVersion: OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
      normalWindowSidebarOpen: normalizeNormalWindowSidebarOpen(
        raw.normalWindowSidebarOpen,
      ),
      updatedAt: isNonEmptyString(raw.updatedAt) ? raw.updatedAt.trim() : null,
    },
  };
}

function readOwuiSidebarPreferences({ userDataPath }) {
  if (!isNonEmptyString(userDataPath)) {
    return {
      success: false,
      exists: false,
      path: null,
      error: "userDataPath is required",
      data: defaultOwuiSidebarPreferences(),
    };
  }

  const preferencesPath = getOwuiSidebarPreferencesPath(userDataPath);
  if (!fs.existsSync(preferencesPath)) {
    return {
      success: true,
      exists: false,
      path: preferencesPath,
      data: defaultOwuiSidebarPreferences(),
      parseError: null,
    };
  }

  try {
    const normalized = normalizeOwuiSidebarPreferences(
      JSON.parse(fs.readFileSync(preferencesPath, "utf8")),
    );
    if (!normalized.success) {
      return {
        success: true,
        exists: true,
        path: preferencesPath,
        data: defaultOwuiSidebarPreferences(),
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
      data: defaultOwuiSidebarPreferences(),
      parseError: error.message,
    };
  }
}

function saveOwuiSidebarPreferences({
  userDataPath,
  normalWindowSidebarOpen = null,
}) {
  if (!isNonEmptyString(userDataPath)) {
    return { success: false, error: "userDataPath is required", path: null };
  }

  const normalizedSidebarOpen = normalizeNormalWindowSidebarOpen(
    normalWindowSidebarOpen,
  );
  if (
    normalWindowSidebarOpen !== null &&
    normalizedSidebarOpen === null
  ) {
    return {
      success: false,
      error: "normalWindowSidebarOpen must be true, false, or null",
      path: getOwuiSidebarPreferencesPath(userDataPath),
    };
  }

  const preferencesPath = getOwuiSidebarPreferencesPath(userDataPath);
  const data = {
    schemaVersion: OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
    normalWindowSidebarOpen: normalizedSidebarOpen,
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
  OWUI_SIDEBAR_PREFERENCES_FILENAME,
  OWUI_SIDEBAR_PREFERENCES_SCHEMA_VERSION,
  defaultOwuiSidebarPreferences,
  getOwuiSidebarPreferencesPath,
  normalizeOwuiSidebarPreferences,
  readOwuiSidebarPreferences,
  saveOwuiSidebarPreferences,
};
