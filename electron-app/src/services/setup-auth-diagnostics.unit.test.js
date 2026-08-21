const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCallbackRequest,
  createOAuthResponseSummary,
} = require("./setup-auth-shared");

test("OAuth response summaries retain only closed diagnostic fields", () => {
  const secretDescription = [
    "employee@example.com",
    "/Users/example/private.txt",
    "Bearer secret-token-value",
    "eyJheader.eyJpayload.signature",
  ].join(" ");
  const summary = createOAuthResponseSummary({
    status: 400,
    bodyKind: "oauth_error_json",
    error: "invalid_grant",
    errorDescription: secretDescription,
    access_token: "must-not-survive",
  });

  assert.deepEqual(summary, {
    status: 400,
    bodyKind: "oauth_error_json",
    providerCode: "invalid_grant",
    reason: "unclassified_description",
  });
  assert.doesNotMatch(JSON.stringify(summary), /employee|Users|Bearer|eyJ|secret/i);
});

test("OAuth response summaries classify known reasons without retaining descriptions", () => {
  const cases = [
    [
      "invalid_grant",
      "The authorization code is invalid or has expired.",
      "authorization_code_invalid_or_expired",
    ],
    [
      "access_denied",
      "User denied the request",
      "user_cancelled",
    ],
    [
      "access_denied",
      "The access policy rejected this request",
      "access_policy_denied",
    ],
    [
      "access_denied",
      "The request was denied because the user is not assigned to the application",
      "access_policy_denied",
    ],
    [
      "access_denied",
      "The user was denied by the access policy",
      "access_policy_denied",
    ],
    [
      "invalid_scope",
      "offline_access is not permitted",
      "offline_access_denied",
    ],
    [
      "invalid_client",
      "Client authentication failed",
      "client_authentication_failed",
    ],
  ];

  for (const [error, errorDescription, reason] of cases) {
    assert.equal(
      createOAuthResponseSummary({
        status: 400,
        bodyKind: "oauth_error_json",
        error,
        errorDescription,
      }).reason,
      reason,
    );
  }
});

test("OAuth response summaries close provider codes and body kinds", () => {
  assert.deepEqual(
    createOAuthResponseSummary({
      status: 999,
      bodyKind: "private-body-kind",
      error: "secret_as_error_code",
      errorDescription: null,
    }),
    {
      status: null,
      bodyKind: "unparseable",
      providerCode: "unrecognized",
      reason: "none",
    },
  );
  assert.equal(
    createOAuthResponseSummary({ error: "unsupported_response_type" })
      .providerCode,
    "unsupported_response_type",
  );
});

test("setup callback sanitization occurs before the provider Error is created", () => {
  const privateDescription = encodeURIComponent(
    "employee@example.com /Users/example/private.txt Bearer top-secret",
  );
  const result = classifyCallbackRequest({
    requestUrl:
      `http://127.0.0.1:8877/callback?error=access_denied&` +
      `error_description=${privateDescription}&state=state-123`,
    expectedState: "state-123",
    expectedRedirectUri: "http://127.0.0.1:8877/callback",
    sanitizeProviderError: true,
  });

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "access_denied");
  assert.equal(result.error.message, "The identity provider denied the sign-in request");
  assert.deepEqual(result.error.oauthResponseSummary, {
    status: null,
    bodyKind: "callback_query",
    providerCode: "access_denied",
    reason: "unclassified_description",
  });
  assert.doesNotMatch(
    JSON.stringify({
      message: result.error.message,
      summary: result.error.oauthResponseSummary,
    }),
    /employee|Users|Bearer|secret/i,
  );
});

test("legacy callback consumers keep their existing provider error contract", () => {
  const result = classifyCallbackRequest({
    requestUrl:
      "http://127.0.0.1:8877/callback?error=access_denied&" +
      "error_description=User%20denied&state=state-123",
    expectedState: "state-123",
    expectedRedirectUri: "http://127.0.0.1:8877/callback",
  });

  assert.equal(result.error.message, "User denied");
  assert.equal(result.error.providerError, "access_denied");
});


const setupAuthPath = require.resolve("./setup-auth");
const electronPath = require.resolve("electron");
const setupAuthConfigPath = require.resolve("../config/setup-auth-config");
const oauthLoggerPath = require.resolve("./oauth-logger");

