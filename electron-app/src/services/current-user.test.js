const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const currentUserModulePath = require.resolve("./current-user");
const bootstrapModulePath = require.resolve("./bootstrap");
const setupAuthModulePath = require.resolve("./setup-auth");

function loadCurrentUserModule({
  bootstrapExports = { PROJECT_ROOT: "/tmp/project" },
  setupAuthExports = {},
} = {}) {
  const previousBootstrap = require.cache[bootstrapModulePath];
  const previousSetupAuth = require.cache[setupAuthModulePath];
  const previousCurrentUser = require.cache[currentUserModulePath];

  require.cache[bootstrapModulePath] = {
    id: bootstrapModulePath,
    filename: bootstrapModulePath,
    loaded: true,
    exports: bootstrapExports,
  };
  require.cache[setupAuthModulePath] = {
    id: setupAuthModulePath,
    filename: setupAuthModulePath,
    loaded: true,
    exports: setupAuthExports,
  };
  delete require.cache[currentUserModulePath];

  try {
    return require("./current-user");
  } finally {
    delete require.cache[currentUserModulePath];

    if (previousBootstrap) {
      require.cache[bootstrapModulePath] = previousBootstrap;
    } else {
      delete require.cache[bootstrapModulePath];
    }

    if (previousSetupAuth) {
      require.cache[setupAuthModulePath] = previousSetupAuth;
    } else {
      delete require.cache[setupAuthModulePath];
    }

    if (previousCurrentUser) {
      require.cache[currentUserModulePath] = previousCurrentUser;
    }
  }
}

test("current user get syncs authenticated identity into the existing env file", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const envPath = path.join("/tmp/project", ".env");
  let writtenContent = null;

  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    existsSync: (candidatePath) => candidatePath === envPath,
    readFile: async () =>
      [
        "# Existing settings",
        "FOO=1",
        "CLOUDSMITH_API_KEY=protected-release-key",
        "PORTICO_USER_ID=legacy-user",
        "BAR=2",
        "",
      ].join("\n"),
    writeEnvFile: async (candidatePath, content) => {
      assert.equal(candidatePath, envPath);
      writtenContent = content;
    },
    mkdir: async () => {
      throw new Error("mkdir should not run when .env already exists");
    },
    setupAuth: {
      async getCachedSessionSummary() {
        return {
          authenticated: true,
          sessionSummary: {
            user: {
              id: "jdoe",
              name: "Jane Doe",
              email: "jdoe@example.invalid",
              preferredUsername: "jdoe",
            },
          },
          source: "cache",
        };
      },
      async startSetupAuth() {
        throw new Error("ensureAuthenticated should not be called in this test");
      },
      clearSetupAuthError() {
        return null;
      },
      getSetupAuthStatus() {
        return {};
      },
    },
  });

  const result = await service.get();

  assert.equal(result.success, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.source, "cache");
  assert.ok(writtenContent);
  assert.match(writtenContent, /^FOO=1$/m);
  assert.match(writtenContent, /^BAR=2$/m);
  assert.match(
    writtenContent,
    /^CLOUDSMITH_API_KEY=protected-release-key$/m,
  );
  assert.match(writtenContent, /^PORTICO_USER_ID='jdoe'$/m);
  assert.match(writtenContent, /^PORTICO_USER_NAME='Jane Doe'$/m);
  assert.doesNotMatch(writtenContent, /legacy-user/);
  assert.doesNotMatch(writtenContent, /jdoe@portico\.com/);
});

