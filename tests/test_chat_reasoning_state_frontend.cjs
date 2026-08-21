const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let chatReasoningState;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "chat-reasoning-state-tests-"),
  );
  chatReasoningState = await bundleModule(
    "src/patches/frontend/src/lib/utils/chatReasoningState.ts",
    path.join(tempDir, "chatReasoningState.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("chat-state persistence resolves custom agents to their primary base model", () => {
  const models = [
    { id: "GPT-5.6 Sol", name: "GPT-5.6 Sol" },
    { id: "GPT-5.6 Sol Pro", name: "GPT-5.6 Sol Pro" },
    { id: "GPT-5.6 Terra", name: "GPT-5.6 Terra" },
    { id: "GPT-5.6 Luna", name: "GPT-5.6 Luna" },
    {
      id: "agent-sol",
      name: "Sol research agent",
      info: { base_model_id: "GPT-5.6 Sol" },
    },
    {
      id: "agent-pro",
      name: "Pro research agent",
      info: { base_model_id: "GPT-5.6 Sol Pro" },
    },
    {
      id: "agent-terra",
      name: "Terra research agent",
      info: { base_model_id: "GPT-5.6 Terra" },
    },
    {
      id: "agent-luna",
      name: "Luna research agent",
      base_model_id: "GPT-5.6 Luna",
    },
  ];

  for (const [selectedId, expectedBase] of [
    ["agent-sol", "GPT-5.6 Sol"],
    ["agent-pro", "GPT-5.6 Sol Pro"],
    ["agent-terra", "GPT-5.6 Terra"],
    ["agent-luna", "GPT-5.6 Luna"],
  ]) {
    assert.equal(
      chatReasoningState.resolvePrimaryChatStateModelName({
        modelIds: [selectedId],
        models,
      }),
      expectedBase,
    );
  }

  assert.equal(
    chatReasoningState.resolvePrimaryChatStateModelName({
      modelIds: ["GPT-5.6 Sol"],
      models,
    }),
    "GPT-5.6 Sol",
  );
  assert.equal(
    chatReasoningState.resolvePrimaryChatStateModelName({
      modelIds: ["missing-model"],
      models,
    }),
    "missing-model",
  );
  assert.equal(
    chatReasoningState.resolvePrimaryChatStateModelName({
      modelIds: [],
      models,
    }),
    null,
  );
});

test("reasoning state keeps persisted per-model map for detached subagent chats", () => {
  assert.deepEqual(
    chatReasoningState.normalizePersistedReasoningEffortByModel({
      persistedState: {
        reasoning_effort_by_model: {
          "0": "max",
          "1": "high",
          " ": "medium",
          "2": "",
        },
      },
      selectedModelIds: ["gpt-5.4"],
    }),
    {
      "0": "max",
      "1": "high",
    },
  );
});

test("legacy reasoning effort falls back to model indexes rather than model ids", () => {
  assert.deepEqual(
    chatReasoningState.normalizePersistedReasoningEffortByModel({
      persistedState: {
        reasoning_effort: "medium",
      },
      selectedModelIds: ["gpt-5.4", "atlas-sonnet-4.6"],
    }),
    {
      "0": "medium",
      "1": "medium",
    },
  );
});

test("non-reasoning chats keep reasoning badges empty", () => {
  assert.deepEqual(
    chatReasoningState.normalizePersistedReasoningEffortByModel({
      persistedState: {
        reasoning_effort_by_model: {},
        reasoning_effort: null,
      },
      selectedModelIds: ["atlas-3.5-haiku"],
    }),
    {},
  );
});

test("reasoning state sanitizes and stabilizes per-model maps", () => {
  assert.deepEqual(
    chatReasoningState.sanitizeReasoningEffortByModel({
      "1": " high ",
      "0": "max",
      " ": "medium",
      "2": "",
    }),
    {
      "0": "max",
      "1": "high",
    },
  );

  assert.equal(
    chatReasoningState.reasoningEffortByModelSignature({
      "1": "high",
      "0": "max",
    }),
    JSON.stringify({
      "0": "max",
      "1": "high",
    }),
  );
});

