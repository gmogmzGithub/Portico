const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildReasoningEffortFieldState,
  normalizeReasoningEffortForSubmission,
} = require("../renderer/components/agent-reasoning-options");

const BASE_MODELS = [
  {
    id: "GPT-5.6 Sol",
    supports_reasoning: true,
    reasoning_effort_options: [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ],
  },
  {
    id: "GPT-5.6 Sol Pro",
    supports_reasoning: true,
    reasoning_effort_options: [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
  },
  {
    id: "GPT-5.6 Terra",
    supports_reasoning: true,
    reasoning_effort_options: [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ],
  },
  {
    id: "Atlas Haiku",
    supports_reasoning: false,
    reasoning_effort_options: [],
  },
];

test("new-agent field caps the Sol catalog options at Max", () => {
  const state = buildReasoningEffortFieldState(
    BASE_MODELS,
    "GPT-5.6 Sol",
    null,
  );

  assert.equal(state.disabled, false);
  assert.equal(state.selectedValue, "");
  assert.deepEqual(state.options, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(state.options.includes("ultra"), false);
});

test("edit field downgrades existing Sol Ultra values and resets values invalid for the new base", () => {
  assert.equal(
    buildReasoningEffortFieldState(
      BASE_MODELS,
      "GPT-5.6 Sol",
      "ultra",
    ).selectedValue,
    "max",
  );
  assert.equal(
    buildReasoningEffortFieldState(
      BASE_MODELS,
      "GPT-5.6 Sol Pro",
      "ultra",
    ).selectedValue,
    "",
  );
  assert.equal(
    buildReasoningEffortFieldState(
      BASE_MODELS,
      "GPT-5.6 Terra",
      "max",
    ).selectedValue,
    "max",
  );
});

test("edit field downgrades Ultra across Sol latest aliases", () => {
  const aliasedModels = BASE_MODELS.map((model) =>
    model.id === "GPT-5.6 Sol"
      ? { ...model, id: "gpt-5.6 sol:LATEST" }
      : model,
  );

  assert.equal(
    buildReasoningEffortFieldState(
      aliasedModels,
      "GPT-5.6 Sol",
      "ultra",
    ).selectedValue,
    "max",
  );
});

test("Sol provider aliases also cap Ultra at Max", () => {
  const providerAliases = [
    "gpt-5.6-sol:latest",
    "openai/responses/gpt-5.6-sol",
    "portico-openai/gpt-5.6-sol",
  ];

  for (const alias of providerAliases) {
    const aliasedModels = BASE_MODELS.map((model) =>
      model.id === "GPT-5.6 Sol" ? { ...model, id: alias } : model,
    );
    const state = buildReasoningEffortFieldState(
      aliasedModels,
      alias,
      "ultra",
    );
    assert.equal(state.options.includes("ultra"), false);
    assert.equal(state.selectedValue, "max");
  }
});

test("submitted payload keeps valid values and clears invalid or unsupported values", () => {
  assert.equal(
    normalizeReasoningEffortForSubmission(
      BASE_MODELS,
      "GPT-5.6 Sol",
      "none",
    ),
    "none",
  );
  assert.equal(
    normalizeReasoningEffortForSubmission(
      BASE_MODELS,
      "GPT-5.6 Sol",
      "ultra",
    ),
    "max",
  );
  assert.equal(
    normalizeReasoningEffortForSubmission(
      BASE_MODELS,
      "GPT-5.6 Sol Pro",
      "ultra",
    ),
    null,
  );
  assert.equal(
    normalizeReasoningEffortForSubmission(
      BASE_MODELS,
      "Atlas Haiku",
      "high",
    ),
    null,
  );
});

test("agent create and edit forms use catalog validation for their payload", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../renderer/components/agents.js"),
    "utf8",
  );
  assert.match(source, /buildReasoningEffortFieldState\(/);
  assert.match(source, /normalizeReasoningEffortForSubmission\(/);
  assert.match(source, /reasoning_effort:\s*args\.reasoning_effort/);

  const shell = fs.readFileSync(
    path.join(__dirname, "../renderer/views/index.html"),
    "utf8",
  );
  assert.ok(
    shell.indexOf("agent-reasoning-options.js") < shell.indexOf("agents.js"),
    "reasoning helper must load before the agents component",
  );
});
