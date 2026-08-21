// PORTICO-443: behavioural coverage for which API routes get a per-request log line.
//
// Replaces a source pin in api-toggle-readiness-regressions.test.js that matched
// api.js's text for a hard-coded `/api/server-readiness` startsWith. That pin
// broke on the refactor it should have tolerated, and would have passed against an
// implementation that logged every route as long as the characters were present.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOG_ONLY_ON_FAILURE_ROUTES,
  shouldLogOnlyOnFailure,
} = require("./api-request-log-policy");

test("the routes that flooded the PORTICO-443 session are not logged on success", () => {
  // 9,654 of these in one session, from an endpoint whose job is to write a log.
  assert.equal(shouldLogOnlyOnFailure("/api/oauth-log"), true);
  // Status polling: ~1,079 in the same session.
  assert.equal(
    shouldLogOnlyOnFailure("/api/user-question-flow-status/user-question-123-abc"),
    true,
  );
  // Pre-existing behaviour that must survive the generalisation.
  assert.equal(shouldLogOnlyOnFailure("/api/server-readiness"), true);
});

test("flow ids are matched by prefix rather than enumerated", () => {
  // The real shape carries an opaque id, so exact matching would silently stop
  // suppressing the moment ids changed format.
  const ids = [
    "/api/user-question-flow-status/user-question-1787-9mno0",
    "/api/user-question-flow-status/user-question-42-scebuuwn",
    "/api/server-readiness/glean",
  ];
  ids.forEach((p) => assert.equal(shouldLogOnlyOnFailure(p), true, p));
});

test("ordinary routes keep their per-request log line", () => {
  // Suppressing broadly would make the app quieter AND less diagnosable, which is
  // a worse bug than the noise this change removes.
  const logged = [
    "/api/mcp-operations",
    "/api/health",
    "/api/user",
    "/api/oauth-status",
    "/",
  ];
  logged.forEach((p) => assert.equal(shouldLogOnlyOnFailure(p), false, p));
});

test("suppression is anchored at the start of the path", () => {
  // A route that merely mentions a suppressed name must not inherit suppression.
  assert.equal(shouldLogOnlyOnFailure("/api/proxy/api/oauth-log"), false);
  assert.equal(shouldLogOnlyOnFailure("/other/api/server-readiness"), false);
});

test("malformed input is not treated as suppressed", () => {
  // Defaulting to "log it" is the safe direction: the cost of a stray line is
  // noise, the cost of a wrongly-dropped line is a missing diagnostic.
  [undefined, null, "", 0, {}, []].forEach((value) => {
    assert.equal(shouldLogOnlyOnFailure(value), false, String(value));
  });
});

test("the route list is frozen so it cannot be mutated at runtime", () => {
  assert.equal(Object.isFrozen(LOG_ONLY_ON_FAILURE_ROUTES), true);
  assert.equal(LOG_ONLY_ON_FAILURE_ROUTES.includes("/api/oauth-log"), true);
});

test("callers may supply their own route list", () => {
  assert.equal(shouldLogOnlyOnFailure("/custom/thing", ["/custom"]), true);
  assert.equal(shouldLogOnlyOnFailure("/api/oauth-log", ["/custom"]), false);
  assert.equal(shouldLogOnlyOnFailure("/anything", []), false);
});
