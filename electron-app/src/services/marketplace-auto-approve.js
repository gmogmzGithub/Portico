const fs = require("node:fs");
const path = require("node:path");

// Dev-build-only auto-approval of AGENTIC marketplace publish/unpublish
// confirmation modals. The stored boolean is clamped to false on both write
// and read unless isDevBuild === true, so a packaged build can never resolve
// true — not even from a hand-edited preferences file.
const MARKETPLACE_AUTO_APPROVE_FILENAME = "marketplace-auto-approve.json";
const MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION = 1;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultMarketplaceAutoApprovePreferences() {
  return {
    schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
    autoApprove: false,
    updatedAt: null,
  };
}

function getMarketplaceAutoApprovePath(userDataPath) {
  return path.join(userDataPath, MARKETPLACE_AUTO_APPROVE_FILENAME);
}

function normalizeMarketplaceAutoApprovePreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      error: "marketplace auto-approve preferences must be a JSON object",
    };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported marketplace auto-approve schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  return {
    success: true,
    data: {
      schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
      autoApprove: raw.autoApprove === true,
      updatedAt: isNonEmptyString(raw.updatedAt) ? raw.updatedAt.trim() : null,
    },
  };
}

function readMarketplaceAutoApprovePreferences({ userDataPath }) {
  if (!isNonEmptyString(userDataPath)) {
    return {
      success: false,
      exists: false,
      path: null,
      error: "userDataPath is required",
      data: defaultMarketplaceAutoApprovePreferences(),
    };
  }

  const preferencesPath = getMarketplaceAutoApprovePath(userDataPath);
  if (!fs.existsSync(preferencesPath)) {
    return {
      success: true,
      exists: false,
      path: preferencesPath,
      data: defaultMarketplaceAutoApprovePreferences(),
      parseError: null,
    };
  }

  try {
    const normalized = normalizeMarketplaceAutoApprovePreferences(
      JSON.parse(fs.readFileSync(preferencesPath, "utf8")),
    );
    if (!normalized.success) {
      return {
        success: true,
        exists: true,
        path: preferencesPath,
        data: defaultMarketplaceAutoApprovePreferences(),
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
      data: defaultMarketplaceAutoApprovePreferences(),
      parseError: error.message,
    };
  }
}

// Write clamp: a non-dev build can only ever persist false.
function saveMarketplaceAutoApprovePreferences({
  userDataPath,
  autoApprove = false,
  isDevBuild = false,
}) {
  if (!isNonEmptyString(userDataPath)) {
    return { success: false, error: "userDataPath is required", path: null };
  }

  const preferencesPath = getMarketplaceAutoApprovePath(userDataPath);
  const data = {
    schemaVersion: MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
    autoApprove: isDevBuild === true && autoApprove === true,
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

// Read clamp: non-dev builds resolve false before any file IO, so packaged
// builds pay no disk read and a hand-edited `true` can never leak through.
function resolveMarketplaceAutoApprove({ userDataPath, isDevBuild }) {
  if (isDevBuild !== true) {
    return false;
  }
  return (
    readMarketplaceAutoApprovePreferences({ userDataPath }).data.autoApprove ===
    true
  );
}

module.exports = {
  MARKETPLACE_AUTO_APPROVE_FILENAME,
  MARKETPLACE_AUTO_APPROVE_SCHEMA_VERSION,
  defaultMarketplaceAutoApprovePreferences,
  getMarketplaceAutoApprovePath,
  normalizeMarketplaceAutoApprovePreferences,
  readMarketplaceAutoApprovePreferences,
  saveMarketplaceAutoApprovePreferences,
  resolveMarketplaceAutoApprove,
};