function loadSetupAuthInternals(logOAuth = () => undefined) {
  const previousSetupAuth = require.cache[setupAuthPath];
  const previousElectron = require.cache[electronPath];
  const previousConfig = require.cache[setupAuthConfigPath];
  const previousOAuthLogger = require.cache[oauthLoggerPath];

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: { getPath: () => "/tmp/setup-auth-diagnostics" },
      safeStorage: { isEncryptionAvailable: () => true },
      shell: { openExternal: async () => undefined },
    },
  };
  require.cache[setupAuthConfigPath] = {
    id: setupAuthConfigPath,
    filename: setupAuthConfigPath,
    loaded: true,
    exports: {
      SETUP_AUTH_CONFIG: {
        discoveryUrl: "https://id.example.test/.well-known/openid-configuration",
        networkTimeoutMs: 1000,
      },
      getAcceptedSetupAuthRedirectUris: () => [],
      getSetupAuthRedirectUri: () => "http://127.0.0.1:8877/callback",
    },
  };
  require.cache[oauthLoggerPath] = {
    id: oauthLoggerPath,
    filename: oauthLoggerPath,
    loaded: true,
    exports: { logOAuth },
  };
  delete require.cache[setupAuthPath];
  const service = require("./setup-auth");

  return {
    internals: service._test,
    restore() {
      delete require.cache[setupAuthPath];
      for (const [modulePath, previous] of [
        [electronPath, previousElectron],
        [setupAuthConfigPath, previousConfig],
        [oauthLoggerPath, previousOAuthLogger],
      ]) {
        if (previous) require.cache[modulePath] = previous;
        else delete require.cache[modulePath];
      }
      if (previousSetupAuth) require.cache[setupAuthPath] = previousSetupAuth;
    },
  };
}

test("setup-auth HTTP failures expose only fixed summaries and diagnostics", async () => {
  const logCalls = [];
  const loaded = loadSetupAuthInternals((...values) => logCalls.push(values));
  const previousFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description:
          "The authorization code expired for employee@example.com /Users/example/private.txt",
        access_token: "PRIVATE_ACCESS_TOKEN",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

  try {
    let failure;
    await assert.rejects(
      () =>
        loaded.internals.fetchJson("https://id.example.test/token", {
          errorCode: "token_exchange_failed",
          errorPrefix: "Okta token exchange failed",
        }),
      (error) => {
        failure = error;
        return true;
      },
    );
    assert.equal(Object.hasOwn(failure, "response"), false);
    assert.deepEqual(failure.oauthResponseSummary, {
      status: 400,
      bodyKind: "oauth_error_json",
      providerCode: "invalid_grant",
      reason: "authorization_code_invalid_or_expired",
    });
    const normalized = loaded.internals.normalizeError(failure);
    assert.deepEqual(normalized, {
      code: "token_exchange_failed",
      message:
        "Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.",
    });
    loaded.internals.logSetupAuthFailure(failure, normalized);
    assert.equal(logCalls.length, 1);
    assert.deepEqual(JSON.parse(logCalls[0][2]), {
      event: "setup_auth_failed",
      failure: "token_exchange_failed",
      httpStatus: 400,
      provider: "invalid_grant",
      reason: "authorization_code_invalid_or_expired",
      bodyKind: "oauth_error_json",
    });
    assert.doesNotMatch(
      JSON.stringify({ failure: failure.oauthResponseSummary, normalized, logCalls }),
      /employee|Users|PRIVATE_/i,
    );
  } finally {
    global.fetch = previousFetch;
    loaded.restore();
  }
});

test("setup-auth source handles callback failures early and never logs callback URLs", () => {
  const source = require("node:fs").readFileSync(setupAuthPath, "utf8");
  assert.equal(
    source.match(/sanitizeProviderError:\s*true/g)?.length,
    2,
  );
  assert.match(
    source,
    /waitForAuthorizationCallback\(\{[\s\S]*?\}\)\.then\([\s\S]*\(error\) => \(\{ value: null, error \}\)/,
  );
  assert.doesNotMatch(
    source,
    /console\.(?:warn|error|log)\([^;\n]*requestUrl\.toString\(\)/,
  );
});
