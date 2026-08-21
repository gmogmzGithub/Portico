const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ldapFromIdentityValue,
  resolveTelemetryIdentityUncached,
} = require("./telemetry-identity");

test("telemetry identity accepts bare and email-shaped authenticated identities", () => {
  assert.equal(ldapFromIdentityValue(" ggomez "), "ggomez");
  assert.equal(ldapFromIdentityValue("ggomez@example.invalid"), "ggomez");
  assert.equal(ldapFromIdentityValue(null), "");
});

test("telemetry identity prefers the authenticated PORTICO user", async () => {
  const identity = await resolveTelemetryIdentityUncached({
    getCurrentUser: async () => ({
      authenticated: true,
      sessionSummary: { user: { id: "authenticated@example.invalid" } },
    }),
    env: { PORTICO_USER_ID: "environment-user" },
    userInfo: () => ({ username: "os-user" }),
    logWarnings: false,
  });

  assert.deepEqual(identity, {
    ldap: "authenticated",
    identitySource: "okta_cached",
  });
});

test("telemetry identity falls back to Portico environment then OS username", async () => {
  const fromEnvironment = await resolveTelemetryIdentityUncached({
    getCurrentUser: async () => ({ authenticated: false }),
    env: { PORTICO_USER_ID: "environment-user@example.invalid" },
    userInfo: () => ({ username: "os-user" }),
    logWarnings: false,
  });
  assert.deepEqual(fromEnvironment, {
    ldap: "environment-user",
    identitySource: "env",
  });

  const fromOs = await resolveTelemetryIdentityUncached({
    getCurrentUser: async () => {
      throw new Error("no session");
    },
    env: {},
    userInfo: () => ({ username: "os-user" }),
    logWarnings: false,
  });
  assert.deepEqual(fromOs, { ldap: "os-user", identitySource: "os_username" });
});