test("reasoning helper ignores invalid containers and extracts the primary slot only from index zero", () => {
  assert.deepEqual(chatReasoningState.sanitizeReasoningEffortByModel(null), {});
  assert.deepEqual(chatReasoningState.sanitizeReasoningEffortByModel(["max"]), {});
  assert.deepEqual(chatReasoningState.sanitizeReasoningEffortByModel("max"), {});

  assert.equal(
    chatReasoningState.primaryReasoningEffortFromByModel({
      "0": " max ",
      "1": "high",
    }),
    "max",
  );

  assert.equal(
    chatReasoningState.primaryReasoningEffortFromByModel({
      "1": "high",
    }),
    null,
  );
});

test("reasoning option resolution prefers explicit valid values, otherwise low, then medium, then the first valid option", () => {
  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: "high",
      allowedOptions: ["low", "medium", "high", "max"],
    }),
    "high",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: "invalid",
      allowedOptions: ["low", "medium", "high"],
    }),
    "low",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: null,
      allowedOptions: ["medium", "high", "max"],
    }),
    "medium",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: null,
      allowedOptions: ["high", "max"],
    }),
    "high",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: "xhigh",
      allowedOptions: ["low", "medium", "high", "xhigh", "max"],
    }),
    "xhigh",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortFromAllowedOptions({
      explicitReasoningEffort: "max",
      allowedOptions: [{ value: "max" }],
    }),
    null,
  );
});

test("effective reasoning resolution keeps explicit selections and defaults missing slots to low when supported", () => {
  assert.equal(
    chatReasoningState.resolveReasoningEffortByModelEntry({
      reasoningEffortByModel: { "0": "max" },
      modelIndex: 0,
      allowedOptions: ["low", "medium", "high", "max"],
    }),
    "max",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortByModelEntry({
      reasoningEffortByModel: {},
      modelIndex: 0,
      allowedOptions: ["low", "medium", "high", "max"],
    }),
    "low",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortByModelEntry({
      reasoningEffortByModel: {},
      modelIndex: 0,
      allowedOptions: ["medium", "high", "max"],
    }),
    "medium",
  );

  assert.equal(
    chatReasoningState.resolveReasoningEffortByModelEntry({
      reasoningEffortByModel: {},
      modelIndex: 0,
      allowedOptions: null,
    }),
    null,
  );
});

test("GUI-capped reasoning state downgrades persisted Ultra values to Max", () => {
  const guiOptions = ["none", "low", "medium", "high", "xhigh", "max"];

  assert.equal(
    chatReasoningState.resolveReasoningEffortByModelEntry({
      reasoningEffortByModel: { "0": "ultra" },
      modelIndex: 0,
      allowedOptions: guiOptions,
    }),
    "max",
  );

  assert.deepEqual(
    chatReasoningState.resolveReasoningEffortByModelSnapshot({
      reasoningEffortByModel: { "0": "ultra" },
      allowedOptionsByModelIndex: { "0": guiOptions },
    }),
    { "0": "max" },
  );

  assert.deepEqual(
    chatReasoningState.normalizeExplicitReasoningEffortByModel({
      reasoningEffortByModel: { "0": "ultra" },
      allowedOptionsByModelIndex: { "0": guiOptions },
      selectedModelCount: 1,
    }),
    { "0": "max" },
  );

  assert.deepEqual(
    chatReasoningState.normalizeTransientReasoningEffortByModel({
      reasoningEffortByModel: { "0": "ultra" },
      allowedOptionsByModelIndex: { "0": guiOptions },
    }),
    { "0": "max" },
  );
});

