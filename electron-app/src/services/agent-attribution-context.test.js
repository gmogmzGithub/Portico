const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  getAgentAttributionContext,
  resolveAuthenticatedCreatorIdentity,
  resolveAuthenticatedEmail,
} = require("./agent-attribution-context");

test("authenticated identity uses the exact trimmed session email without domain guessing", async () => {
  assert.equal(
    await resolveAuthenticatedEmail({
      getCurrentUser: async () => ({
        authenticated: true,
        sessionSummary: { user: { email: "  Mixed.Case@Example.org  " } },
      }),
    }),
    "Mixed.Case@Example.org",
  );

  await assert.rejects(
    () =>
      resolveAuthenticatedEmail({
        getCurrentUser: async () => ({
          authenticated: true,
          sessionSummary: { user: { email: "bare-handle" } },
        }),
      }),
    (error) => error?.code === "missing_user_identity",
  );
});

test("shared creator identity returns exact email and session LDAP without OS fallback", async () => {
  assert.deepEqual(
    await resolveAuthenticatedCreatorIdentity({
      getCurrentUser: async () => ({
        authenticated: true,
        sessionSummary: {
          user: {
            email: "  Mixed.Case@Example.org  ",
            preferredUsername: "  mcase  ",
            id: "ignored-id",
          },
        },
      }),
    }),
    { email: "Mixed.Case@Example.org", ldap: "mcase" },
  );

  assert.deepEqual(
    await resolveAuthenticatedCreatorIdentity({
      getCurrentUser: async () => ({
        authenticated: true,
        sessionSummary: { user: { email: "fallback.user@example.org" } },
      }),
    }),
    { email: "fallback.user@example.org", ldap: "fallback.user" },
  );

  // Behavioral no-OS-fallback proof (replaces a banned source-text pin): a
  // session with an LDAP-shaped identity but no email must fail closed —
  // never fall back to the OS account or invent an @example.invalid address.
  await assert.rejects(
    () =>
      resolveAuthenticatedCreatorIdentity({
        getCurrentUser: async () => ({
          authenticated: true,
          sessionSummary: {
            user: { preferredUsername: "mcase", id: "mcase", email: null },
          },
        }),
      }),
    (error) => {
      assert.equal(error?.code, "missing_user_identity");
      return true;
    },
  );
});

test("identity resolution fails closed when authentication or email is unavailable", async () => {
  for (const result of [
    { authenticated: false, sessionSummary: { user: { email: "user@example.com" } } },
    { authenticated: true, sessionSummary: { user: { email: "   " } } },
  ]) {
    await assert.rejects(
      () => resolveAuthenticatedEmail({ getCurrentUser: async () => result }),
      (error) => error?.code === "missing_user_identity",
    );
  }
});

test("attribution context returns strict links and propagates registry corruption", async () => {
  const identity = {
    authenticated: true,
    sessionSummary: { user: { email: "user@example.com" } },
  };
  assert.deepEqual(
    await getAgentAttributionContext({
      getCurrentUser: async () => identity,
      readLinksStrict: async () => ({ "agent-1": { relationship: "published" } }),
    }),
    {
      email: "user@example.com",
      links: { "agent-1": { relationship: "published" } },
    },
  );

  await assert.rejects(
    () =>
      getAgentAttributionContext({
        getCurrentUser: async () => identity,
        readLinksStrict: async () => {
          throw new SyntaxError("malformed registry");
        },
      }),
    (error) => error?.code === "agent_link_registry_unreadable",
  );
});

