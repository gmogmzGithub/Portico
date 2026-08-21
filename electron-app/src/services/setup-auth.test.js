const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const servicePath = require.resolve("./setup-auth");
const electronPath = require.resolve("electron");
const configPath = require.resolve("../config/setup-auth-config");
const oauthLoggerPath = require.resolve("./oauth-logger");

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function createJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createJwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

async function withMockFetch(handler, callback) {
  const previousFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, options);
  };

  try {
    return await callback();
  } finally {
    global.fetch = previousFetch;
  }
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function listenOnPort(port) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function triggerCallback(url) {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

async function loadSetupAuthModule({
  userDataDir = createTempDir("setup-auth-test-"),
  port,
  shellOpenExternal,
  logOAuth = () => undefined,
  configOverrides = {},
  safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer).toString("utf8"),
  },
} = {}) {
  const previousService = require.cache[servicePath];
  const previousElectron = require.cache[electronPath];
  const previousConfig = require.cache[configPath];
  const previousOAuthLogger = require.cache[oauthLoggerPath];
  const resolvedPort = port || (await allocatePort());

  const issuer = "https://id.example.invalid/oauth2/default";
  const configExports = {
    SETUP_AUTH_CONFIG: {
      issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      clientId: "test-client-id",
      clientType: "native",
      scopes: ["openid", "profile", "email", "offline_access"],
      redirectHost: "127.0.0.1",
      redirectPort: resolvedPort,
      redirectPath: "/callback",
      acceptedRedirectHosts: ["127.0.0.1", "localhost"],
      authTimeoutMs: 5000,
      networkTimeoutMs: 1000,
      tokenExpirySkewMs: 100,
      sessionFileName: "setup-auth-session.bin",
      brokerBindMaxWaitMs: 250,
      brokerBindRetryDelayMs: 50,
      ...configOverrides,
    },
    getSetupAuthRedirectUri(host = "127.0.0.1") {
      return `http://${host}:${resolvedPort}/callback`;
    },
    getAcceptedSetupAuthRedirectUris() {
      return [
        `http://127.0.0.1:${resolvedPort}/callback`,
        `http://localhost:${resolvedPort}/callback`,
      ];
    },
  };

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        getPath(name) {
          assert.equal(name, "userData");
          return userDataDir;
        },
      },
      safeStorage,
      shell: {
        openExternal:
          shellOpenExternal ||
          (async () => {
            throw new Error("shell.openExternal was not stubbed for this test");
          }),
      },
    },
  };
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: configExports,
  };
  require.cache[oauthLoggerPath] = {
    id: oauthLoggerPath,
    filename: oauthLoggerPath,
    loaded: true,
    exports: { logOAuth },
  };

  delete require.cache[servicePath];
  const service = require("./setup-auth");

  return {
    service,
    userDataDir,
    config: configExports,
    sessionFilePath: path.join(
      userDataDir,
      configExports.SETUP_AUTH_CONFIG.sessionFileName,
    ),
    restore() {
      delete require.cache[servicePath];

      if (previousService) {
        require.cache[servicePath] = previousService;
      } else {
        delete require.cache[servicePath];
      }

      if (previousElectron) {
        require.cache[electronPath] = previousElectron;
      } else {
        delete require.cache[electronPath];
      }

      if (previousConfig) {
        require.cache[configPath] = previousConfig;
      } else {
        delete require.cache[configPath];
      }

      if (previousOAuthLogger) {
        require.cache[oauthLoggerPath] = previousOAuthLogger;
      } else {
        delete require.cache[oauthLoggerPath];
      }
    },
  };
}

