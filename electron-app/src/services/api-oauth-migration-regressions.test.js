const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");

function assertContainsInOrder(haystack, needles, message) {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(index, -1, `${message}: missing ${needle}`);
    assert.ok(index > cursor, `${message}: ${needle} is out of order`);
    cursor = index;
  }
}

test("OAuth broker attempts legacy migration before loading safeStorage records", () => {
  const recordRoute = source.slice(
    source.indexOf("apiApp.post('/api/mcp/oauth/record'"),
    source.indexOf("apiApp.post('/api/mcp/oauth/record/update'"),
  );
  assertContainsInOrder(
    recordRoute,
    [
      "serverId = normalizeBrokerServerId(req);",
      "const migration = migrateLegacyOAuthRecordIfNeeded(serverId);",
      "if (oauthMigrationRequiresReauth(migration))",
      "sendOAuthAuthRequired(res, serverId,",
      "const record = loadOAuthRecord(serverId,",
    ],
    "record broker must migrate and fail closed before loading",
  );

  const accessTokenRoute = source.slice(
    source.indexOf("apiApp.post('/api/mcp/oauth/access-token'"),
    source.indexOf("apiApp.post('/api/mcp/static-secret'"),
  );
  assertContainsInOrder(
    accessTokenRoute,
    [
      "const serverId = normalizeBrokerServerId(req);",
      "const migration = migrateLegacyOAuthRecordIfNeeded(serverId);",
      "if (oauthMigrationRequiresReauth(migration))",
      "sendOAuthAuthRequired(res, serverId,",
      "const record = loadOAuthRecord(serverId,",
    ],
    "access-token broker must migrate and fail closed before loading",
  );
});

test("OAuth broker exposes authenticated terminal-record invalidation", () => {
  const route = source.slice(
    source.indexOf("apiApp.post('/api/mcp/oauth/record/invalidate'"),
    source.indexOf("apiApp.post('/api/mcp/oauth/access-token'"),
  );
  assertContainsInOrder(
    route,
    [
      "if (!requireElectronBrokerAuth(req, res))",
      "serverId = normalizeBrokerServerId(req);",
      "invalidateSecureOAuthRecord(serverId,",
      'reason: "secure_oauth_record_requires_reauth"',
    ],
    "terminal OAuth invalidation must be authenticated, scoped, and durable",
  );
  assert.match(route, /oauth_terminal_refresh_failure/);
  assert.match(route, /oauth_client_identity_mismatch/);
  assert.match(route, /oauth_persistent_downstream_unauthorized/);
});

test("OAuth trigger attempts migration before non-destructive fresh-flow prepare without blocking terminal reauth", () => {
  const route = source.slice(
    source.indexOf("apiApp.post('/api/trigger-oauth-flow'"),
    source.indexOf("apiApp.post('/api/oauth/flow-result'"),
  );
  assertContainsInOrder(
    route,
    [
      "oauthMigration = migrateLegacyOAuthRecordIfNeeded(server_id);",
      "const tokenCheck = checkPersistedOAuthTokens(server_id,",
      "const clearResult = prepareFreshOAuthFlow(server_id);",
    ],
    "OAuth trigger must inspect legacy migration before starting a fresh flow",
  );
  assert.doesNotMatch(route, /OAUTH_MIGRATION_BLOCKED/);
  assert.doesNotMatch(source, /Legacy OAuth migration blocked/);
  assert.match(source, /function oauthMigrationRequiresReauth\(migration\)/);
  assert.match(source, /function sendOAuthAuthRequired\(res, serverId, details = \{\}\)/);
  assert.match(
    source,
    /function prepareFreshOAuthFlow\(serverId\) \{[\s\S]*clearLegacyOAuthFiles\(serverId,/,
  );
  assert.doesNotMatch(
    extractPrepareFreshOAuthFlow(source),
    /clearSecureOAuthRecord\(serverId,/,
  );
  assert.match(
    route,
    /if \(!hasStaticOAuthConfig\) \{[\s\S]*oauthMigration = migrateLegacyOAuthRecordIfNeeded\(server_id\);/,
  );
  assert.match(route, /oauthMigration\?\.imported && !forceAuth/);
  assertContainsInOrder(
    route,
    [
      "oauthMigration = migrateLegacyOAuthRecordIfNeeded(server_id);",
      "const recovery = await restartServerAndWaitReady(server_id,",
      "const clearResult = prepareFreshOAuthFlow(server_id);",
    ],
    "newly imported dynamic OAuth state must recover before fresh-flow cleanup",
  );
});

test("post-auth recovery waits for secure OAuth record visibility before hot reload", () => {
  const recovery = source.slice(
    source.indexOf("async function waitForPostOauthServerRecovery"),
    source.indexOf("async function restartServerAndWaitReady"),
  );

  assertContainsInOrder(
    recovery,
    [
      "const recordVisibility = await waitForOAuthRecordVisible(serverId);",
      "const reloadResult = await reloadOAuthTokens(serverId, deploymentType);",
      "OAuth hot-reload not available during post-auth recovery",
      "still recovering after OAuth",
    ],
    "post-auth recovery must wait for secure record visibility before reload/restart",
  );
  assert.match(
    source,
    /async function waitForOAuthRecordVisible\(serverId, options = \{\}\) \{[\s\S]*loadOAuthRecord\(serverId,[\s\S]*normalizeOAuthBrokerRecord\(record\);[\s\S]*visible: true/s,
  );
});

function extractPrepareFreshOAuthFlow(haystack) {
  const signature = "function prepareFreshOAuthFlow(serverId)";
  const start = haystack.indexOf(signature);
  assert.notEqual(start, -1, "expected prepareFreshOAuthFlow helper");
  const end = haystack.indexOf("function migrateLegacyOAuthRecordIfNeeded", start);
  assert.notEqual(end, -1, "expected next helper after prepareFreshOAuthFlow");
  return haystack.slice(start, end);
}
