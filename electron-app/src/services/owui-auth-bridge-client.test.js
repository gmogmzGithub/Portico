// PORTICO-414: buildHumanSessionPayload identity contract — canonical user.email
// first, validated legacy claims.email fallback second, fail closed otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHumanSessionPayload } = require("./owui-auth-bridge-client");

test("payload uses the canonical session email, lowercased", () => {
  const payload = buildHumanSessionPayload({
    user: {
      id: "jdoe",
      name: "Jane Doe",
      email: "  JDoe@example.invalid  ",
      preferredUsername: "jdoe",
      claims: { email: "ignored@example.invalid" },
    },
  });
  assert.equal(payload.email, "jdoe@example.invalid");
  assert.equal(payload.name, "Jane Doe");
  assert.equal(payload.user_id, "jdoe");
  assert.equal(payload.preferred_username, "jdoe");
});

test("an implausible user.email falls back to a validated claims.email (legacy records)", () => {
  const payload = buildHumanSessionPayload({
    user: {
      id: "jdoe",
      name: "Jane Doe",
      email: "not-an-email",
      claims: { email: "Legacy@example.invalid", preferred_username: "jdoe" },
    },
  });
  assert.equal(payload.email, "legacy@example.invalid");
});

test("a legacy record without user.claims still seeds from user.email", () => {
  const payload = buildHumanSessionPayload({
    user: { id: "jdoe", name: "Jane Doe", email: "jdoe@example.invalid" },
  });
  assert.equal(payload.email, "jdoe@example.invalid");
  assert.deepEqual(payload.claims, {});
});

test("seeding fails closed when neither source has a plausible email", () => {
  for (const user of [
    { id: "jdoe", name: "Jane Doe" },
    { id: "jdoe", name: "Jane Doe", email: "bare-handle" },
    { id: "jdoe", name: "Jane Doe", email: "x@", claims: { email: "@x" } },
  ]) {
    assert.throws(
      () => buildHumanSessionPayload({ user }),
      /does not include an email address/,
    );
  }
});

test("name and user_id derivations survive missing fields", () => {
  const payload = buildHumanSessionPayload({
    user: {
      email: "solo@example.invalid",
      claims: { preferred_username: "solo-claims" },
    },
  });
  assert.equal(payload.name, "solo");
  assert.equal(payload.user_id, "solo-claims");
});