test("startSetupAuth ignores stale callback requests and accepts localhost loopback redirects", async () => {
  let authorizeUrl = null;
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: async (url) => {
      authorizeUrl = new URL(url);

      const staleCallbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      staleCallbackUrl.searchParams.set("code", "stale-code");
      staleCallbackUrl.searchParams.set("state", "stale-state");

      const validCallbackUrl = new URL(
        loaded.config.getSetupAuthRedirectUri("localhost"),
      );
      validCallbackUrl.searchParams.set("code", "auth-code");
      validCallbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state"),
      );

      setTimeout(() => {
        triggerCallback(staleCallbackUrl.toString()).catch(() => {});
      }, 5);
      setTimeout(() => {
        triggerCallback(validCallbackUrl.toString()).catch(() => {});
      }, 20);
    },
  });

  try {
    await withMockFetch(async (url, options) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
          userinfo_endpoint: "https://id.example.invalid/oauth2/default/v1/userinfo",
        });
      }

      if (url === "https://id.example.invalid/oauth2/default/v1/token") {
        const body = options.body.toString();
        assert.match(body, /grant_type=authorization_code/);
        assert.match(body, /code=auth-code/);
        return createJsonResponse({
          access_token: "interactive-access",
          refresh_token: "interactive-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            email: "jdoe@example.invalid",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.equal(result.success, true);
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "interactive");
      assert.equal(result.sessionSummary.user.id, "jdoe");
      assert.equal(authorizeUrl.searchParams.get("client_id"), "test-client-id");
      assert.equal(loaded.service.getSetupAuthStatus().phase, "authenticated");
      assert.equal(fs.existsSync(loaded.sessionFilePath), true);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth treats matching-state provider errors as terminal", async () => {
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: async (url) => {
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("error", "access_denied");
      callbackUrl.searchParams.set("error_description", "User denied access");
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state"),
      );

      setTimeout(() => {
        triggerCallback(callbackUrl.toString()).catch(() => {});
      }, 5);
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.deepEqual(result, {
        success: false,
        authenticated: false,
        error: "Sign-in was canceled. Try again when you are ready.",
        errorCode: "access_denied_user_cancelled",
      });
      assert.equal(loaded.service.getSetupAuthStatus().phase, "error");
      assert.equal(fs.existsSync(loaded.sessionFilePath), false);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getAuthorizedSession returns the stored session when still valid", async () => {
  const loaded = await loadSetupAuthModule();

  try {
    const sessionRecord = {
      version: 1,
      accessToken: "cached-access",
      refreshToken: "cached-refresh",
      idToken: createJwt({
        preferred_username: "jdoe",
        name: "Jane Doe",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      expiresAt: Date.now() + 3600 * 1000,
      user: {
        id: "jdoe",
        name: "Jane Doe",
      },
    };
    fs.writeFileSync(loaded.sessionFilePath, Buffer.from(JSON.stringify(sessionRecord), "utf8"));

    const session = await loaded.service.getAuthorizedSession();
    assert.equal(session.accessToken, "cached-access");
    assert.equal(session.refreshToken, "cached-refresh");
    assert.equal(loaded.service.getSetupAuthStatus().phase, "authenticated");
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getAuthorizedSession refreshes an expired session", async () => {
  const loaded = await loadSetupAuthModule();

  try {
    const expiredSession = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      idToken: createJwt({
        preferred_username: "jdoe",
        name: "Jane Doe",
        exp: Math.floor(Date.now() / 1000) - 3600,
      }),
      expiresAt: Date.now() - 60_000,
      scopes: ["openid", "profile", "email", "offline_access"],
      user: {
        id: "jdoe",
        name: "Jane Doe",
      },
    };
    fs.writeFileSync(loaded.sessionFilePath, Buffer.from(JSON.stringify(expiredSession), "utf8"));

    await withMockFetch(async (url, options = {}) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
          userinfo_endpoint: "https://id.example.invalid/oauth2/default/v1/userinfo",
        });
      }

      if (url === "https://id.example.invalid/oauth2/default/v1/token") {
        const body = options.body.toString();
        assert.match(body, /grant_type=refresh_token/);
        return createJsonResponse({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            email: "jdoe@example.invalid",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const session = await loaded.service.getAuthorizedSession();
      assert.equal(session.accessToken, "refreshed-access");
      assert.equal(session.refreshToken, "refreshed-refresh");
      assert.equal(loaded.service.getSetupAuthStatus().phase, "authenticated");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth does not open the browser when the callback port is occupied", async () => {
  const port = await allocatePort();
  const blocker = await listenOnPort(port);
  let browserOpenCalls = 0;
  const loaded = await loadSetupAuthModule({
    port,
    shellOpenExternal: async () => {
      browserOpenCalls += 1;
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "callback_listener_failed");
      assert.equal(
        result.error,
        "The app could not open the local Okta callback port. Try again.",
      );
      assert.equal(browserOpenCalls, 0);
    });
  } finally {
    await closeServer(blocker);
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});


test("startSetupAuth classifies token endpoint failures without retaining provider text", async () => {
  const oauthLogCalls = [];
  const loaded = await loadSetupAuthModule({
    logOAuth: (...values) => oauthLogCalls.push(values),
    shellOpenExternal: async (url) => {
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("code", "private-auth-code");
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state"),
      );
      setTimeout(() => {
        triggerCallback(callbackUrl.toString()).catch(() => {});
      }, 5);
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }
      if (url.endsWith("/v1/token")) {
        return createJsonResponse(
          {
            error: "invalid_grant",
            error_description:
              "The authorization code is invalid or has expired for employee@example.com /Users/example/private.txt",
            access_token: "PRIVATE_ACCESS_TOKEN",
            code_verifier: "PRIVATE_CODE_VERIFIER",
            nested: { secret: "PRIVATE_NESTED_SECRET" },
          },
          400,
        );
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();
      assert.deepEqual(result, {
        success: false,
        authenticated: false,
        error:
          "Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.",
        errorCode: "token_exchange_failed",
      });
      assert.equal(oauthLogCalls.length, 1);
      assert.deepEqual(JSON.parse(oauthLogCalls[0][2]), {
        event: "setup_auth_failed",
        failure: "token_exchange_failed",
        httpStatus: 400,
        provider: "invalid_grant",
        reason: "authorization_code_invalid_or_expired",
        bodyKind: "oauth_error_json",
      });
      assert.doesNotMatch(
        JSON.stringify({ result, oauthLogCalls }),
        /employee|Users|PRIVATE_|private-auth-code/i,
      );
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth handles a sanitized callback failure while browser opening is pending", async () => {
  const unhandled = [];
  const handleUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", handleUnhandled);
  const oauthLogCalls = [];
  const loaded = await loadSetupAuthModule({
    logOAuth: (...values) => oauthLogCalls.push(values),
    shellOpenExternal: async (url) => {
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("error", "access_denied");
      callbackUrl.searchParams.set(
        "error_description",
        "employee@example.com /Users/example/private.txt",
      );
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state"),
      );
      await triggerCallback(callbackUrl.toString());
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(result, {
        success: false,
        authenticated: false,
        error:
          "Okta denied access to this app. Try again or confirm that your account can use this Okta application.",
        errorCode: "access_denied",
      });
      assert.deepEqual(unhandled, []);
      assert.doesNotMatch(
        JSON.stringify({ result, oauthLogCalls }),
        /employee|Users|private\.txt/i,
      );
    });
  } finally {
    process.off("unhandledRejection", handleUnhandled);
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth removes its callback waiter when browser opening throws synchronously", async () => {
  let authorizationUrl;
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: (url) => {
      authorizationUrl = new URL(url);
      throw new Error("/Users/example/synchronous-browser-private");
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();
      assert.deepEqual(result, {
        success: false,
        authenticated: false,
        error: "The app could not open Okta in your browser. Try again.",
        errorCode: "browser_open_failed",
      });

      const lateCallbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      lateCallbackUrl.searchParams.set("code", "late-private-code");
      lateCallbackUrl.searchParams.set(
        "state",
        authorizationUrl.searchParams.get("state"),
      );
      assert.equal(await triggerCallback(lateCallbackUrl.toString()), 400);
      assert.doesNotMatch(
        JSON.stringify({ result }),
        /Users|synchronous-browser-private|late-private-code/i,
      );
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("setup auth diagnostics never replace the stable result when logging throws", async () => {
  const loaded = await loadSetupAuthModule({
    logOAuth: () => {
      throw new Error("PRIVATE_LOGGER_FAILURE");
    },
    shellOpenExternal: async () => {
      throw new Error("/Users/example/browser-private");
    },
  });
  const previousConsoleWarn = console.warn;
  const warnings = [];
  console.warn = (...values) => warnings.push(values.join(" "));

  try {
    await withMockFetch(async (url) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();
      assert.deepEqual(result, {
        success: false,
        authenticated: false,
        error: "The app could not open Okta in your browser. Try again.",
        errorCode: "browser_open_failed",
      });
      assert.deepEqual(warnings, [
        "[setup-auth] OAuth diagnostic logging failed",
      ]);
      assert.doesNotMatch(
        JSON.stringify({ result, warnings }),
        /PRIVATE_|Users|browser-private/i,
      );
    });
  } finally {
    console.warn = previousConsoleWarn;
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth retries the broker bind while the callback port is briefly occupied", async () => {
  const port = await allocatePort();
  const blocker = await listenOnPort(port);
  let browserOpenCalls = 0;
  let authorizeUrl = null;
  const loaded = await loadSetupAuthModule({
    port,
    // Give the bind retry loop plenty of headroom on slow machines; the
    // blocker below is released after ~100ms so success stays fast.
    configOverrides: { brokerBindMaxWaitMs: 2000 },
    shellOpenExternal: async (url) => {
      browserOpenCalls += 1;
      authorizeUrl = new URL(url);

      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("code", "auth-code");
      callbackUrl.searchParams.set(
        "state",
        authorizeUrl.searchParams.get("state"),
      );

      setTimeout(() => {
        triggerCallback(callbackUrl.toString()).catch(() => {});
      }, 5);
    },
  });

  setTimeout(() => {
    closeServer(blocker).catch(() => {});
  }, 100);

  try {
    await withMockFetch(async (url, options = {}) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
          token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
          userinfo_endpoint: "https://id.example.invalid/oauth2/default/v1/userinfo",
        });
      }

      if (url === "https://id.example.invalid/oauth2/default/v1/token") {
        const body = options.body.toString();
        assert.match(body, /grant_type=authorization_code/);
        assert.match(body, /code=auth-code/);
        return createJsonResponse({
          access_token: "retry-access",
          refresh_token: "retry-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            email: "jdoe@example.invalid",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.equal(result.success, true);
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "interactive");
      assert.equal(browserOpenCalls, 1);
      assert.equal(loaded.service.getSetupAuthStatus().phase, "authenticated");
    });
  } finally {
    await closeServer(blocker);
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getCachedSessionSummary self-heals when the stored session cannot be decrypted", async () => {
  const loaded = await loadSetupAuthModule({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: () => {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        );
      },
    },
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from("opaque-ciphertext", "utf8"),
    );

    const result = await loaded.service.getCachedSessionSummary();

    assert.equal(result.authenticated, false);
    assert.equal(result.sessionSummary, null);
    assert.equal(result.source, "session_unreadable");
    assert.equal(result.errorCode, "session_decrypt_failed");

    const status = loaded.service.getSetupAuthStatus();
    assert.equal(status.phase, "idle");
    assert.equal(status.error, null);
    assert.equal(status.errorCode, null);

    assert.equal(fs.existsSync(loaded.sessionFilePath), false);
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getCachedSessionSummary self-heals when the stored session decrypts to corrupted JSON", async () => {
  const loaded = await loadSetupAuthModule();

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from("{not-valid-json", "utf8"),
    );

    const result = await loaded.service.getCachedSessionSummary();

    assert.equal(result.authenticated, false);
    assert.equal(result.sessionSummary, null);
    assert.equal(result.source, "session_unreadable");
    assert.equal(result.errorCode, "session_parse_failed");

    const status = loaded.service.getSetupAuthStatus();
    assert.equal(status.phase, "idle");
    assert.equal(status.error, null);
    assert.equal(status.errorCode, null);

    assert.equal(fs.existsSync(loaded.sessionFilePath), false);
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

// --- PORTICO-414: canonical email, refresh provenance, and identity repair ---

const portico414_DISCOVERY = {
  authorization_endpoint: "https://id.example.invalid/oauth2/default/v1/authorize",
  token_endpoint: "https://id.example.invalid/oauth2/default/v1/token",
  userinfo_endpoint: "https://id.example.invalid/oauth2/default/v1/userinfo",
};

function readPersistedSession(loaded) {
  return JSON.parse(fs.readFileSync(loaded.sessionFilePath, "utf8"));
}

test("refreshSession backfills email from userinfo when the refresh response omits an id_token", async () => {
  const loaded = await loadSetupAuthModule();
  const retainedIdToken = createJwt({
    preferred_username: "jdoe",
    name: "Jane Doe",
    exp: Math.floor(Date.now() / 1000) - 3600,
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "expired-access",
          refreshToken: "refresh-token",
          idToken: retainedIdToken,
          expiresAt: Date.now() - 60_000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            email: null,
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    let userinfoCalls = 0;
    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({
          access_token: "refreshed-access",
          expires_in: 3600,
          // No id_token and no rotated refresh_token: both are retained.
        });
      }
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        userinfoCalls += 1;
        return createJsonResponse({
          preferred_username: "jdoe",
          name: "Jane Doe",
          email: "fresh@example.invalid",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const session = await loaded.service.getAuthorizedSession();
      assert.equal(userinfoCalls, 1);
      assert.equal(session.user.email, "fresh@example.invalid");

      const persisted = readPersistedSession(loaded);
      assert.equal(persisted.user.email, "fresh@example.invalid");
      assert.equal(persisted.user.claims.email, "fresh@example.invalid");
      // Storage keeps the retained id_token even though identity ignored it.
      assert.equal(persisted.idToken, retainedIdToken);
      assert.equal(persisted.refreshToken, "refresh-token");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("refreshSession preserves a legacy record's email when it has no stored claims and refresh mints no id_token", async () => {
  const loaded = await loadSetupAuthModule();
  const retainedIdToken = createJwt({
    preferred_username: "jdoe",
    name: "Jane Doe",
    exp: Math.floor(Date.now() / 1000) - 3600,
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "expired-access",
          refreshToken: "refresh-token",
          idToken: retainedIdToken,
          expiresAt: Date.now() - 60_000,
          scopes: ["openid", "profile", "email", "offline_access"],
          // Legacy shape: no user.claims at all.
          user: { id: "jdoe", name: "Jane Doe", email: "kept@example.invalid" },
        }),
        "utf8",
      ),
    );

    let userinfoCalls = 0;
    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({ access_token: "refreshed-access", expires_in: 3600 });
      }
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        userinfoCalls += 1;
        return createJsonResponse({});
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const session = await loaded.service.getAuthorizedSession();
      // The synthesized fallback already carries a plausible email, so no
      // userinfo round-trip is needed and the email survives the refresh.
      assert.equal(userinfoCalls, 0);
      assert.equal(session.user.email, "kept@example.invalid");
      assert.equal(readPersistedSession(loaded).user.email, "kept@example.invalid");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("refreshSession survives a userinfo outage and leaves a fixed-field diagnostic", async () => {
  const oauthLogEntries = [];
  const loaded = await loadSetupAuthModule({
    logOAuth: (component, level, message) => {
      oauthLogEntries.push({ component, level, message });
    },
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "expired-access",
          refreshToken: "refresh-token",
          idToken: createJwt({ preferred_username: "jdoe", name: "Jane Doe" }),
          expiresAt: Date.now() - 60_000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({ access_token: "refreshed-access", expires_in: 3600 });
      }
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        return createJsonResponse({ error: "server_error" }, 500);
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const session = await loaded.service.getAuthorizedSession();
      assert.equal(session.user.email, null);
      assert.equal(session.accessToken, "refreshed-access");
    });

    const diagnostic = oauthLogEntries.find((entry) =>
      entry.message.includes("setup_auth_userinfo_failed"),
    );
    assert.ok(diagnostic, "expected a setup_auth_userinfo_failed diagnostic");
    const parsed = JSON.parse(diagnostic.message);
    assert.deepEqual(Object.keys(parsed).sort(), ["event", "failure", "httpStatus"]);
    assert.equal(parsed.event, "setup_auth_userinfo_failed");
    assert.equal(parsed.failure, "userinfo_failed");
    assert.equal(parsed.httpStatus, 500);
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("repairSessionIdentity backfills the email once for concurrent callers and persists it", async () => {
  const loaded = await loadSetupAuthModule();

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          userinfoEndpoint: portico414_DISCOVERY.userinfo_endpoint,
          expiresAt: Date.now() + 3600 * 1000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            email: null,
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    let userinfoCalls = 0;
    await withMockFetch(async (url, options = {}) => {
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        userinfoCalls += 1;
        assert.equal(options.headers.Authorization, "Bearer cached-access");
        return createJsonResponse({
          preferred_username: "jdoe",
          name: "Jane Doe",
          email: "backfill@example.invalid",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const [first, second] = await Promise.all([
        loaded.service.repairSessionIdentity(),
        loaded.service.repairSessionIdentity(),
      ]);

      assert.equal(userinfoCalls, 1);
      assert.equal(first.repaired, true);
      assert.equal(first.authenticated, true);
      assert.equal(first.source, "identity_repair");
      assert.equal(first.sessionSummary.user.email, "backfill@example.invalid");
      assert.equal(second.repaired, true);

      const persisted = readPersistedSession(loaded);
      assert.equal(persisted.user.email, "backfill@example.invalid");
      // Tokens are untouched: repair only rewrites the identity block.
      assert.equal(persisted.accessToken, "cached-access");
      assert.equal(persisted.refreshToken, "cached-refresh");

      const status = loaded.service.getSetupAuthStatus();
      assert.equal(status.phase, "authenticated");
      assert.equal(status.sessionSummary.user.email, "backfill@example.invalid");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("repairSessionIdentity no-ops for present emails and expired sessions, and reports an unavailable email", async () => {
  const loaded = await loadSetupAuthModule();
  const baseRecord = {
    version: 1,
    accessToken: "cached-access",
    refreshToken: "cached-refresh",
    userinfoEndpoint: portico414_DISCOVERY.userinfo_endpoint,
    scopes: ["openid", "profile", "email", "offline_access"],
  };

  try {
    let userinfoCalls = 0;
    let userinfoStatus = 200;
    await withMockFetch(async (url) => {
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        userinfoCalls += 1;
        return createJsonResponse(
          userinfoStatus === 200 ? {} : { error: "server_error" },
          userinfoStatus,
        );
      }
      return createJsonResponse({}, 404);
    }, async () => {
      fs.writeFileSync(
        loaded.sessionFilePath,
        Buffer.from(
          JSON.stringify({
            ...baseRecord,
            expiresAt: Date.now() + 3600 * 1000,
            user: { id: "jdoe", name: "Jane Doe", email: "jdoe@example.invalid" },
          }),
          "utf8",
        ),
      );
      const present = await loaded.service.repairSessionIdentity();
      assert.equal(present.repaired, false);
      assert.equal(present.reason, "email_present");
      assert.equal(present.authenticated, true);
      assert.equal(userinfoCalls, 0);

      fs.writeFileSync(
        loaded.sessionFilePath,
        Buffer.from(
          JSON.stringify({
            ...baseRecord,
            expiresAt: Date.now() - 60_000,
            user: { id: "jdoe", name: "Jane Doe" },
          }),
          "utf8",
        ),
      );
      const expired = await loaded.service.repairSessionIdentity();
      assert.equal(expired.repaired, false);
      assert.equal(expired.reason, "session_expired");
      assert.equal(expired.authenticated, false);
      assert.equal(userinfoCalls, 0);

      userinfoStatus = 500;
      fs.writeFileSync(
        loaded.sessionFilePath,
        Buffer.from(
          JSON.stringify({
            ...baseRecord,
            expiresAt: Date.now() + 3600 * 1000,
            user: {
              id: "jdoe",
              name: "Jane Doe",
              claims: { preferred_username: "jdoe", name: "Jane Doe" },
            },
          }),
          "utf8",
        ),
      );
      const unavailable = await loaded.service.repairSessionIdentity();
      assert.equal(unavailable.repaired, false);
      assert.equal(unavailable.reason, "email_unavailable");
      assert.equal(unavailable.emailUnavailable, true);
      assert.equal(unavailable.terminal, false);
      assert.equal(unavailable.authenticated, true);
      assert.equal(userinfoCalls, 1);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("identity repair queues behind a concurrent refresh instead of interleaving persists", async () => {
  const loaded = await loadSetupAuthModule();

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "expired-access",
          refreshToken: "original-refresh",
          expiresAt: Date.now() - 60_000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            email: "jdoe@example.invalid",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const [repair, refreshed] = await Promise.all([
        loaded.service.repairSessionIdentity(),
        loaded.service.getAuthorizedSession(),
      ]);

      // Repair entered the mutation queue first, saw the expired session, and
      // stood down; the refresh then persisted the rotated tokens untouched.
      assert.equal(repair.repaired, false);
      assert.equal(repair.reason, "session_expired");
      assert.equal(refreshed.refreshToken, "rotated-refresh");
      assert.equal(readPersistedSession(loaded).refreshToken, "rotated-refresh");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth silently repairs an email-less cached session without opening the browser", async () => {
  let browserOpenCalls = 0;
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: async () => {
      browserOpenCalls += 1;
    },
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          userinfoEndpoint: portico414_DISCOVERY.userinfo_endpoint,
          expiresAt: Date.now() + 3600 * 1000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    await withMockFetch(async (url) => {
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        return createJsonResponse({
          preferred_username: "jdoe",
          name: "Jane Doe",
          email: "healed@example.invalid",
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.equal(result.success, true);
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "identity_repair");
      assert.equal(result.sessionSummary.user.email, "healed@example.invalid");
      assert.equal(browserOpenCalls, 0);
      assert.equal(readPersistedSession(loaded).user.email, "healed@example.invalid");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("startSetupAuth falls through to interactive re-auth when silent repair cannot find an email", async () => {
  let browserOpenCalls = 0;
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: async (url) => {
      browserOpenCalls += 1;
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("code", "auth-code");
      callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      setTimeout(() => {
        triggerCallback(callbackUrl.toString()).catch(() => {});
      }, 5);
    },
  });

  try {
    fs.writeFileSync(
      loaded.sessionFilePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          userinfoEndpoint: portico414_DISCOVERY.userinfo_endpoint,
          expiresAt: Date.now() + 3600 * 1000,
          scopes: ["openid", "profile", "email", "offline_access"],
          user: {
            id: "jdoe",
            name: "Jane Doe",
            claims: { preferred_username: "jdoe", name: "Jane Doe" },
          },
        }),
        "utf8",
      ),
    );

    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        return createJsonResponse({ error: "server_error" }, 500);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({
          access_token: "interactive-access",
          refresh_token: "interactive-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            email: "jdoe@example.invalid",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();

      assert.equal(result.success, true);
      assert.equal(result.source, "interactive");
      assert.equal(result.sessionSummary.user.email, "jdoe@example.invalid");
      assert.equal(browserOpenCalls, 1);
      assert.equal(readPersistedSession(loaded).user.email, "jdoe@example.invalid");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("an interactive sign-in that still lacks an email marks identity repair as terminal", async () => {
  let browserOpenCalls = 0;
  const loaded = await loadSetupAuthModule({
    shellOpenExternal: async (url) => {
      browserOpenCalls += 1;
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(loaded.config.getSetupAuthRedirectUri());
      callbackUrl.searchParams.set("code", "auth-code");
      callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      setTimeout(() => {
        triggerCallback(callbackUrl.toString()).catch(() => {});
      }, 5);
    },
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://id.example.invalid/oauth2/default/.well-known/openid-configuration") {
        return createJsonResponse(portico414_DISCOVERY);
      }
      if (url === portico414_DISCOVERY.userinfo_endpoint) {
        return createJsonResponse({ error: "server_error" }, 500);
      }
      if (url === portico414_DISCOVERY.token_endpoint) {
        return createJsonResponse({
          access_token: "interactive-access",
          refresh_token: "interactive-refresh",
          expires_in: 3600,
          id_token: createJwt({
            preferred_username: "jdoe",
            name: "Jane Doe",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.startSetupAuth();
      // Email policy is enforced by the startup gate, not the auth service:
      // the sign-in itself still succeeds.
      assert.equal(result.success, true);
      assert.equal(result.sessionSummary.user.email, null);

      const repair = await loaded.service.repairSessionIdentity();
      assert.equal(repair.repaired, false);
      assert.equal(repair.emailUnavailable, true);
      assert.equal(repair.terminal, true);
      // Neither the repair nor the terminal marker re-opened the browser.
      assert.equal(browserOpenCalls, 1);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});