test("reasoning snapshots materialize effective defaults without mutating transient state", () => {
  assert.deepEqual(
    chatReasoningState.resolveReasoningEffortByModelSnapshot({
      reasoningEffortByModel: { "0": "max" },
      allowedOptionsByModelIndex: {
        "0": ["low", "medium", "high", "max"],
        "1": ["low", "medium", "high", "max"],
      },
    }),
    {
      "0": "max",
      "1": "low",
    },
  );

  assert.deepEqual(
    chatReasoningState.normalizeTransientReasoningEffortByModel({
      reasoningEffortByModel: {
        "0": "invalid",
        "1": "high",
        "2": "max",
      },
      allowedOptionsByModelIndex: {
        "0": ["low", "medium", "high", "max"],
        "1": ["low", "medium", "high", "max"],
      },
    }),
    {
      "0": "low",
      "1": "high",
    },
  );
});

test("persisted reasoning state honors an explicit empty per-model map over any legacy fallback", () => {
  assert.deepEqual(
    chatReasoningState.normalizePersistedReasoningEffortByModel({
      persistedState: {
        reasoning_effort_by_model: {},
        reasoning_effort: "max",
      },
      selectedModelIds: ["gpt-5.4"],
    }),
    {},
  );
});

test("explicit reasoning normalization drops invalid slots without materializing medium", () => {
  assert.deepEqual(
    chatReasoningState.normalizeExplicitReasoningEffortByModel({
      reasoningEffortByModel: {
        "0": "max",
        "1": "invalid",
        "2": "high",
      },
      allowedOptionsByModelIndex: {
        "0": ["low", "medium", "high", "max"],
        "1": ["low", "medium", "high", "max"],
      },
      selectedModelCount: 2,
    }),
    {
      "0": "max",
    },
  );

  assert.deepEqual(
    chatReasoningState.normalizeExplicitReasoningEffortByModel({
      reasoningEffortByModel: {
        "0": "max",
      },
      allowedOptionsByModelIndex: {},
      selectedModelCount: 1,
    }),
    {
      "0": "max",
    },
  );

  assert.deepEqual(
    chatReasoningState.normalizeExplicitReasoningEffortByModel({
      reasoningEffortByModel: {
        "0": "max",
        "1": "medium",
        "2": "high",
        "3": "low",
      },
      allowedOptionsByModelIndex: {
        "0": ["low", "medium", "high", "max"],
        "1": [],
        "2": ["low", "medium", "high"],
      },
      selectedModelCount: 3,
    }),
    {
      "0": "max",
      "2": "high",
    },
  );
});

// ---- model-identity ledger (agent-switch effort sync) ------------------------

test("switching agents re-seeds the slot from the new agent's configured effort", () => {
  const {
    rebuildReasoningEffortSelectionState
  } = chatReasoningState;

  const allowed = {
    "agent-a": ["low", "medium", "high", "xhigh", "max"],
    "agent-b": ["none", "low", "medium", "high", "xhigh", "max"]
  };

  const first = rebuildReasoningEffortSelectionState({
    ledger: {},
    modelIds: ["agent-a"],
    configuredEffortByModelId: { "agent-a": "xhigh" },
    allowedOptionsByModelId: allowed
  });
  assert.deepEqual(first.reasoningEffortByModel, { 0: "xhigh" });

  // The regression this guards: xhigh is ALSO legal for agent-b's base model,
  // but the slot must show agent-b's configured medium after the switch.
  const second = rebuildReasoningEffortSelectionState({
    ledger: first.ledger,
    modelIds: ["agent-b"],
    configuredEffortByModelId: { "agent-b": "medium" },
    allowedOptionsByModelId: allowed
  });
  assert.deepEqual(second.reasoningEffortByModel, { 0: "medium" });
});

