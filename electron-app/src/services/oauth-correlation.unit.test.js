const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatOAuthCorrelation,
  summarizeOAuthCorrelation,
} = require("./oauth-correlation");

test("OAuth correlation keeps allowlisted metadata and drops all query secrets", () => {
  const summary = summarizeOAuthCorrelation({
    event: "authorization_opened",
    serverId: "trust-kit-mcp",
    sessionId: "session-123",
    authorizationUrl:
      "https://secure.example.test/oauth/authorize?state=state-secret&code=auth-code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A3836%2Fcallback%3Fsecret%3Dvalue",
  });

  assert.deepEqual(summary, {
    event: "authorization_opened",
    sessionId: "session-123",
    authorizationHost: "secure.example.test",
    redirectUri: "http://localhost:3836/callback",
    callbackReceived: false,
  });

  const formatted = formatOAuthCorrelation({
    event: "authorization_opened",
    serverId: "trust-kit-mcp",
    sessionId: "session-123",
    authorizationUrl:
      "https://secure.example.test/oauth/authorize?state=state-secret&code=auth-code&redirect_uri=http%3A%2F%2Flocalhost%3A3836%2Fcallback",
  });
  assert.doesNotMatch(formatted, /state-secret|auth-code|client-1|\?/);
});

test("OAuth callback correlation records callback presence without an URL", () => {
  const summary = summarizeOAuthCorrelation({
    event: "callback_received",
    serverId: "trust-kit-mcp",
    sessionId: "session-456",
  });

  assert.equal(summary.callbackReceived, true);
  assert.equal(summary.authorizationHost, null);
  assert.equal(summary.redirectUri, null);
});

test("OAuth correlation rejects unsupported events and URL schemes", () => {
  assert.throws(
    () => summarizeOAuthCorrelation({ event: "raw_url_dump" }),
    /Unsupported OAuth correlation event/,
  );
  assert.throws(
    () =>
      summarizeOAuthCorrelation({
        event: "authorization_opened",
        authorizationUrl: "file:///tmp/oauth",
      }),
    /must use HTTP or HTTPS/,
  );
});
