// Item 4: opening a delegated subagent chat must show the reasoning effort the
// chat actually used (persisted as reasoning_effort_by_model {"0": effort}),
// not the low/medium default. The bug was the reactive normalize pruning index
// "0" while selectedModelIds was momentarily empty during load. These tests
// exercise the REAL chatReasoningState.ts (transpiled with esbuild) to lock:
//   - the restore preserves a persisted {"0": effort},
//   - normalizing against an EMPTY selection prunes it (the hazard), and
//   - hasResolvedReasoningModelSelection (the gate) reports readiness correctly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const SRC = path.join(
  __dirname, "..", "..", "..",
  "src", "patches", "frontend", "src", "lib", "utils", "chatReasoningState.ts",
);

function loadModule() {
  const tsSource = fs.readFileSync(SRC, "utf8");
  const { code } = esbuild.transformSync(tsSource, { loader: "ts", format: "cjs" });
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports;
}

test("hasResolvedReasoningModelSelection reports whether a real model is selected", () => {
  const { hasResolvedReasoningModelSelection: hasResolved } = loadModule();
  assert.equal(hasResolved(["Atlas Sonnet 5"]), true);
  assert.equal(hasResolved(["", "GPT-5.6 Sol"]), true);
  // Not yet resolved (the delegated-chat load window):
  assert.equal(hasResolved([]), false);
  assert.equal(hasResolved([""]), false);
  assert.equal(hasResolved(["   "]), false);
  assert.equal(hasResolved(null), false);
  assert.equal(hasResolved(undefined), false);
  assert.equal(hasResolved("Atlas Sonnet 5"), false); // not an array
});

test("restore preserves a persisted reasoning_effort_by_model even before models resolve", () => {
  const { normalizePersistedReasoningEffortByModel: restore } = loadModule();
  // The delegated subagent chat persisted {"0":"high"}; opening it (selectedModelIds
  // still empty) must keep it — this is what makes the picker show the real effort.
  assert.deepEqual(
    restore({ persistedState: { reasoning_effort_by_model: { "0": "high" } }, selectedModelIds: [] }),
    { "0": "high" },
  );
  // Legacy single-value form also restores to index 0.
  assert.deepEqual(
    restore({ persistedState: { reasoning_effort: "medium" }, selectedModelIds: [] }),
    { "0": "medium" },
  );
  assert.deepEqual(restore({ persistedState: null, selectedModelIds: [] }), {});
});

test("normalizing against an EMPTY selection prunes index 0 (the bug the gate avoids)", () => {
  const { normalizeExplicitReasoningEffortByModel: normalize } = loadModule();
  // selectedModelCount 0 => index "0" (0 >= 0) is dropped. This is exactly why the
  // reactive block must be gated on hasResolvedReasoningModelSelection.
  assert.deepEqual(
    normalize({
      reasoningEffortByModel: { "0": "high" },
      allowedOptionsByModelIndex: {},
      selectedModelCount: 0,
    }),
    {},
  );
});

test("seedReasoningEffortFromParams fills index 0 from chat params when unset", () => {
  const { seedReasoningEffortFromParams: seed } = loadModule();
  // Delegated subagent chat: chat-state unreadable (empty map) -> seed from the
  // chat record's params.reasoning_effort so the effort still shows.
  assert.deepEqual(seed({}, { reasoning_effort: "high" }), { "0": "high" });
  assert.deepEqual(seed({}, { reasoning_effort: "  medium  " }), { "0": "medium" });
});

test("seedReasoningEffortFromParams never overrides an existing entry or seeds junk", () => {
  const { seedReasoningEffortFromParams: seed } = loadModule();
  const existing = { "0": "low" };
  // Existing explicit entry wins (returns the same reference -> no-op write).
  assert.equal(seed(existing, { reasoning_effort: "high" }), existing);
  // No/empty/non-string params -> unchanged (same reference).
  const empty = {};
  assert.equal(seed(empty, {}), empty);
  assert.equal(seed(empty, null), empty);
  assert.equal(seed(empty, { reasoning_effort: "" }), empty);
  assert.equal(seed(empty, { reasoning_effort: 5 }), empty);
});

// "Chat.svelte gates the reasoning normalize on a resolved model selection"
// lived here as a SOURCE-PIN test (regexes over the 294KB Chat.svelte). Source
// pins are banned (AGENTS.md "Testing Rules"), and this one was actively
// harmful: when the reasoning-ledger refactor replaced the pinned call inside
// the gate with rebuildReasoningEffortSelectionState, the failing assertion
// embedded the whole component source in its TAP diagnostic, which wedges the
// Node 20.19 test-runner parent on CI (job 219411331 sat silent to the 1h
// timeout). The behavior it guarded lives behaviorally in this file:
//   - the gate function itself ("hasResolvedReasoningModelSelection reports
//     whether a real model is selected"),
//   - the hazard the gate exists to avoid ("normalizing against an EMPTY
//     selection prunes index 0"),
//   - the delegated-chat seeding contract (the seedReasoningEffortFromParams
//     tests), and
//   - the gated reactive's NEW body, rebuildReasoningEffortSelectionState
//     (the tests below).

