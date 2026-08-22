const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadAuthSessionWithMocks({ currentUser, bridgeClient }) {
  const targetPath = require.resolve("./owui-auth-session");
  const currentUserPath = require.resolve("./current-user");
  const bridgePath = require.resolve("./owui-auth-bridge-client");
  const previous = {
    target: require.cache[targetPath],
    currentUser: require.cache[currentUserPath],
    bridge: require.cache[bridgePath],
  };
  delete require.cache[targetPath];
  require.cache[currentUserPath] = {
    id: currentUserPath,
    filename: currentUserPath,
    loaded: true,
    exports: currentUser,
  };
  require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: bridgeClient,
  };
  const loaded = require("./owui-auth-session");
  return {
    loaded,
    restore() {
      delete require.cache[targetPath];
      if (previous.target) require.cache[targetPath] = previous.target;
      else delete require.cache[targetPath];
      if (previous.currentUser) require.cache[currentUserPath] = previous.currentUser;
      else delete require.cache[currentUserPath];
      if (previous.bridge) require.cache[bridgePath] = previous.bridge;
      else delete require.cache[bridgePath];
    },
  };
}

test("ensureOwuiHumanSessionForUrl waits and returns a handoff bootstrap URL", async () => {
  const calls = [];
  const owuiSession = {};
  const session = {
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "Example User",
    },
  };
  const { loaded, restore } = loadAuthSessionWithMocks({
    currentUser: {
      get: async () => ({
        success: true,
        authenticated: true,
        sessionSummary: session,
      }),
    },
    bridgeClient: {
      OPEN_WEBUI_HOME_URL: "http://localhost:3789",
      safeRedirectPath: (value) => new URL(value, "http://localhost:3789").pathname,
      waitForOwuiReady: async () => calls.push("ready"),
      postHumanSession: async (_session, payload) => {
        calls.push(["post", payload.handoff, payload.redirect]);
        return { complete_url: "/api/v1/portico/auth/complete?handoff_id=abc123" };
      },
    },
  });

  try {
    const target = "http://localhost:3789/c/abc";
    const result = await loaded.ensureOwuiHumanSessionForUrl({
      owuiSession,
      targetUrl: target,
    });
    assert.equal(
      result,
      "http://localhost:3789/api/v1/portico/auth/complete?handoff_id=abc123",
    );
    assert.deepEqual(calls, ["ready", ["post", true, "/c/abc"]]);
    assert.equal(owuiSession.__porticoOwuiAuthSeed.pending, true);
  } finally {
    restore();
  }
});

test("ensureOwuiHumanSessionForUrl fails closed when OWUI readiness/auth seeding fails", async () => {
  const { loaded, restore } = loadAuthSessionWithMocks({
    currentUser: {
      get: async () => ({
        success: true,
        authenticated: true,
        sessionSummary: {
          user: { id: "user-1", email: "user@example.com" },
        },
      }),
    },
    bridgeClient: {
      OPEN_WEBUI_HOME_URL: "http://localhost:3789",
      safeRedirectPath: () => "/",
      waitForOwuiReady: async () => {
        throw new Error("OWUI did not become ready");
      },
      postHumanSession: async () => {
        throw new Error("should not post before readiness");
      },
    },
  });

  try {
    await assert.rejects(
      loaded.ensureOwuiHumanSessionForUrl({
        owuiSession: {},
        targetUrl: "http://localhost:3789/",
      }),
      /OWUI did not become ready/,
    );
  } finally {
    restore();
  }
});

test("verified OWUI auth seed is reused for the same setup user", async () => {
  const calls = [];
  const owuiSession = {
    __porticoOwuiAuthSeed: {
      userId: "user-1",
      seededAt: Date.now(),
      pending: false,
    },
  };
  const { loaded, restore } = loadAuthSessionWithMocks({
    currentUser: {
      get: async () => ({
        success: true,
        authenticated: true,
        sessionSummary: {
          user: { id: "user-1", email: "user@example.com" },
        },
      }),
    },
    bridgeClient: {
      OPEN_WEBUI_HOME_URL: "http://localhost:3789",
      safeRedirectPath: () => "/",
      waitForOwuiReady: async () => calls.push("ready"),
      postHumanSession: async () => {
        throw new Error("fresh verified seed should not post");
      },
    },
  });

  try {
    const target = "http://localhost:3789/";
    const result = await loaded.ensureOwuiHumanSessionForUrl({
      owuiSession,
      targetUrl: target,
    });
    assert.equal(result, target);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test("OWUI view loader does not load raw OWUI when auth seeding fails", () => {
  const source = fs.readFileSync(path.join(__dirname, "owui-views.js"), "utf8");
  const catchIndex = source.indexOf(
    'console.warn("[OWUI] Failed to seed authenticated OWUI session:"',
  );
  assert.notEqual(catchIndex, -1);
  const loadIndex = source.indexOf("await entry.view.webContents.loadURL(loadUrl);", catchIndex);
  const returnIndex = source.indexOf("return;", catchIndex);
  assert.ok(returnIndex > catchIndex);
  assert.ok(returnIndex < loadIndex);
});

test("OWUI view loader verifies localStorage-backed frontend auth after load", () => {
  const source = fs.readFileSync(path.join(__dirname, "owui-views.js"), "utf8");
  assert.match(source, /function verifyOwuiFrontendAuth/);
  assert.match(source, /localStorage\.getItem\("token"\)/);
  assert.match(source, /fetch\("\/api\/v1\/auths\/"/);
  assert.match(source, /verifyOwuiFrontendAuthWithOneReseed\(entry, targetUrl, "authenticated"\)/);
  assert.match(source, /showOwuiAuthFailure\(entry, retryError\.message\)/);
});

test("OWUI view loader rejects pending frontend auth and retries handoff once", () => {
  const source = fs.readFileSync(path.join(__dirname, "owui-views.js"), "utf8");
  assert.match(source, /const role = typeof payload\?\.role === "string" \? payload\.role : null/);
  assert.match(source, /const allowedRoles = new Set\(\["admin", "user"\]\)/);
  assert.match(source, /ok: response\.ok && allowedRoles\.has\(role\)/);
  assert.match(source, /unsupported_role:/);
  assert.match(source, /function verifyOwuiFrontendAuthWithOneReseed/);
  assert.match(source, /clearOwuiHumanSessionSeed\(getOwuiSession\(\)\)/);
  assert.match(source, /const retryLoadUrl = await ensureOwuiHumanSessionForUrl/);
  assert.match(source, /await entry\.view\.webContents\.loadURL\(retryLoadUrl\)/);
  assert.match(source, /Failed to verify authenticated OWUI frontend after reseed/);
});