test("identity reconciliation cannot erase a key restored after its initial read", async (t) => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "portico-current-user-protected-env-"),
  );
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const envPath = path.join(projectRoot, ".env");
  fs.writeFileSync(
    envPath,
    "FOO=current\nCLOUDSMITH_API_KEY=manually-restored-key\n",
    { mode: 0o600 },
  );

  let readCount = 0;
  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => projectRoot,
    existsSync: (candidatePath) => candidatePath === envPath,
    readFile: async (candidatePath, encoding) => {
      readCount += 1;
      if (readCount === 1) {
        return "FOO=stale-read-without-key\n";
      }
      return fs.promises.readFile(candidatePath, encoding);
    },
    setupAuth: {},
  });

  await service.syncEnvIdentity({
    user: { id: "jdoe", name: "Jane Doe" },
  });

  const persisted = fs.readFileSync(envPath, "utf8");
  assert.match(persisted, /^FOO=stale-read-without-key$/m);
  assert.match(persisted, /^CLOUDSMITH_API_KEY=manually-restored-key$/m);
  assert.match(persisted, /^PORTICO_USER_ID='jdoe'$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test("current user ensureAuthenticated surfaces login failures without touching env state", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  let writeAttempts = 0;

  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    existsSync: () => false,
    readFile: async () => "",
    writeEnvFile: async () => {
      writeAttempts += 1;
    },
    mkdir: async () => {
      writeAttempts += 1;
    },
    setupAuth: {
      async getCachedSessionSummary() {
        return { authenticated: false, sessionSummary: null };
      },
      async startSetupAuth() {
        return {
          success: false,
          authenticated: false,
          error: "Okta denied access",
          errorCode: "access_denied",
        };
      },
      clearSetupAuthError() {
        return null;
      },
      getSetupAuthStatus() {
        return {};
      },
    },
  });

  const result = await service.ensureAuthenticated();

  assert.deepEqual(result, {
    success: false,
    authenticated: false,
    error: "Okta denied access",
    errorCode: "access_denied",
  });
  assert.equal(writeAttempts, 0);
});

test("current user get surfaces identity sync failures", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const envPath = path.join("/tmp/project", ".env");

  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    existsSync: (candidatePath) => candidatePath === envPath,
    readFile: async () => "PORTICO_USER_ID=legacy\n",
    writeEnvFile: async () => {
      const error = new Error("disk unavailable");
      error.code = "identity_sync_write_failed";
      throw error;
    },
    mkdir: async () => {},
    setupAuth: {
      async getCachedSessionSummary() {
        return {
          authenticated: true,
          success: true,
          sessionSummary: {
            user: {
              id: "jdoe",
              name: "Jane Doe",
            },
          },
          source: "cache",
        };
      },
      async startSetupAuth() {
        throw new Error("not used");
      },
      clearSetupAuthError() {
        return null;
      },
      getSetupAuthStatus() {
        return {};
      },
    },
  });

  const result = await service.get();
  assert.equal(result.success, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.errorCode, "identity_sync_failed");
  assert.equal(
    result.error,
    "The signed-in account could not be saved locally. Try again.",
  );
  assert.doesNotMatch(JSON.stringify(result), /disk unavailable|identity_sync_write_failed/);
});


test("current user redacts interactive identity-sync exception details", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    existsSync: () => false,
    mkdir: async () => undefined,
    writeEnvFile: async () => {
      const error = new Error(
        "Failed to write /Users/example/private/.env for employee@example.com",
      );
      error.code = "EACCES_PRIVATE";
      throw error;
    },
    setupAuth: {
      async startSetupAuth() {
        return {
          success: true,
          authenticated: true,
          source: "interactive",
          sessionSummary: {
            user: { id: "jdoe", name: "Jane Doe" },
          },
        };
      },
      clearSetupAuthError() {
        return null;
      },
      getSetupAuthStatus() {
        return {};
      },
    },
  });

  const result = await service.ensureAuthenticated();
  assert.deepEqual(result, {
    success: false,
    authenticated: false,
    sessionSummary: null,
    source: "interactive",
    error: "The signed-in account could not be saved locally. Try again.",
    errorCode: "identity_sync_failed",
  });
  assert.doesNotMatch(JSON.stringify(result), /Users|employee|EACCES_PRIVATE/);
});

test("repairIdentity delegates to setup auth and audits the outcome without recording the email", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const auditLines = [];
  const repairResult = {
    authenticated: true,
    repaired: true,
    source: "identity_repair",
    sessionSummary: {
      user: { id: "jdoe", name: "Jane Doe", email: "jdoe@example.invalid" },
    },
  };

  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    logger: {
      info: (line) => {
        auditLines.push(line);
      },
    },
    setupAuth: {
      async repairSessionIdentity() {
        return repairResult;
      },
    },
  });

  const result = await service.repairIdentity();
  assert.equal(result, repairResult);

  const auditLine = auditLines.find((line) => line.includes("identity_repair"));
  assert.ok(auditLine, "expected an identity_repair audit line");
  const payload = JSON.parse(auditLine.replace("[Identity Audit] ", ""));
  assert.equal(payload.event, "identity_repair");
  assert.equal(payload.success, true);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.source, "identity_repair");
  assert.equal(payload.safeErrorCode, null);
  assert.doesNotMatch(auditLine, /jdoe@portico\.com/);
});

