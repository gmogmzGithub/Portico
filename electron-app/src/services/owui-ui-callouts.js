// Host-persisted impression counters for one-time/limited OWUI UI callouts
// (e.g. the reviewer-workflow CTA tooltip shows at most 3 times per user).
// Stored in Application Support (userData). Reads are deliberately graceful:
// a missing or corrupt file yields zeroed counters — the callout shows.
const fs = require("node:fs");
const path = require("node:path");

const OWUI_UI_CALLOUTS_FILENAME = "owui-ui-callouts.json";
const OWUI_UI_CALLOUTS_SCHEMA_VERSION = 1;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCounters(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const counters = {};
  for (const [key, value] of Object.entries(raw)) {
    const count = Number.parseInt(value, 10);
    if (isNonEmptyString(key) && Number.isFinite(count) && count > 0) {
      counters[key.trim()] = count;
    }
  }
  return counters;
}

function defaultOwuiUiCallouts() {
  return {
    schemaVersion: OWUI_UI_CALLOUTS_SCHEMA_VERSION,
    counters: {},
    updatedAt: null,
  };
}

function getOwuiUiCalloutsPath(userDataPath) {
  return path.join(userDataPath, OWUI_UI_CALLOUTS_FILENAME);
}

function readOwuiUiCallouts({ userDataPath }) {
  if (!isNonEmptyString(userDataPath)) {
    return {
      success: false,
      exists: false,
      path: null,
      error: "userDataPath is required",
      data: defaultOwuiUiCallouts(),
    };
  }

  const calloutsPath = getOwuiUiCalloutsPath(userDataPath);
  if (!fs.existsSync(calloutsPath)) {
    return {
      success: true,
      exists: false,
      path: calloutsPath,
      data: defaultOwuiUiCallouts(),
      parseError: null,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(calloutsPath, "utf8"));
    const schemaVersion = Number.parseInt(raw?.schemaVersion, 10);
    if (schemaVersion !== OWUI_UI_CALLOUTS_SCHEMA_VERSION) {
      return {
        success: true,
        exists: true,
        path: calloutsPath,
        data: defaultOwuiUiCallouts(),
        parseError: `unsupported OWUI UI callouts schemaVersion: ${raw?.schemaVersion ?? "missing"}`,
      };
    }
    return {
      success: true,
      exists: true,
      path: calloutsPath,
      data: {
        schemaVersion: OWUI_UI_CALLOUTS_SCHEMA_VERSION,
        counters: normalizeCounters(raw.counters),
        updatedAt: isNonEmptyString(raw.updatedAt) ? raw.updatedAt.trim() : null,
      },
      parseError: null,
    };
  } catch (error) {
    return {
      success: true,
      exists: true,
      path: calloutsPath,
      data: defaultOwuiUiCallouts(),
      parseError: error.message,
    };
  }
}

function getOwuiUiCalloutImpressions({ userDataPath, key }) {
  if (!isNonEmptyString(key)) {
    return 0;
  }
  const result = readOwuiUiCallouts({ userDataPath });
  return result.data.counters[key.trim()] ?? 0;
}

function incrementOwuiUiCalloutCounter({ userDataPath, key }) {
  if (!isNonEmptyString(userDataPath)) {
    return { success: false, error: "userDataPath is required", impressions: 0 };
  }
  if (!isNonEmptyString(key)) {
    return { success: false, error: "key is required", impressions: 0 };
  }

  const normalizedKey = key.trim();
  const current = readOwuiUiCallouts({ userDataPath });
  const counters = { ...current.data.counters };
  counters[normalizedKey] = (counters[normalizedKey] ?? 0) + 1;

  const calloutsPath = getOwuiUiCalloutsPath(userDataPath);
  const data = {
    schemaVersion: OWUI_UI_CALLOUTS_SCHEMA_VERSION,
    counters,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(calloutsPath), { recursive: true });
  fs.writeFileSync(calloutsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  return { success: true, path: calloutsPath, impressions: counters[normalizedKey] };
}

module.exports = {
  OWUI_UI_CALLOUTS_FILENAME,
  OWUI_UI_CALLOUTS_SCHEMA_VERSION,
  defaultOwuiUiCallouts,
  getOwuiUiCalloutsPath,
  readOwuiUiCallouts,
  getOwuiUiCalloutImpressions,
  incrementOwuiUiCalloutCounter,
};
