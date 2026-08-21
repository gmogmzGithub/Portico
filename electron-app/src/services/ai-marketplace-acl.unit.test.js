// Behavior tests for the marketplace visibility policy: the union of a
// listing's current ACL with the publishing agent's audience, where an empty
// list means public and public absorbs.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeEffectiveAllowedEmails,
  normalizeAllowedEmailList,
} = require("./ai-marketplace-acl");

const A = "a@example.invalid";
const B = "b@example.invalid";

test("create inherits the agent audience verbatim", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({
      currentAllowedEmails: null,
      audiences: [[A, B]],
    }),
    { allowedEmails: [A, B], changed: false },
  );
});

test("create under a public agent is public", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: null, audiences: [[]] }),
    { allowedEmails: [], changed: false },
  );
});

test("create with no audience context defaults public (backend default)", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: null, audiences: [null] }),
    { allowedEmails: [], changed: false },
  );
  assert.deepEqual(computeEffectiveAllowedEmails({}), {
    allowedEmails: [],
    changed: false,
  });
});

test("an existing public listing stays public regardless of audience", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: [], audiences: [[A]] }),
    { allowedEmails: [], changed: false },
  );
});

test("a public agent widens a restricted listing to public (the incident remediation)", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: [A], audiences: [[]] }),
    { allowedEmails: [], changed: true },
  );
});

test("restricted audiences union and report drift", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: [A], audiences: [[B]] }),
    { allowedEmails: [A, B], changed: true },
  );
});

test("a subset audience is a no-op", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: [A, B], audiences: [[A]] }),
    { allowedEmails: [A, B], changed: false },
  );
});

test("a null audience preserves the accumulated ACL exactly", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({ currentAllowedEmails: [A], audiences: [null] }),
    { allowedEmails: [A], changed: false },
  );
});

test("normalization: case, whitespace, dupes, and ordering never count as drift", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({
      currentAllowedEmails: [B, A],
      audiences: [[` ${A.toUpperCase()} `, A, ""]],
    }),
    { allowedEmails: [A, B], changed: false },
  );
});

test("multiple audiences union together with public absorbing", () => {
  assert.deepEqual(
    computeEffectiveAllowedEmails({
      currentAllowedEmails: [A],
      audiences: [[B], null],
    }),
    { allowedEmails: [A, B], changed: true },
  );
  assert.deepEqual(
    computeEffectiveAllowedEmails({
      currentAllowedEmails: [A],
      audiences: [[B], []],
    }),
    { allowedEmails: [], changed: true },
  );
});

test("normalizeAllowedEmailList drops non-strings and blanks, sorts and dedupes", () => {
  assert.deepEqual(
    normalizeAllowedEmailList([B, 42, null, ` ${A} `, A.toUpperCase(), ""]),
    [A, B],
  );
  assert.deepEqual(normalizeAllowedEmailList("not-an-array"), []);
});
