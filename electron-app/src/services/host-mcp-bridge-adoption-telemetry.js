const fs = require("fs");
const path = require("path");

const { emitBridgeLogRepoEvent } = require("./host-mcp-bridge-telemetry");
const { getTelemetryIdentity } = require("./telemetry-identity");

const DAILY_MARKER_FILENAME = "host-mcp-bridge-telemetry-daily.json";

let lastEmittedDay;
const activeEmissionDays = new Set();

function localDay(now = new Date()) {
  return new Date(now).toLocaleDateString("en-CA");
}

function adoptionFields({ appRef, identity, preferences }) {
  return {
    outcome: "success",
    request_source: "lifecycle",
    caller: "portico_lifecycle",
    event_scope: "app",
    runtime_path: "portico_app",
    ldap: identity.ldap,
    identity_source: identity.identitySource,
    bridge_enabled: preferences?.enabled !== false,
    is_packaged: appRef?.isPackaged === true,
  };
}

async function emitAppLaunched(options = {}) {
  try {
    const identity = await (options.getIdentity || getTelemetryIdentity)();
    const preferences = (options.readPreferences || (() => ({ data: { enabled: true } })))()
      ?.data;
    return await (options.emitEvent || emitBridgeLogRepoEvent)(
      "app_launched",
      adoptionFields({ appRef: options.appRef, identity, preferences }),
    );
  } catch (_) {
    return { emitted: false, skipped: true };
  }
}

async function maybeEmitAppActiveDaily(options = {}) {
  try {
    const today = localDay(options.now || new Date());
    if (lastEmittedDay === today) {
      return { emitted: false, skipped: true, reason: "already_emitted" };
    }
    if (activeEmissionDays.has(today)) {
      return { emitted: false, skipped: true, reason: "emission_in_progress" };
    }

    const fsRef = options.fsRef || fs;
    const userDataPath = options.userDataPath || options.appRef?.getPath?.("userData");
    const markerPath = userDataPath
      ? path.join(userDataPath, DAILY_MARKER_FILENAME)
      : "";
    if (lastEmittedDay === undefined && markerPath) {
      try {
        lastEmittedDay = JSON.parse(fsRef.readFileSync(markerPath, "utf8")).lastEmittedDay;
      } catch (_) {
        lastEmittedDay = null;
      }
      if (lastEmittedDay === today) {
        return { emitted: false, skipped: true, reason: "already_emitted" };
      }
    }

    activeEmissionDays.add(today);
    try {
      const identity = await (options.getIdentity || getTelemetryIdentity)();
      const preferences = (options.readPreferences || (() => ({ data: { enabled: true } })))()
        ?.data;
      const result = await (options.emitEvent || emitBridgeLogRepoEvent)(
        "app_active_daily",
        adoptionFields({ appRef: options.appRef, identity, preferences }),
      );
      if (result?.emitted === true) {
        lastEmittedDay = today;
        if (markerPath) {
          try {
            fsRef.writeFileSync(markerPath, `${JSON.stringify({ lastEmittedDay: today })}\n`);
          } catch (_) {
            // The in-memory guard still prevents duplicates for this process.
          }
        }
      }
      return result;
    } finally {
      activeEmissionDays.delete(today);
    }
  } catch (_) {
    return { emitted: false, skipped: true };
  }
}

function resetDailyActiveCacheForTests() {
  lastEmittedDay = undefined;
  activeEmissionDays.clear();
}

module.exports = {
  DAILY_MARKER_FILENAME,
  emitAppLaunched,
  localDay,
  maybeEmitAppActiveDaily,
  resetDailyActiveCacheForTests,
};
