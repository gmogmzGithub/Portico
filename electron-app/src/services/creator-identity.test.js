// PORTICO-414: creator identity fails closed on any implausible email — never an
// OS-account fallback, never an invented domain.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CreatorIdentityError,
  getCurrentCreatorIdentity,
  resolveAuthenticatedCreatorIdentity,
} = require("./creator-identity");

const identityFor = (user, authenticated = true) => ({
  getCurrentUser: async () => ({
    authenticated,
    sessionSummary: { user },
  }),
});

test("resolves email plus LDAP with preferredUsername > email local part > session id precedence", async () => {
  assert.deepEqual(
    await resolveAuthenticatedCreatorIdentity(
      identityFor({
        email: " JDoe@example.invalid ",
        preferredUsername: "jdoe-preferred",
        id: "jdoe-id",
      }),
    ),
    { email: "JDoe@example.invalid", ldap: "jdoe-preferred" },
  );
  assert.deepEqual(
    await resolveAuthenticatedCreatorIdentity(
      identityFor({ email: "local.part@example.invalid", id: "jdoe-id" }),
    ),
    { email: "local.part@example.invalid", ldap: "local.part" },
  );
  // An @-bearing LDAP candidate is stripped to its local part.
  assert.deepEqual(
    await resolveAuthenticatedCreatorIdentity(
      identityFor({
        email: "jdoe@example.invalid",
        preferredUsername: "jdoe@example.invalid",
      }),
    ),
    { email: "jdoe@example.invalid", ldap: "jdoe" },
  );
});

test("fails closed for unauthenticated, email-less, or implausible-email sessions", async () => {
  const cases = [
    { user: { email: "jdoe@example.invalid" }, authenticated: false },
    { user: { preferredUsername: "jdoe", id: "jdoe" }, authenticated: true },
    { user: { email: "   ", preferredUsername: "jdoe" }, authenticated: true },
    { user: { email: "bare-handle" }, authenticated: true },
    { user: { email: "x@" }, authenticated: true },
  ];
  for (const { user, authenticated } of cases) {
    await assert.rejects(
      () => resolveAuthenticatedCreatorIdentity(identityFor(user, authenticated)),
      (error) => {
        assert.ok(error instanceof CreatorIdentityError);
        assert.equal(error.code, "missing_user_identity");
        return true;
      },
    );
  }
});

test("a failing current-user lookup surfaces as a coded error with its cause attached", async () => {
  const cause = new Error("ipc unavailable");
  await assert.rejects(
    () =>
      getCurrentCreatorIdentity({
        getCurrentUser: async () => {
          throw cause;
        },
      }),
    (error) => {
      assert.equal(error.code, "missing_user_identity");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});