// Behavioral replacement for a banned source-text pin: boot the REAL express
// app from api.js (electron/current-user/setup-auth swapped in require.cache,
// mirroring the setup-auth.test.js harness convention) and drive the three
// identity endpoints over HTTP. The Subagents server fails closed on these
// routes, so both the authenticated payload shapes and the coded 503 are the
// contract worth pinning.
async function withIdentityApiServer(currentUserExports, run) {
  const os = require("node:os");
  const electronPath = require.resolve("electron");
  const bootstrapPath = require.resolve("./bootstrap");
  const currentUserPath = require.resolve("./current-user");
  const setupAuthPath = require.resolve("./setup-auth");
  const apiPath = require.resolve("./api");
  const saved = new Map(
    [electronPath, bootstrapPath, currentUserPath, setupAuthPath, apiPath].map(
      (id) => [id, require.cache[id]],
    ),
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "attribution-api-"));

  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub(electronPath, {
    app: {
      getPath: () => tempRoot,
      getVersion: () => "0.0.0-test",
      getAppPath: () => tempRoot,
      isPackaged: false,
      on: () => {},
    },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: {},
    shell: {},
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    clipboard: {},
    session: {},
  });
  // Inert setup-auth: the real module binds the loopback OAuth broker at
  // require time, which must never run inside a unit suite.
  stub(setupAuthPath, {
    clearSetupAuthError: () => ({}),
    getCachedSessionSummary: async () => ({ authenticated: false, sessionSummary: null }),
    getAuthorizedSession: async () => {
      throw new Error("setup-auth is stubbed in this suite");
    },
    getSetupAuthStatus: () => ({}),
    repairSessionIdentity: async () => ({ authenticated: false, repaired: false }),
    startOwuiAuthBroker: async () => {},
    startSetupAuth: async () => ({ success: false }),
    stopSetupAuthBroker: async () => {},
    _test: {},
  });
  stub(currentUserPath, {
    get: async () => ({ authenticated: false, sessionSummary: null }),
    ensureAuthenticated: async () => ({ authenticated: false }),
    repairIdentity: async () => ({ authenticated: false, repaired: false }),
    status: () => ({}),
    clearError: async () => null,
    syncEnvIdentity: async () => ({}),
    createCurrentUserService: () => ({}),
    _test: {},
    ...currentUserExports,
  });
  delete require.cache[bootstrapPath];
  delete require.cache[apiPath];
  const realBootstrap = require("./bootstrap");
  stub(
    bootstrapPath,
    new Proxy(realBootstrap, {
      get: (target, property) =>
        property === "PROJECT_ROOT" ? tempRoot : target[property],
    }),
  );

  let server = null;
  try {
    const api = require("./api");
    const apiApp = api.createApiServer();
    server = apiApp.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await run(async (route) => {
      const response = await fetch(baseUrl + route);
      return { status: response.status, body: await response.json() };
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [id, entry] of saved) {
      if (entry) require.cache[id] = entry;
      else delete require.cache[id];
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("localhost API serves identity-only and strict reconciliation endpoints from the session", async () => {
  await withIdentityApiServer(
    {
      get: async () => ({
        authenticated: true,
        sessionSummary: {
          user: { email: "jdoe@example.invalid", preferredUsername: "jdoe" },
        },
      }),
    },
    async (getJson) => {
      const creator = await getJson("/api/creator-identity/current-user");
      assert.equal(creator.status, 200);
      assert.deepEqual(creator.body, { email: "jdoe@example.invalid", ldap: "jdoe" });

      const attribution = await getJson("/api/agent-attribution/current-user");
      assert.equal(attribution.status, 200);
      assert.deepEqual(attribution.body, { email: "jdoe@example.invalid" });

      const context = await getJson("/api/agent-attribution/context");
      assert.equal(context.status, 200);
      assert.equal(context.body.email, "jdoe@example.invalid");
      assert.deepEqual(context.body.links, {});
    },
  );
});

test("localhost API identity endpoints fail closed with coded 503s when the session has no identity", async () => {
  await withIdentityApiServer(
    {
      get: async () => ({ authenticated: true, sessionSummary: { user: {} } }),
    },
    async (getJson) => {
      for (const route of [
        "/api/creator-identity/current-user",
        "/api/agent-attribution/current-user",
        "/api/agent-attribution/context",
      ]) {
        const result = await getJson(route);
        assert.equal(result.status, 503, `${route} status`);
        assert.equal(result.body.code, "missing_user_identity", `${route} code`);
      }
    },
  );
});
