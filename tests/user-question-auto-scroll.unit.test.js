// Auto-scroll decision for the inline ask-user-question card. The Svelte
// wiring (Messages.svelte) scrolls exactly when this key CHANGES to a
// non-empty value; these tests pin the key semantics.
const test = require("node:test");
const assert = require("node:assert/strict");

const utilPromise = import(
  "../src/patches/frontend/src/lib/utils/userQuestionAutoScroll.js"
);

const flow = (overrides = {}) => ({
  flowId: "flow-1",
  questions: [{ id: "q1" }],
  ...overrides,
});

const fourQuestions = [{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }];

test("a visible flow produces a stable key; identical inputs never re-key", async () => {
  const { userQuestionAutoScrollKey } = await utilPromise;
  const key = userQuestionAutoScrollKey(flow());
  assert.equal(key, "uq-scroll:flow-1:1:0");
  assert.equal(userQuestionAutoScrollKey(flow()), key, "same flow -> same key (no re-scroll)");
  assert.equal(
    userQuestionAutoScrollKey(flow(), 0),
    key,
    "explicit index 0 matches the omitted-index key",
  );
});

test("no flow, blank ids, and empty question lists produce no key (no scroll)", async () => {
  const { userQuestionAutoScrollKey } = await utilPromise;
  assert.equal(userQuestionAutoScrollKey(null), "");
  assert.equal(userQuestionAutoScrollKey(undefined), "");
  assert.equal(userQuestionAutoScrollKey(flow({ flowId: "  " })), "");
  assert.equal(userQuestionAutoScrollKey(flow({ questions: [] })), "");
  assert.equal(userQuestionAutoScrollKey(flow({ questions: null })), "");
});

test("a new flow or an appended question page re-keys (re-scroll); legacy id field accepted", async () => {
  const { userQuestionAutoScrollKey } = await utilPromise;
  const first = userQuestionAutoScrollKey(flow());
  const newFlow = userQuestionAutoScrollKey(flow({ flowId: "flow-2" }));
  const grown = userQuestionAutoScrollKey(flow({ questions: [{ id: "q1" }, { id: "q2" }] }));
  assert.notEqual(newFlow, first);
  assert.notEqual(grown, first);
  assert.equal(
    userQuestionAutoScrollKey({ id: "legacy", questions: [{}] }),
    "uq-scroll:legacy:1:0",
  );
});

test("switching questions re-keys in both directions (a taller next question must be revealed)", async () => {
  const { userQuestionAutoScrollKey } = await utilPromise;
  const multi = flow({ questions: fourQuestions });
  const atQ1 = userQuestionAutoScrollKey(multi, 0);
  const atQ3 = userQuestionAutoScrollKey(multi, 2);
  const backToQ1 = userQuestionAutoScrollKey(multi, 0);
  assert.notEqual(atQ3, atQ1, "Next re-keys");
  assert.equal(backToQ1, atQ1, "Back to the same question restores the same key");
  assert.equal(atQ3, "uq-scroll:flow-1:4:2");
});

test("out-of-range and malformed indexes clamp instead of minting phantom keys", async () => {
  const { userQuestionAutoScrollKey } = await utilPromise;
  const multi = flow({ questions: fourQuestions });
  assert.equal(
    userQuestionAutoScrollKey(multi, 99),
    userQuestionAutoScrollKey(multi, 3),
    "beyond-last clamps to the last question",
  );
  assert.equal(
    userQuestionAutoScrollKey(multi, -1),
    userQuestionAutoScrollKey(multi, 0),
    "negative clamps to the first question",
  );
  assert.equal(userQuestionAutoScrollKey(multi, 1.5), userQuestionAutoScrollKey(multi, 0));
  assert.equal(userQuestionAutoScrollKey(multi, "2"), userQuestionAutoScrollKey(multi, 0));
});
