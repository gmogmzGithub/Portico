const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("request payload persistence and filesystem consumption stay disabled", () => {
  const reporting = read("src/bifrost-bridge-rust/src/reporting.rs");
  const bridgeMain = read("src/bifrost-bridge-rust/src/main.rs");
  const reportingProduction = reporting.split("#[cfg(test)]")[0];
  const monitorServer = read("llm-debug-monitor/backend/server.py");
  const monitorCompose = read("dev/docker-compose.debug-monitor.yml");
  const rawHeaderConsumers = [
    "llm-debug-monitor/backend/models.py",
    "llm-debug-monitor/backend/redis_subscriber.py",
    "llm-debug-monitor/src/types/events.ts",
    "llm-debug-monitor/src/types/llm.ts",
    "llm-debug-monitor/src/store/eventStore.ts",
    "llm-debug-monitor/src/components/RequestInspector/RequestInspector.tsx",
  ];
  const safeConsistencyRunners = [
    "src/scripts/run_gpt_56_qualification.py",
    "src/scripts/run_gemini_vertex_chat_consistency.py",
    "src/scripts/run_opus_5_reasoning_chat_consistency.py",
    "src/scripts/run_opus_48_prompt_cache_chat_consistency.py",
  ];

  assert.doesNotMatch(reporting, /write_request_payload_event/);
  assert.doesNotMatch(reporting, /providerHeadersRaw|providerHeadersRedacted/);
  assert.doesNotMatch(
    reportingProduction,
    /create_dir_all\([^\n]*payloads|write\([^\n]*payloads/,
  );
  assert.doesNotMatch(bridgeMain, /write_request_payload_event/);

  assert.doesNotMatch(monitorServer, /payload_watcher/);
  assert.doesNotMatch(monitorServer, /REPORTING_DIR|read_text\(/);
  assert.match(
    monitorServer,
    /if event_type == "llm_request_transformed":[\s\S]*?return False/,
  );
  assert.match(monitorServer, /data\.pop\("provider_headers_raw", None\)/);
  assert.match(monitorServer, /data\.pop\("providerHeadersRaw", None\)/);
  for (const relativePath of rawHeaderConsumers) {
    assert.doesNotMatch(
      read(relativePath),
      /provider_headers_raw|providerHeadersRaw/,
      `${relativePath} must not retain raw provider-header support`,
    );
  }
  for (const relativePath of safeConsistencyRunners) {
    assert.doesNotMatch(
      read(relativePath),
      /transformed_payloads|provider_headers_raw|providerHeadersRaw/,
      `${relativePath} must not depend on sensitive request capture`,
    );
  }
  assert.doesNotMatch(monitorCompose, /\/app\/reporting|REPORTING_DIR/);
});

test("legacy cleanup runs before all fallible bridge configuration", () => {
  const bridgeMain = read("src/bifrost-bridge-rust/src/main.rs");
  const tracingInit = bridgeMain.indexOf(".init();");
  const cleanup = bridgeMain.indexOf(
    "reporting::remove_legacy_request_payloads(reporting_dir)",
  );
  const configPath = bridgeMain.indexOf("let config_path =");
  const catalog = bridgeMain.indexOf("let catalog = load_catalog");

  assert.ok(tracingInit >= 0);
  assert.ok(cleanup > tracingInit);
  assert.ok(configPath > cleanup);
  assert.ok(catalog > cleanup);
});


test("host cleanup runs before launch gates and repeats after gateway shutdown", () => {
  const electronMain = read("electron-app/src/services/main.js");
  const whenReady = electronMain.indexOf(".whenReady()");
  const earlyCleanup = electronMain.indexOf(
    "await cleanupLegacyRequestPayloadsFromKnownRoots();",
    whenReady,
  );
  const protocol = electronMain.indexOf("installAppProtocol({", whenReady);
  const architectureGate = electronMain.indexOf(
    "enforcePackagedMacArchitectureMatch({",
    whenReady,
  );
  const loadingWindow = electronMain.indexOf("createLoadingWindow();", whenReady);
  const stop = electronMain.indexOf(
    '["stop"],',
    electronMain.indexOf("STOP SERVICES FIRST"),
  );
  const postStopCleanup = electronMain.indexOf(
    "await cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots();",
    stop,
  );

  assert.ok(whenReady >= 0);
  assert.ok(earlyCleanup > whenReady);
  assert.ok(protocol > earlyCleanup);
  assert.ok(architectureGate > earlyCleanup);
  assert.ok(loadingWindow > earlyCleanup);
  assert.ok(stop >= 0);
  assert.ok(postStopCleanup > stop);
  assert.doesNotMatch(electronMain, /ensureHostMcpBridgeRunning/);
});

test("Jupiter startup keeps exact-build container recreation enabled", () => {
  const electronMain = read("electron-app/src/services/main.js");
  const compose = read("src/scripts/docker-compose.sh");

  assert.match(
    electronMain,
    /Smart startup check DISABLED - always performing full restart/,
  );
  assert.match(
    electronMain,
    /reasons: \["Smart startup temporarily disabled"\]/,
  );
  assert.match(compose, /FORCE_RECREATE="--force-recreate"/);
  assert.match(
    compose,
    /Packaged runtime requires Harbor images for build \$build_number; aborting/,
  );
});
