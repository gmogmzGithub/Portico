const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BRIDGE_LOGREPO_TYPE,
  buildBridgeErrorTelemetry,
  buildBridgeLogRepoPayload,
  buildClipFormBody,
  emitBridgeClientResultEvents,
  emitBridgeLogRepoEvent,
  summarizeBridgeClientInventory,
  summarizeBridgeClientResults,
} = require("./host-mcp-bridge-telemetry");

function fieldsFromBody(body) {
  return Object.fromEntries(new URLSearchParams(body.toString()).entries());
}

test("bridge telemetry payload is stable, token-shaped, and redacted", () => {
  const payload = buildBridgeLogRepoPayload(
    "Bridge Enable Completed",
    {
      outcome: "Success Value",
      request_source: "API Status",
      caller: "setup-community/run-mcp-servers",
      runtime_path: "portico_app",
      script_action: "Enable Bridge",
      bridge_ready: true,
      configured_client_ids: ["cursor", "workbench", "workbench"],
      selected_client_count: 2,
      token: "do-not-log",
      config_path: "/Users/person/.workbench/config.toml",
      bridge_url: "http://127.0.0.1:8891/mcp",
      error: "raw error should not be logged",
    },
    {
      appVersion: "9.8.7",
      env: {
        PORTICO_USER_ID: "ggomez",
        USER: "local-os-user",
        portico_RELEASE_CHANNEL: "pre beta",
      },
      machineName: "portico-test-machine",
      now: "2026-06-24T12:00:00.000Z",
    },
  );

  assert.equal(payload.schema_version, "1");
  assert.equal(payload.event_name, "bridge_enable_completed");
  assert.equal(payload.outcome, "success_value");
  assert.equal(payload.request_source, "api_status");
  assert.equal(payload.caller, "setup-community_run-mcp-servers");
  assert.equal(payload.runtime_path, "portico_app");
  assert.equal(payload.script_action, "enable_bridge");
  assert.equal(payload.bridge_ready, "true");
  assert.equal(payload.configured_client_ids, "workbench,cursor");
  assert.equal(payload.selected_client_count, "2");
  assert.equal(payload.app_version, "9.8.7");
  assert.equal(payload.build_channel, "pre_beta");
  assert.equal(payload.ldap, "ggomez");
  assert.equal(payload.ts, "2026-06-24T12:00:00.000Z");
  assert.equal(payload.machine_hash.length, 16);
  assert.notEqual(payload.machine_hash, "portico-test-machine");
  assert.equal(payload.token, undefined);
  assert.equal(payload.config_path, undefined);
  assert.equal(payload.bridge_url, undefined);
  assert.equal(payload.error, undefined);
});

test("bridge telemetry CLIP body keeps type first", () => {
  const body = buildClipFormBody({
    schema_version: "1",
    event_name: "bridge_status_checked",
    outcome: "success",
  });

  assert.ok(body.toString().startsWith(`type=${BRIDGE_LOGREPO_TYPE}&`));
  assert.ok(body.toString().endsWith("&&"));
  assert.deepEqual(fieldsFromBody(body), {
    type: BRIDGE_LOGREPO_TYPE,
    schema_version: "1",
    event_name: "bridge_status_checked",
    outcome: "success",
  });
});

test("bridge telemetry emitter posts urlencoded form without throwing", async () => {
  const requests = [];
  const result = await emitBridgeLogRepoEvent(
    "bridge_status_checked",
    {
      outcome: "success",
      request_source: "api_status",
      caller: "setup-community",
      bridge_ready: true,
    },
    {
      env: {
        USER: "ggomez",
        portico_MCP_BRIDGE_LOGREPO_URL: "https://logrepo.example.test/logrepo",
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200 };
      },
      timeoutMs: 10,
      now: "2026-06-24T12:00:00.000Z",
      machineName: "machine",
    },
  );

  assert.equal(result.emitted, true);
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://logrepo.example.test/logrepo");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(
    requests[0].options.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const fields = fieldsFromBody(requests[0].options.body);
  assert.equal(fields.type, BRIDGE_LOGREPO_TYPE);
  assert.equal(fields.event_name, "bridge_status_checked");
  assert.equal(fields.bridge_ready, "true");
});

test("bridge telemetry honors disabled mode", async () => {
  let called = false;
  const result = await emitBridgeLogRepoEvent(
    "bridge_status_checked",
    { outcome: "success" },
    {
      env: { portico_MCP_BRIDGE_LOGREPO_DISABLED: "true" },
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200 };
      },
    },
  );

  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test("bridge telemetry summarizes inventory and per-client results", async () => {
  assert.deepEqual(
    summarizeBridgeClientInventory([
      { id: "workbench", detected: true, configured: true },
      { id: "cursor", detected: true, configured: false },
      { id: "amp", detected: false, configured: false, status: "config_unreadable" },
      { id: "atlas-code", detected: true, configured: false, status: "config_error" },
    ]),
    {
      supported_client_count: 4,
      detected_client_count: 3,
      configured_client_count: 1,
      config_unreadable_client_count: 2,
      detected_client_ids: ["workbench", "cursor", "atlas-code"],
      configured_client_ids: ["workbench"],
    },
  );

  assert.deepEqual(
    summarizeBridgeClientResults([
      { clientId: "workbench", success: true, restartRequired: true },
      { clientId: "cursor", success: false, error: "EACCES" },
    ]),
    {
      selected_client_ids: ["workbench", "cursor"],
      succeeded_client_ids: ["workbench"],
      failed_client_ids: ["cursor"],
      selected_client_count: 2,
      succeeded_client_count: 1,
      failed_client_count: 1,
      restart_required_client_count: 1,
      removed_client_count: 0,
      revoked_client_count: 0,
    },
  );

  const requests = [];
  await emitBridgeClientResultEvents(
    "client_configure",
    [
      { clientId: "workbench", success: true, restartRequired: true },
      { clientId: "cursor", success: false, error: "EACCES" },
    ],
    {
      request_source: "portico_ui",
      caller: "portico_ui",
      request_id: "abc",
    },
    {
      env: { portico_MCP_BRIDGE_LOGREPO_URL: "https://logrepo.example.test/logrepo" },
      fetchImpl: async (url, options) => {
        requests.push(fieldsFromBody(options.body));
        return { ok: true, status: 200 };
      },
      timeoutMs: 10,
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].event_name, "client_configure_completed");
  assert.equal(requests[0].event_scope, "client");
  assert.equal(requests[0].client_id, "workbench");
  assert.equal(requests[0].restart_required, "true");
  assert.equal(requests[1].event_name, "client_configure_failed");
  assert.equal(requests[1].client_id, "cursor");
  assert.equal(requests[1].error_category, "permission_denied");
  assert.match(requests[1].error_message_hash, /^[a-f0-9]{16}$/);
});

test("bridge telemetry classifies bridge health errors", () => {
  assert.deepEqual(
    buildBridgeErrorTelemetry("Host MCP Bridge did not become healthy"),
    {
      error_category: "bridge_health_timeout",
      error_message_hash: buildBridgeErrorTelemetry("Host MCP Bridge did not become healthy").error_message_hash,
    },
  );
});