test("repairIdentity audits an unrepairable session with its reason as the safe error code", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const auditLines = [];

  const service = createCurrentUserService({
    identityMode: "oidc",
    getProjectRoot: () => "/tmp/project",
    logger: {
      info: (line) => {
        auditLines.push(line);
      },
    },
    setupAuth: {
      async repairSessionIdentity() {
        return {
          authenticated: true,
          repaired: false,
          reason: "email_unavailable",
          emailUnavailable: true,
          terminal: false,
        };
      },
    },
  });

  const result = await service.repairIdentity();
  assert.equal(result.emailUnavailable, true);

  const auditLine = auditLines.find((line) => line.includes("identity_repair"));
  assert.ok(auditLine, "expected an identity_repair audit line");
  const payload = JSON.parse(auditLine.replace("[Identity Audit] ", ""));
  assert.equal(payload.success, false);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.safeErrorCode, "email_unavailable");
});

test("identity audits record email presence as a boolean, never the address", async () => {
  const { createCurrentUserService } = loadCurrentUserModule();
  const auditLines = [];
  const makeService = (email) =>
    createCurrentUserService({
      identityMode: "oidc",
      getProjectRoot: () => "/tmp/project",
      existsSync: () => true,
      readFile: async () => "",
      writeEnvFile: async () => {},
      chmod: async () => {},
      logger: {
        info: (line) => {
          auditLines.push(line);
        },
      },
      setupAuth: {
        async getCachedSessionSummary() {
          return {
            authenticated: true,
            sessionSummary: {
              user: { id: "jdoe", name: "Jane Doe", email },
            },
            source: "cache",
          };
        },
      },
    });

  await makeService("jdoe@example.invalid").get();
  await makeService(null).get();

  const payloads = auditLines
    .filter((line) => line.includes("identity_reconciliation"))
    .map((line) => JSON.parse(line.replace("[Identity Audit] ", "")));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].emailAvailable, true);
  assert.equal(payloads[1].emailAvailable, false);
  assert.equal(payloads[1].authenticated, true);
  assert.doesNotMatch(JSON.stringify(payloads), /jdoe@portico\.com/);
});

test("public checkout uses a stable local identity when OIDC is not configured", async () => {
  const { createCurrentUserService, _test } = loadCurrentUserModule();
  assert.equal(_test.resolveIdentityMode({}), "local");

  let synchronized = null;
  const service = createCurrentUserService({
    identityMode: "local",
    getProjectRoot: () => "/tmp/project",
    existsSync: () => false,
    mkdir: async () => {},
    writeEnvFile: async (_path, content) => {
      synchronized = content;
    },
    setupAuth: {
      async getCachedSessionSummary() {
        throw new Error("local identity must not consult OIDC cache");
      },
      async startSetupAuth() {
        throw new Error("local identity must not start an OIDC flow");
      },
    },
  });

  const result = await service.ensureAuthenticated();
  assert.equal(result.success, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.source, "local");
  assert.equal(result.sessionSummary.user.id, "local-user");
  assert.equal(result.sessionSummary.user.email, "local-user@portico.invalid");
  assert.match(synchronized, /^PORTICO_USER_ID='local-user'$/m);
  assert.match(synchronized, /^PORTICO_USER_NAME='Local User'$/m);
  assert.equal(service.status().phase, "authenticated");
});

test("OIDC identity is opt-in and rejects incomplete or unknown modes", () => {
  const { _test } = loadCurrentUserModule();

  assert.equal(
    _test.resolveIdentityMode({
      SETUP_AUTH_ISSUER: "https://identity.example.com/oauth2/default",
    }),
    "oidc",
  );
  assert.equal(
    _test.resolveIdentityMode({
      PORTICO_IDENTITY_MODE: "oidc",
      SETUP_AUTH_ISSUER: "https://identity.example.com/oauth2/default",
    }),
    "oidc",
  );
  assert.equal(
    _test.resolveIdentityMode({ PORTICO_IDENTITY_MODE: "oidc" }),
    "invalid",
  );
  assert.equal(
    _test.resolveIdentityMode({ PORTICO_IDENTITY_MODE: "something-else" }),
    "invalid",
  );
});