test("an explicit choice survives switching away and back", () => {
  const {
    primeReasoningEffortLedger,
    rebuildReasoningEffortSelectionState
  } = chatReasoningState;

  const allowed = {
    "agent-a": ["low", "medium", "high", "xhigh"],
    "agent-b": ["low", "medium", "high", "xhigh"]
  };
  const configured = { "agent-a": "xhigh", "agent-b": "medium" };

  let ledger = primeReasoningEffortLedger({
    ledger: {},
    modelIds: ["agent-b"],
    reasoningEffortByModel: { 0: "high" },
    explicit: true
  });

  const away = rebuildReasoningEffortSelectionState({
    ledger,
    modelIds: ["agent-a"],
    configuredEffortByModelId: configured,
    allowedOptionsByModelId: allowed
  });
  assert.deepEqual(away.reasoningEffortByModel, { 0: "xhigh" });

  const back = rebuildReasoningEffortSelectionState({
    ledger: away.ledger,
    modelIds: ["agent-b"],
    configuredEffortByModelId: configured,
    allowedOptionsByModelId: allowed
  });
  assert.deepEqual(back.reasoningEffortByModel, { 0: "high" });
  assert.equal(back.ledger["agent-b"].explicit, true);
});

test("ledger values invalid for the model coerce (ultra cap) or re-seed", () => {
  const {
    primeReasoningEffortLedger,
    rebuildReasoningEffortSelectionState
  } = chatReasoningState;

  const ultraLedger = primeReasoningEffortLedger({
    ledger: {},
    modelIds: ["sol-agent"],
    reasoningEffortByModel: { 0: "ultra" }
  });
  const capped = rebuildReasoningEffortSelectionState({
    ledger: ultraLedger,
    modelIds: ["sol-agent"],
    configuredEffortByModelId: {},
    allowedOptionsByModelId: { "sol-agent": ["low", "medium", "high", "max"] }
  });
  assert.deepEqual(capped.reasoningEffortByModel, { 0: "max" });

  const invalidLedger = primeReasoningEffortLedger({
    ledger: {},
    modelIds: ["small-agent"],
    reasoningEffortByModel: { 0: "xhigh" }
  });
  const reseeded = rebuildReasoningEffortSelectionState({
    ledger: invalidLedger,
    modelIds: ["small-agent"],
    configuredEffortByModelId: { "small-agent": "high" },
    allowedOptionsByModelId: { "small-agent": ["low", "medium", "high"] }
  });
  assert.deepEqual(reseeded.reasoningEffortByModel, { 0: "high" });
});

test("prime associates by slot, never downgrades explicit, and remove deletes", () => {
  const {
    primeReasoningEffortLedger,
    removeReasoningEffortLedgerEntry
  } = chatReasoningState;

  let ledger = primeReasoningEffortLedger({
    ledger: {},
    modelIds: ["agent-a", "agent-b"],
    reasoningEffortByModel: { 0: "low", 1: "max" },
    explicit: true
  });
  assert.deepEqual(ledger, {
    "agent-a": { value: "low", explicit: true },
    "agent-b": { value: "max", explicit: true }
  });

  ledger = primeReasoningEffortLedger({
    ledger,
    modelIds: ["agent-a"],
    reasoningEffortByModel: { 0: "medium" },
    explicit: false
  });
  assert.deepEqual(ledger["agent-a"], { value: "medium", explicit: true });

  ledger = removeReasoningEffortLedgerEntry(ledger, "agent-a");
  assert.equal(ledger["agent-a"], undefined);
  assert.ok(ledger["agent-b"]);
});

test("models without a reasoning control get no entry; fallback chain applies otherwise", () => {
  const { rebuildReasoningEffortSelectionState } = chatReasoningState;

  const result = rebuildReasoningEffortSelectionState({
    ledger: {},
    modelIds: ["no-reasoning-model", "plain-agent"],
    configuredEffortByModelId: {},
    allowedOptionsByModelId: { "plain-agent": ["medium", "high"] }
  });
  assert.deepEqual(result.reasoningEffortByModel, { 1: "medium" });
  assert.equal(result.ledger["no-reasoning-model"], undefined);
});
