// PORTICO-348: Send-enablement rule. A question answered only through capability
// pickers used to be treated as unanswered, leaving Send permanently disabled.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mod;
test.before(async () => {
  mod = await import(
    pathToFileURL(
      path.resolve(__dirname, "..", "src/patches/frontend/src/lib/utils/userQuestionAnswered.js"),
    ).href
  );
});

const q = (overrides = {}) => ({
  id: "q1",
  options: [],
  components: [],
  components_gated_by_option_id: null,
  ...overrides,
});

test("a picked option answers a plain question", () => {
  const question = q({ options: [{ id: "yes" }, { id: "no" }] });
  assert.equal(mod.isQuestionAnswered(question, { selectedOptionId: "yes" }), true);
  assert.equal(mod.isQuestionAnswered(question, {}), false);
});

test("Something else requires a non-empty explanation", () => {
  const question = q({
    options: [{ id: "yes" }, { id: "none_of_the_above" }],
  });
  assert.equal(
    mod.isQuestionAnswered(question, { selectedOptionId: "none_of_the_above" }),
    false,
  );
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "none_of_the_above",
      freeformText: "   ",
    }),
    false,
  );
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "none_of_the_above",
      freeformText: "Use a different option",
    }),
    true,
  );
});

test("freeform answers a question with no options, but not one that only lists real options", () => {
  assert.equal(mod.isQuestionAnswered(q(), { freeformText: "hello" }), true);
  assert.equal(
    mod.isQuestionAnswered(q({ options: [{ id: "yes" }] }), { freeformText: "hello" }),
    false,
    "typing must not substitute for choosing among real options",
  );
  assert.equal(
    mod.isQuestionAnswered(
      q({ options: [{ id: "yes" }, { id: "none_of_the_above" }] }),
      { freeformText: "hello" },
    ),
    true,
    "a none-of-the-above fallback lets freeform count",
  );
});

test("a picker selection alone answers the question", () => {
  // The regression: no option, no text, but the user picked skills.
  const question = q({ components: [{ id: "c1", type: "skill_picker" }] });
  assert.equal(
    mod.isQuestionAnswered(question, { componentSelections: { c1: ["skill-a"] } }),
    true,
  );
  assert.equal(mod.isQuestionAnswered(question, { componentSelections: { c1: [] } }), false);
});

test("a model_picker must carry a pick", () => {
  const question = q({
    components: [
      { id: "m", type: "model_picker" },
      { id: "s", type: "skill_picker" },
    ],
  });
  // Skills chosen but no model -> still unanswered.
  assert.equal(
    mod.isQuestionAnswered(question, { componentSelections: { s: ["skill-a"] } }),
    false,
  );
  assert.equal(
    mod.isQuestionAnswered(question, { componentSelections: { m: [""] } }),
    false,
    "an empty selector slot is not a model selection",
  );
  assert.equal(
    mod.isQuestionAnswered(question, {
      componentSelections: { m: ["claude"], s: ["skill-a"] },
    }),
    true,
  );
  // An empty multi-select is fine as long as the model is picked.
  assert.equal(
    mod.isQuestionAnswered(question, { componentSelections: { m: ["claude"], s: [] } }),
    true,
  );
});

test("an option carrying component_defaults reveals pickers without a gate", () => {
  const question = q({
    options: [
      { id: "recommended", component_defaults: { m: ["claude"] } },
      { id: "plain" },
    ],
    components: [{ id: "m", type: "model_picker" }],
  });
  // No option picked yet: reveal is option-driven, so pickers stay inactive
  // and the question is unanswered.
  assert.equal(mod.areComponentsActive(question, ""), false);
  assert.equal(mod.isQuestionAnswered(question, {}), false);
  // The defaults-bearing option reveals the pickers, so the model mandate
  // applies under it.
  assert.equal(mod.areComponentsActive(question, "recommended"), true);
  assert.equal(mod.isQuestionAnswered(question, { selectedOptionId: "recommended" }), false);
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "recommended",
      componentSelections: { m: ["claude"] },
    }),
    true,
  );
  // Any other option keeps the pickers hidden and answers as a plain option.
  assert.equal(mod.areComponentsActive(question, "plain"), false);
  assert.equal(mod.isQuestionAnswered(question, { selectedOptionId: "plain" }), true);
});

test("a question stays unanswered while its recommended seeds are pending", () => {
  const question = q({
    options: [{ id: "recommended", component_defaults: { s: ["skill-a"] } }],
    components: [{ id: "s", type: "skill_picker" }],
  });
  // Even with the option picked (and stale selections), a pending seed means
  // the answer is not ready to send.
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "recommended",
      componentSelections: { s: ["skill-a"] },
      seedPending: true,
    }),
    false,
  );
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "recommended",
      componentSelections: { s: ["skill-a"] },
      seedPending: false,
    }),
    true,
  );
});

test("gated pickers only apply once their gate option is selected", () => {
  const question = q({
    options: [{ id: "custom" }, { id: "default" }],
    components: [{ id: "m", type: "model_picker" }],
    components_gated_by_option_id: "custom",
  });
  // Gate closed: the plain option is enough, the model pick is not required.
  assert.equal(mod.isQuestionAnswered(question, { selectedOptionId: "default" }), true);
  // Gate open: the model pick becomes mandatory.
  assert.equal(mod.isQuestionAnswered(question, { selectedOptionId: "custom" }), false);
  assert.equal(
    mod.isQuestionAnswered(question, {
      selectedOptionId: "custom",
      componentSelections: { m: ["claude"] },
    }),
    true,
  );
});

test("a pending question form only belongs to the branch where it appeared", () => {
  const history = {
    currentId: "assistant-old",
    messages: {
      root: { id: "root", parentId: null },
      "user-old": { id: "user-old", parentId: "root" },
      "assistant-old": { id: "assistant-old", parentId: "user-old" },
      "user-edit": { id: "user-edit", parentId: "root" },
      "assistant-new": { id: "assistant-new", parentId: "user-edit" },
    },
  };

  assert.equal(
    mod.isUserQuestionAnchorOnActiveBranch(history, "assistant-old"),
    true,
  );

  history.currentId = "assistant-new";
  assert.equal(
    mod.isUserQuestionAnchorOnActiveBranch(history, "assistant-old"),
    false,
    "editing and resending switches to a sibling branch",
  );

  history.currentId = "assistant-old";
  assert.equal(
    mod.isUserQuestionAnchorOnActiveBranch(history, "assistant-old"),
    true,
    "switching back to the original branch restores its pending form",
  );
});
