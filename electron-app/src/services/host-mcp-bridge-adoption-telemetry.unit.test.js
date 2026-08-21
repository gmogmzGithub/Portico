const test = require("node:test");
const assert = require("node:assert/strict");

const {
  emitAppLaunched,
  maybeEmitAppActiveDaily,
  resetDailyActiveCacheForTests,
} = require("./host-mcp-bridge-adoption-telemetry");

function testOptions(events, files = new Map()) {
  return {
    appRef: { isPackaged: true, getPath: () => "/test/user-data" },
    getIdentity: async () => ({ ldap: "ggomez", identitySource: "okta_cached" }),
    readPreferences: () => ({ data: { enabled: false } }),
    emitEvent: async (name, fields) => {
      events.push({ name, fields });
      return { emitted: true };
    },
    fsRef: {
      readFileSync: (filename) => {
        if (!files.has(filename)) throw new Error("missing");
        return files.get(filename);
      },
      writeFileSync: (filename, contents) => files.set(filename, contents),
    },
  };
}

test("app launch event supplies the active-user denominator and bridge preference", async () => {
  const events = [];
  await emitAppLaunched(testOptions(events));

  assert.deepEqual(events, [
    {
      name: "app_launched",
      fields: {
        outcome: "success",
        request_source: "lifecycle",
        caller: "portico_lifecycle",
        event_scope: "app",
        runtime_path: "portico_app",
        ldap: "ggomez",
        identity_source: "okta_cached",
        bridge_enabled: false,
        is_packaged: true,
      },
    },
  ]);
});

test("daily active event emits once per local day across repeated health cycles", async () => {
  resetDailyActiveCacheForTests();
  const events = [];
  const options = testOptions(events);

  await maybeEmitAppActiveDaily({ ...options, now: new Date(2026, 7, 12, 12, 0) });
  await maybeEmitAppActiveDaily({ ...options, now: new Date(2026, 7, 12, 20, 0) });

  assert.equal(events.length, 1);
  assert.equal(events[0].name, "app_active_daily");
  assert.equal(events[0].fields.ldap, "ggomez");
  assert.equal(events[0].fields.bridge_enabled, false);
});

test("daily active event emits once when health cycles overlap", async () => {
  resetDailyActiveCacheForTests();
  const events = [];
  const options = testOptions(events);
  let releaseEmission;
  const emissionGate = new Promise((resolve) => {
    releaseEmission = resolve;
  });
  options.emitEvent = async (name, fields) => {
    events.push({ name, fields });
    await emissionGate;
    return { emitted: true };
  };

  const cycles = [
    maybeEmitAppActiveDaily({ ...options, now: new Date(2026, 7, 12, 12, 0, 0) }),
    maybeEmitAppActiveDaily({ ...options, now: new Date(2026, 7, 12, 12, 0, 1) }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  releaseEmission();
  const results = await Promise.all(cycles);

  assert.equal(events.length, 1);
  assert.equal(results.filter((result) => result.emitted === true).length, 1);
});

test("daily active event retries after delivery failure before marking the day", async () => {
  resetDailyActiveCacheForTests();
  const events = [];
  const files = new Map();
  const options = testOptions(events, files);
  let attempts = 0;
  options.emitEvent = async (name, fields) => {
    events.push({ name, fields });
    attempts += 1;
    return { emitted: attempts > 1 };
  };

  await maybeEmitAppActiveDaily({ ...options, now: "2026-08-12T12:00:00-06:00" });
  assert.equal(files.size, 0);
  await maybeEmitAppActiveDaily({ ...options, now: "2026-08-12T12:01:00-06:00" });

  assert.equal(events.length, 2);
  assert.equal(files.size, 1);
});
