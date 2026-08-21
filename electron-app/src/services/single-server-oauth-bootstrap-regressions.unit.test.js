const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");

function sliceBetween(haystack, startNeedle, endNeedle, label) {
  const start = haystack.indexOf(startNeedle);
  assert.notEqual(start, -1, `${label}: missing ${startNeedle}`);
  const end = haystack.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `${label}: missing ${endNeedle} after ${startNeedle}`);
  return haystack.slice(start, end);
}

function assertContainsInOrder(haystack, needles, message) {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(index, -1, `${message}: missing ${needle}`);
    assert.ok(index > cursor, `${message}: ${needle} is out of order`);
    cursor = index;
  }
}

test("start-single-mcp-server requires an explicit OAuth mode and scopes bootstrap export to the session", () => {
  const handlerBody = sliceBetween(
    source,
    'ipcMain.handle("start-single-mcp-server"',
    '"stop-single-mcp-server"',
    "start-single-mcp-server handler",
  );

  assertContainsInOrder(
    handlerBody,
    [
      'oauthMode !== "existing-record" && oauthMode !== "bootstrap"',
      "cleanupOrphanedSingleServerStack({",
      "sessionId = crypto.randomUUID();",
      "singleServerSession = {",
      "singleServerBootstrap = null;",
      'oauthMode === "bootstrap"',
      "crypto.randomBytes(32).toString",
      'oauthMode === "bootstrap" ? " --oauth-bootstrap" : ""',
      "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN: oauthBootstrapExportToken,",
      "singleServerBootstrap = {",
      "sessionId,",
      "exportToken: oauthBootstrapExportToken,",
      "sessionEstablished = true;",
    ],
    "start handler must select the mode explicitly and bind bootstrap state to the session",
  );

  assert.ok(
    !handlerBody.includes("portico_OAUTH_ACCESS_TOKEN_BROKER_URL"),
    "Electron must rely on the normal enhanced environment for broker-mode credentials",
  );
});

test("poll-oauth-completion-single imports the captured record into safeStorage and fails closed", () => {
  const handlerBody = sliceBetween(
    source,
    '"poll-oauth-completion-single"',
    '"check-single-mcp-server"',
    "poll-oauth-completion-single handler",
  );

  assertContainsInOrder(
    handlerBody,
    [
      "if (completed) {",
      "const imported = await importBootstrapOAuthRecord(",
      "serverId,",
      "sessionId,",
      "if (!imported.success) {",
      // fail closed: do not report OAuth success if the credential wasn't saved
      "failed: true,",
      "OAuth completed but the credential could not be saved:",
      // only report success once imported
      "imported: true,",
    ],
    "completion path must import before reporting success and fail closed otherwise",
  );
});

test("importBootstrapOAuthRecord validates session, authenticates, persists, and is one-shot", () => {
  const fnBody = sliceBetween(
    source,
    "async function importBootstrapOAuthRecord(serverId, sessionId) {",
    "function normalizeGuidedSetupLogText(",
    "importBootstrapOAuthRecord helper",
  );

  // Reject when there is no matching bootstrap session for this server.
  assertContainsInOrder(
    fnBody,
    [
      "const session = singleServerBootstrap;",
      "session.serverId !== serverId",
      "session.sessionId !== sessionId",
      "reason: \"no_bootstrap_session\"",
    ],
    "import must require a matching bootstrap session",
  );

  // Authenticate to the guarded export endpoint with the one-time bearer.
  assertContainsInOrder(
    fnBody,
    [
      "/oauth/bootstrap-record/",
      'method: "POST"',
      "Authorization: `Bearer ${session.exportToken}`",
    ],
    "import must POST to the guarded export endpoint with the bearer",
  );

  // Retry transient 404s (token may lag the completed status).
  assert.ok(
    fnBody.includes("response.status === 404"),
    "import should retry while the record is not yet available",
  );

  // Validate the returned record before persisting.
  assertContainsInOrder(
    fnBody,
    [
      "payload?.server_id !== serverId",
      "payload?.token?.access_token",
      "payload?.client_info?.client_id",
      "persistOAuthRecord(",
      "projectRoot: bootstrap.PROJECT_ROOT",
    ],
    "import must validate the record and persist it to safeStorage",
  );

  // One-shot: drop the bearer after a successful import.
  assertContainsInOrder(
    fnBody,
    ["singleServerBootstrap = null;", "return { success: true };"],
    "import must clear the bootstrap session after success",
  );
});

test("persistOAuthRecord is imported for the bootstrap import path", () => {
  assert.ok(
    source.includes("persistOAuthRecord,"),
    "ipc.js must import persistOAuthRecord from oauth-token-storage",
  );
});

test("single-server stop, health, base URL, and OAuth operations reject stale sessions", () => {
  const stopHandler = sliceBetween(
    source,
    '"stop-single-mcp-server"',
    '"check-single-mcp-server"',
    "stop-single-mcp-server handler",
  );
  assertContainsInOrder(
    stopHandler,
    [
      "getOwnedSingleServerSession(sessionId, serverId)",
      "if (!session) {",
      "return staleSingleServerSessionResult();",
      'session.state = "stopping";',
      '--stop`',
      "} finally {",
    ],
    "stop must invalidate readers before teardown and release ownership even when teardown fails",
  );

  const healthHandler = sliceBetween(
    source,
    '"check-single-mcp-server"',
    '"get-single-mcp-server-logs"',
    "check-single-mcp-server handler",
  );
  assertContainsInOrder(
    healthHandler,
    [
      "getOwnedSingleServerSession(options?.sessionId, serverId)",
      "staleSingleServerSessionResult()",
      "/servers/${encodeURIComponent(serverId)}/status",
      'state: "authorization_required"',
      'state: "failed"',
      'state: "starting"',
      'state: session.state',
    ],
    "health must use structured states and session ownership",
  );

  const oauthHandlers = sliceBetween(
    source,
    '"get-single-mcp-server-base-url"',
    '"check-oauth-tokens-exist"',
    "single-server OAuth handlers",
  );
  assert.ok(
    (oauthHandlers.match(/getOwnedSingleServerSession/g) || []).length >= 4,
    "base URL and OAuth operations must validate the active session",
  );
});
