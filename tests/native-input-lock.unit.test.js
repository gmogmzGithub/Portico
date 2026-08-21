// PORTICO-348: behavioural home for the composer-locking rule that used to be
// pinned by a source-text regex in user-message-edit-light-mode.unit.test.js.
// The pin asserted the literal expression and so never exercised the logic; it
// also broke as soon as inline questions changed the rule.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = path.resolve(
  __dirname,
  "..",
  "src/patches/frontend/src/lib/utils/nativeInputLock.js",
);

let lock;
test.before(async () => {
  lock = await import(pathToFileURL(modulePath).href);
});

const flow = (overrides = {}) => ({
  kind: "user_question",
  flow_id: "flow-1",
  chat_id: "chat-a",
  presentation: "visible",
  ...overrides,
});

test("marketplace_publish never inerts a composer", () => {
  // It is not chat-scoped: its pill is informational in whichever chat is open.
  const flows = [flow({ kind: "marketplace_publish", chat_id: null, presentation: "hidden" })];
  assert.equal(lock.isNativeInputInteractionLocked(flows, "chat-a"), false);
  assert.equal(lock.isNativeInputInteractionLocked(flows, "chat-b"), false);
});

test("an inline question locks only its own chat", () => {
  const flows = [flow({ chat_id: "chat-a" })];
  assert.equal(lock.isNativeInputInteractionLocked(flows, "chat-a"), true);
  assert.equal(
    lock.isNativeInputInteractionLocked(flows, "chat-b"),
    false,
    "a question in another chat must never inert this composer",
  );
});

test("an inline question locks regardless of presentation", () => {
  // Inline questions have no "hidden" state -- pending is enough.
  for (const presentation of ["visible", "hidden"]) {
    assert.equal(
      lock.isNativeInputInteractionLocked([flow({ presentation })], "chat-a"),
      true,
    );
  }
});

test("modal-backed kinds lock only while minimized", () => {
  for (const kind of ["sensitive_info", "chat_workspace_consent"]) {
    assert.equal(
      lock.isNativeInputInteractionLocked([flow({ kind, presentation: "visible" })], "chat-a"),
      false,
      `${kind}: a visible modal already blocks; the composer rule stays hidden-only`,
    );
    assert.equal(
      lock.isNativeInputInteractionLocked([flow({ kind, presentation: "hidden" })], "chat-a"),
      true,
      `${kind}: a minimized modal must inert its chat's composer`,
    );
  }
});

test("no pending flows leaves the composer usable", () => {
  assert.equal(lock.isNativeInputInteractionLocked([], "chat-a"), false);
  assert.equal(lock.isNativeInputInteractionLocked(null, "chat-a"), false);
  assert.equal(lock.isNativeInputInteractionLocked([flow()], ""), false);
});
