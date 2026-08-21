const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const servicePath = require.resolve("./gitlab-marketplace-auth");
const electronPath = require.resolve("electron");
const configPath = require.resolve("../config/gitlab-marketplace-auth-config");

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

function writeEncryptedSession(filePath, safeStorage, session) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(session)));
}

async function triggerCallback(url) {
  await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
  });
}

async function loadGitlabMarketplaceAuthModule({
  userDataDir = createTempDir("gitlab-auth-test-"),
  port,
  clientSecret = "",
  shellOpenExternal,
  safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer).toString("utf8"),
  },
} = {}) {
  const previousService = require.cache[servicePath];
  const previousElectron = require.cache[electronPath];
  const previousConfig = require.cache[configPath];
  const resolvedPort = port || (await allocatePort());

  const baseUrl = "https://example.invalid";
  const configExports = {
    GITLAB_MARKETPLACE_AUTH_CONFIG: {
      issuer: baseUrl,
      baseUrl,
      discoveryUrl: `${baseUrl}/.well-known/openid-configuration`,
      clientId: "test-client-id",
      clientSecret,
      clientType: "native",
      scopes: ["openid", "profile", "email", "read_repository", "read_api"],
      redirectHost: "127.0.0.1",
      redirectPort: resolvedPort,
      redirectPath: "/gitlab/callback",
      acceptedRedirectHosts: ["127.0.0.1", "localhost"],
      authTimeoutMs: 5000,
      networkTimeoutMs: 1000,
      tokenExpirySkewMs: 100,
      sessionFileName: "gitlab-marketplace-auth-session.bin",
      allowedHosts: ["example.invalid"],
    },
    getGitlabMarketplaceAuthRedirectUri(host = "127.0.0.1") {
      return `http://${host}:${resolvedPort}/gitlab/callback`;
    },
    getAcceptedGitlabMarketplaceAuthRedirectUris() {
      return [
        `http://127.0.0.1:${resolvedPort}/gitlab/callback`,
        `http://localhost:${resolvedPort}/gitlab/callback`,
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

  delete require.cache[servicePath];
  const service = require("./gitlab-marketplace-auth");

  return {
    service,
    userDataDir,
    config: configExports,
    sessionFilePath: path.join(
      userDataDir,
      `example.invalid-${configExports.GITLAB_MARKETPLACE_AUTH_CONFIG.sessionFileName}`,
    ),
    safeStorage,
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
    },
  };
}

test("getCachedSessionSummary returns unauthenticated when no session exists", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  try {
    const result = await loaded.service.getCachedSessionSummary();
    assert.deepEqual(result, {
      authenticated: false,
      sessionSummary: null,
      source: undefined,
      refreshError: undefined,
      error: undefined,
      errorCode: undefined,
    });
    assert.equal(loaded.service.getStatus().phase, "idle");
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getCachedSessionSummary refreshes expired sessions and persists the refreshed tokens", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  const expiredSession = {
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    idToken: createJwt({
      preferred_username: "jdoe",
      name: "Jane Doe",
      email: "jdoe@example.invalid",
      exp: Math.floor(Date.now() / 1000) - 10,
    }),
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email", "read_repository", "read_api"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      email: "jdoe@example.invalid",
      preferredUsername: "jdoe",
      claims: {
        preferred_username: "jdoe",
        name: "Jane Doe",
        email: "jdoe@example.invalid",
      },
    },
  };

  writeEncryptedSession(
    loaded.sessionFilePath,
    loaded.safeStorage,
    expiredSession,
  );

  try {
    await withMockFetch(async (url, options) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }

      if (url === "https://example.invalid/oauth/token") {
        const body = options.body.toString();
        assert.match(body, /grant_type=refresh_token/);
        return createJsonResponse({
          access_token: "refreshed-access",
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
      const result = await loaded.service.getCachedSessionSummary();
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "refresh");
      assert.equal(result.sessionSummary.user.email, "jdoe@example.invalid");

      const persisted = JSON.parse(
        loaded.safeStorage.decryptString(fs.readFileSync(loaded.sessionFilePath)),
      );
      assert.equal(persisted.accessToken, "refreshed-access");
      assert.equal(persisted.refreshToken, "refresh-token");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getCachedSessionSummary clears stale sessions when refresh fails", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  const expiredSession = {
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      claims: {},
    },
  };
  writeEncryptedSession(
    loaded.sessionFilePath,
    loaded.safeStorage,
    expiredSession,
  );

  try {
    await withMockFetch(async (url) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
        });
      }

      if (url === "https://example.invalid/oauth/token") {
        return createJsonResponse(
          { error: "invalid_grant" },
          400,
        );
      }

      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.getCachedSessionSummary();
      assert.equal(result.authenticated, false);
      assert.equal(result.source, "refresh_failed");
      assert.equal(result.refreshError.code, "refresh_failed");
      assert.equal(fs.existsSync(loaded.sessionFilePath), false);
      assert.equal(loaded.service.getStatus().phase, "idle");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("concurrent expired-session reads share ONE refresh instead of racing the single-use token", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  const expiredSession = {
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    idToken: createJwt({
      preferred_username: "jdoe",
      name: "Jane Doe",
      email: "jdoe@example.invalid",
      exp: Math.floor(Date.now() / 1000) - 10,
    }),
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email", "read_repository", "read_api"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      email: "jdoe@example.invalid",
      preferredUsername: "jdoe",
      claims: {
        preferred_username: "jdoe",
        name: "Jane Doe",
        email: "jdoe@example.invalid",
      },
    },
  };
  writeEncryptedSession(loaded.sessionFilePath, loaded.safeStorage, expiredSession);

  let tokenCalls = 0;
  try {
    await withMockFetch(async (url, options) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }
      if (url === "https://example.invalid/oauth/token") {
        tokenCalls += 1;
        assert.match(options.body.toString(), /grant_type=refresh_token/);
        // Hold the refresh open so every concurrent caller piles up behind it.
        await new Promise((resolve) => setTimeout(resolve, 50));
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
      const results = await Promise.all([
        loaded.service.getCachedSessionSummary(),
        loaded.service.getCachedSessionSummary(),
        loaded.service.getCachedSessionSummary(),
        loaded.service.getCachedSessionSummary(),
      ]);
      for (const result of results) {
        assert.equal(result.authenticated, true, "every concurrent caller authenticates");
      }
      assert.equal(
        tokenCalls,
        1,
        "one refresh serves the whole burst — a second call would replay the single-use token and get the family revoked",
      );
      const persisted = JSON.parse(
        loaded.safeStorage.decryptString(fs.readFileSync(loaded.sessionFilePath)),
      );
      assert.equal(persisted.accessToken, "refreshed-access");
      assert.equal(persisted.refreshToken, "rotated-refresh");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("a failed refresh never wipes tokens another flow rotated in the meantime", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  const staleSession = {
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      claims: {},
    },
  };
  const rotatedSession = {
    ...staleSession,
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
    expiresAt: Date.now() + 3_600_000,
  };
  writeEncryptedSession(loaded.sessionFilePath, loaded.safeStorage, staleSession);

  try {
    await withMockFetch(async (url) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
        });
      }
      if (url === "https://example.invalid/oauth/token") {
        // Another flow (second window, prior process) lands rotated tokens
        // while this refresh is in flight; the in-flight one then fails as
        // the replay it is.
        writeEncryptedSession(loaded.sessionFilePath, loaded.safeStorage, rotatedSession);
        return createJsonResponse({ error: "invalid_grant" }, 400);
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.getCachedSessionSummary();
      assert.equal(result.authenticated, false);
      assert.equal(result.source, "refresh_failed");
      // The rotated session survives the loser's failure...
      assert.equal(fs.existsSync(loaded.sessionFilePath), true);
      const persisted = JSON.parse(
        loaded.safeStorage.decryptString(fs.readFileSync(loaded.sessionFilePath)),
      );
      assert.equal(persisted.refreshToken, "rotated-refresh");
      // ...and the very next read authenticates from it with zero prompts.
      const next = await loaded.service.getCachedSessionSummary();
      assert.equal(next.authenticated, true);
      assert.equal(next.source, "cache");
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("ensureAuthenticated completes the interactive browser flow and persists a session", async () => {
  let authorizeUrl = null;
  const loaded = await loadGitlabMarketplaceAuthModule({
    shellOpenExternal: async (url) => {
      authorizeUrl = new URL(url);
      const callbackUrl = new URL(
        loaded.config.getGitlabMarketplaceAuthRedirectUri(),
      );
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

  try {
    await withMockFetch(async (url, options) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }

      if (url === "https://example.invalid/oauth/token") {
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
      const result = await loaded.service.ensureAuthenticated();

      assert.equal(result.success, true);
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "interactive");
      assert.equal(result.sessionSummary.user.id, "jdoe");
      assert.equal(authorizeUrl.searchParams.get("client_id"), "test-client-id");
      assert.equal(
        authorizeUrl.searchParams.get("redirect_uri"),
        loaded.config.getGitlabMarketplaceAuthRedirectUri(),
      );
      assert.equal(loaded.service.getStatus().phase, "authenticated");
      assert.equal(fs.existsSync(loaded.sessionFilePath), true);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("ensureAuthenticated ignores stale callbacks and accepts localhost loopback redirects", async () => {
  let authorizeUrl = null;
  const loaded = await loadGitlabMarketplaceAuthModule({
    shellOpenExternal: async (url) => {
      authorizeUrl = new URL(url);

      const staleCallbackUrl = new URL(
        loaded.config.getGitlabMarketplaceAuthRedirectUri(),
      );
      staleCallbackUrl.searchParams.set("code", "stale-code");
      staleCallbackUrl.searchParams.set("state", "stale-state");

      const validCallbackUrl = new URL(
        loaded.config.getGitlabMarketplaceAuthRedirectUri("localhost"),
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
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }

      if (url === "https://example.invalid/oauth/token") {
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
      const result = await loaded.service.ensureAuthenticated();

      assert.equal(result.success, true);
      assert.equal(result.authenticated, true);
      assert.equal(result.source, "interactive");
      assert.equal(result.sessionSummary.user.id, "jdoe");
      assert.equal(loaded.service.getStatus().phase, "authenticated");
      assert.equal(fs.existsSync(loaded.sessionFilePath), true);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getAuthorizedSession surfaces interactive auth failures with the provider error code", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule({
    shellOpenExternal: async (url) => {
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(
        loaded.config.getGitlabMarketplaceAuthRedirectUri(),
      );
      callbackUrl.searchParams.set("error", "access_denied");
      callbackUrl.searchParams.set(
        "error_description",
        "User denied access",
      );
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
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
        });
      }

      return createJsonResponse({}, 404);
    }, async () => {
      await assert.rejects(
        () => loaded.service.getAuthorizedSession({ interactive: true }),
        (error) => {
          assert.equal(error.code, "access_denied");
          assert.match(error.message, /User denied access/);
          return true;
        },
      );
      assert.equal(loaded.service.getStatus().phase, "error");
      const cleared = loaded.service.clearError();
      assert.equal(cleared.phase, "idle");
      assert.equal(cleared.error, null);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("ensureAuthenticated retries token exchange with the optional client secret after invalid_client", async () => {
  let tokenAttempts = 0;
  const loaded = await loadGitlabMarketplaceAuthModule({
    clientSecret: "secret-123",
    shellOpenExternal: async (url) => {
      const authorizeUrl = new URL(url);
      const callbackUrl = new URL(
        loaded.config.getGitlabMarketplaceAuthRedirectUri(),
      );
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

  try {
    await withMockFetch(async (url, options) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
        });
      }

      if (url === "https://example.invalid/oauth/token") {
        tokenAttempts += 1;
        const body = options.body.toString();
        if (tokenAttempts === 1) {
          assert.doesNotMatch(body, /client_secret=/);
          return createJsonResponse({ error: "invalid_client" }, 400);
        }

        assert.match(body, /client_secret=secret-123/);
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
      const result = await loaded.service.ensureAuthenticated();
      assert.equal(result.success, true);
      assert.equal(tokenAttempts, 2);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("getAuthorizedSession rejects missing non-interactive sessions with gitlab_auth_required", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  try {
    await assert.rejects(
      () => loaded.service.getAuthorizedSession({ interactive: false }),
      (error) => {
        assert.equal(error.code, "gitlab_auth_required");
        assert.match(error.message, /authentication is required/i);
        return true;
      },
    );
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

// --- PORTICO-414 parity: refresh provenance without changing the userinfo-fetch decision ---

test("refresh that omits id_token preserves the stored email instead of letting the retained token clobber it", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  const retainedIdToken = createJwt({
    preferred_username: "jdoe",
    name: "Jane Doe",
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  writeEncryptedSession(loaded.sessionFilePath, loaded.safeStorage, {
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    idToken: retainedIdToken,
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email", "read_repository", "read_api"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      email: "kept@example.invalid",
      preferredUsername: "jdoe",
      claims: {
        preferred_username: "jdoe",
        name: "Jane Doe",
        email: "kept@example.invalid",
      },
    },
  });

  try {
    let userinfoCalls = 0;
    await withMockFetch(async (url) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }
      if (url === "https://example.invalid/oauth/token") {
        // No id_token: the stored one is retained for storage only.
        return createJsonResponse({ access_token: "refreshed-access", expires_in: 3600 });
      }
      if (url === "https://example.invalid/oauth/userinfo") {
        userinfoCalls += 1;
        return createJsonResponse({});
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.getCachedSessionSummary();
      assert.equal(result.authenticated, true);
      assert.equal(result.sessionSummary.user.email, "kept@example.invalid");
      assert.equal(userinfoCalls, 0);

      const persisted = JSON.parse(
        loaded.safeStorage.decryptString(fs.readFileSync(loaded.sessionFilePath)),
      );
      assert.equal(persisted.user.email, "kept@example.invalid");
      assert.equal(persisted.idToken, retainedIdToken);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});

test("refresh of an id+name-only session performs zero userinfo lookups (fetch decision unchanged)", async () => {
  const loaded = await loadGitlabMarketplaceAuthModule();
  writeEncryptedSession(loaded.sessionFilePath, loaded.safeStorage, {
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    clientId: "test-client-id",
    issuer: "https://example.invalid",
    scopes: ["openid", "profile", "email", "read_repository", "read_api"],
    expiresAt: Date.now() - 60_000,
    user: {
      id: "jdoe",
      name: "Jane Doe",
      preferredUsername: "jdoe",
      claims: { preferred_username: "jdoe", name: "Jane Doe" },
    },
  });

  try {
    let userinfoCalls = 0;
    await withMockFetch(async (url) => {
      if (url === "https://example.invalid/.well-known/openid-configuration") {
        return createJsonResponse({
          authorization_endpoint: "https://example.invalid/oauth/authorize",
          token_endpoint: "https://example.invalid/oauth/token",
          userinfo_endpoint: "https://example.invalid/oauth/userinfo",
        });
      }
      if (url === "https://example.invalid/oauth/token") {
        return createJsonResponse({ access_token: "refreshed-access", expires_in: 3600 });
      }
      if (url === "https://example.invalid/oauth/userinfo") {
        userinfoCalls += 1;
        return createJsonResponse({ email: "should-not-be-fetched@example.invalid" });
      }
      return createJsonResponse({}, 404);
    }, async () => {
      const result = await loaded.service.getCachedSessionSummary();
      assert.equal(result.authenticated, true);
      // GitLab identity intentionally stays email-less here: viewer identity
      // comes from the Okta session, so no extra lookup is spent.
      assert.equal(result.sessionSummary.user.email, null);
      assert.equal(userinfoCalls, 0);
    });
  } finally {
    loaded.restore();
    cleanupDir(loaded.userDataDir);
  }
});