test("rebuild keeps a ledger effort with its model and preserves explicitness", () => {
  const { rebuildReasoningEffortSelectionState: rebuild } = loadModule();
  const { reasoningEffortByModel, ledger } = rebuild({
    ledger: { "gpt-a": { value: "high", explicit: true } },
    modelIds: ["gpt-a"],
    configuredEffortByModelId: { "gpt-a": "low" },
    allowedOptionsByModelId: { "gpt-a": ["low", "medium", "high"] },
  });
  // The value this chat already resolved wins over the agent's configured
  // default, and its explicit flag survives the rebuild.
  assert.deepEqual(reasoningEffortByModel, { "0": "high" });
  assert.deepEqual(ledger["gpt-a"], { value: "high", explicit: true });
});

test("rebuild re-seeds a slot whose model changed from the NEW agent's configured effort", () => {
  const { rebuildReasoningEffortSelectionState: rebuild } = loadModule();
  const { reasoningEffortByModel, ledger } = rebuild({
    ledger: { "gpt-a": { value: "high", explicit: true } },
    modelIds: ["gpt-b"],
    configuredEffortByModelId: { "gpt-b": "medium" },
    allowedOptionsByModelId: { "gpt-b": ["low", "medium"] },
  });
  assert.deepEqual(reasoningEffortByModel, { "0": "medium" });
  assert.deepEqual(ledger["gpt-b"], { value: "medium", explicit: false });
  // The old model's resolved effort stays in the ledger, ready to travel back
  // if the slot returns to gpt-a.
  assert.deepEqual(ledger["gpt-a"], { value: "high", explicit: true });
});

test("rebuild validates efforts against each model's allowed options", () => {
  const { rebuildReasoningEffortSelectionState: rebuild } = loadModule();
  // A ledger value the new model does not allow falls back to the configured
  // effort (validated the same way) instead of leaking an invalid option.
  const fallback = rebuild({
    ledger: { "gpt-b": { value: "max", explicit: true } },
    modelIds: ["gpt-b"],
    configuredEffortByModelId: { "gpt-b": "low" },
    allowedOptionsByModelId: { "gpt-b": ["low", "medium"] },
  });
  assert.deepEqual(fallback.reasoningEffortByModel, { "0": "low" });
  assert.deepEqual(fallback.ledger["gpt-b"], { value: "low", explicit: false });

  // A model with no reasoning options contributes no slot at all.
  const optionless = rebuild({
    ledger: {},
    modelIds: ["gpt-plain"],
    configuredEffortByModelId: {},
    allowedOptionsByModelId: {},
  });
  assert.deepEqual(optionless.reasoningEffortByModel, {});
});

test("rebuild keys multi-model selections by slot index", () => {
  const { rebuildReasoningEffortSelectionState: rebuild } = loadModule();
  const { reasoningEffortByModel } = rebuild({
    ledger: { "gpt-a": { value: "high", explicit: true } },
    modelIds: ["gpt-a", "gpt-b", ""],
    configuredEffortByModelId: { "gpt-b": "medium" },
    allowedOptionsByModelId: {
      "gpt-a": ["low", "high"],
      "gpt-b": ["low", "medium"],
    },
  });
  // Slot 0 travels with gpt-a's ledger entry, slot 1 seeds from gpt-b's
  // configured effort, and the unresolved third slot stays absent.
  assert.deepEqual(reasoningEffortByModel, { "0": "high", "1": "medium" });
});

test("normalizing with a resolved selection preserves the real effort", () => {
  const { normalizeExplicitReasoningEffortByModel: normalize } = loadModule();
  assert.deepEqual(
    normalize({
      reasoningEffortByModel: { "0": "high" },
      allowedOptionsByModelIndex: { "0": ["low", "medium", "high", "max"] },
      selectedModelCount: 1,
    }),
    { "0": "high" },
  );
  // An effort not in the model's allowed options is coerced/dropped, not shown raw.
  assert.deepEqual(
    normalize({
      reasoningEffortByModel: { "0": "high" },
      allowedOptionsByModelIndex: { "0": ["low", "medium"] },
      selectedModelCount: 1,
    }),
    {},
  );
});
