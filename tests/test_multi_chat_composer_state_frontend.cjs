// Behavioral tests for the multi-chat composer focus-swap helpers: pane
// runtime snapshots/signatures, the muxed composer view state, the enriched
// cross-pane request context (fast-mode service tier + reasoning effort),
// the write-back command filter, and the draft-pollution guard.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let mod;

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
    path.join(os.tmpdir(), "multi-chat-composer-state-tests-"),
  );
  mod = await bundleModule(
    "src/patches/frontend/src/lib/utils/multiChatComposerState.ts",
    path.join(tempDir, "multiChatComposerState.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const MODELS = [
  { id: "GPT-5.6 Sol", name: "GPT-5.6 Sol" },
  { id: "Claude Sonnet 5", name: "Claude Sonnet 5" },
  {
    id: "agent-sol",
    name: "Sol research agent",
    info: { base_model_id: "GPT-5.6 Sol" },
  },
];

const runtimeInput = (overrides = {}) => ({
  isStreaming: false,
  selectedModelIds: ["GPT-5.6 Sol"],
  pendingWork: { version: 3, updated_at: "t1" },
  title: "Reviewer",
  reasoningEffortByModel: { 0: "high" },
  resolvedReasoningEffortByModel: { 0: "high" },
  reasoningEffortReady: true,
  fastModeEnabled: true,
  params: { temperature: 0.4 },
  contextTokens: 1234,
  costMetrics: {
    cost: 2.88,
    costWithoutCache: 4,
    cacheSavings: 1.12,
    savingsRate: 0.28,
    cachedTokens: 10,
    cacheReadTokens: 8,
    cacheWriteTokens: 2,
  },
  activeCapabilities: {
    tools: [{ server_id: "srv-1", id: "tool-a" }],
    skills: [{ id: "skill-1" }],
  },
  ...overrides,
});

const primaryView = () => ({
  selectedModels: ["Claude Sonnet 5"],
  reasoningEffortByModel: { 0: "low" },
  reasoningEffortReady: true,
  fastModeEnabled: false,
  contextTokens: 777,
  costMetrics: {
    cost: 9.15,
    costWithoutCache: 9.15,
    cacheSavings: 0,
    savingsRate: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  activeCapabilities: { tools: [], skills: [] },
});

test("cross-pane context carries the GPT target's fast mode as service_tier", () => {
  const runtime = mod.buildPaneRuntimeSnapshot(runtimeInput());
  const context = mod.buildCrossPaneRequestContext({ runtime, models: MODELS });
  assert.deepEqual(context.selected_model_ids, ["GPT-5.6 Sol"]);
  assert.equal(context.params.service_tier, "priority");
  assert.equal(context.params.temperature, 0.4);
  assert.deepEqual(context.reasoning_effort_by_model, { 0: "high" });
  assert.equal(
    context.selected_model_items["GPT-5.6 Sol"].name,
    "GPT-5.6 Sol",
  );
  assert.deepEqual(context.background_tasks, {
    title_generation: true,
    tags_generation: true,
    follow_up_generation: true,
  });
  assert.equal("tool_ids" in context, false);
  assert.equal("features" in context, false);
});

test("agents on a GPT base qualify for the cross-pane service tier", () => {
  const runtime = mod.buildPaneRuntimeSnapshot(
    runtimeInput({ selectedModelIds: ["agent-sol"] }),
  );
  const context = mod.buildCrossPaneRequestContext({ runtime, models: MODELS });
  assert.equal(context.params.service_tier, "priority");
});

test("no service tier for non-GPT targets or when the toggle is off", () => {
  const claudeRuntime = mod.buildPaneRuntimeSnapshot(
    runtimeInput({ selectedModelIds: ["Claude Sonnet 5"] }),
  );
  const claudeContext = mod.buildCrossPaneRequestContext({
    runtime: claudeRuntime,
    models: MODELS,
  });
  assert.equal("service_tier" in claudeContext.params, false);
  assert.equal(claudeContext.params.temperature, 0.4);

  const toggledOff = mod.buildPaneRuntimeSnapshot(
    runtimeInput({ fastModeEnabled: false }),
  );
  const offContext = mod.buildCrossPaneRequestContext({
    runtime: toggledOff,
    models: MODELS,
  });
  assert.equal("service_tier" in offContext.params, false);
});

test("cross-pane context tolerates an unpublished runtime", () => {
  const context = mod.buildCrossPaneRequestContext({
    runtime: null,
    models: MODELS,
  });
  assert.deepEqual(context.selected_model_ids, []);
  assert.deepEqual(context.selected_model_items, {});
  assert.deepEqual(context.reasoning_effort_by_model, {});
  assert.deepEqual(context.params, {});
});

test("unknown target models still dispatch with an empty model item", () => {
  const runtime = mod.buildPaneRuntimeSnapshot(
    runtimeInput({ selectedModelIds: ["deleted-model"], fastModeEnabled: false }),
  );
  const context = mod.buildCrossPaneRequestContext({ runtime, models: MODELS });
  assert.deepEqual(context.selected_model_ids, ["deleted-model"]);
  assert.deepEqual(context.selected_model_items["deleted-model"], {});
});

test("composer view state passes the primary through when no tile is focused", () => {
  const primary = primaryView();
  const view = mod.deriveComposerViewState({
    crossPaneActive: false,
    runtime: mod.buildPaneRuntimeSnapshot(runtimeInput()),
    primary,
  });
  assert.equal(view, primary);
});

test("composer view state shows the focused tile's settings", () => {
  const view = mod.deriveComposerViewState({
    crossPaneActive: true,
    runtime: mod.buildPaneRuntimeSnapshot(runtimeInput()),
    primary: primaryView(),
  });
  assert.deepEqual(view.selectedModels, ["GPT-5.6 Sol"]);
  assert.equal(view.fastModeEnabled, true);
  assert.deepEqual(view.reasoningEffortByModel, { 0: "high" });
  assert.equal(view.reasoningEffortReady, true);
  assert.equal(view.contextTokens, 1234);
  assert.equal(view.costMetrics.cost, 2.88);
  assert.equal(view.activeCapabilities.tools.length, 1);
});

test("a focused tile with no published runtime falls back to EMPTY, never the primary", () => {
  const view = mod.deriveComposerViewState({
    crossPaneActive: true,
    runtime: null,
    primary: primaryView(),
  });
  assert.deepEqual(view.selectedModels, [""]);
  assert.equal(view.fastModeEnabled, false);
  assert.deepEqual(view.reasoningEffortByModel, {});
  assert.equal(view.reasoningEffortReady, false);
  assert.equal(view.contextTokens, 0);
  assert.equal(view.costMetrics.cost, 0);
  assert.deepEqual(view.activeCapabilities, { tools: [], skills: [] });
});

test("pane command filter accepts only newer commands addressed to this chat", () => {
  const command = {
    seq: 5,
    chatId: "chat-a",
    type: "set-fast-mode",
    payload: { enabled: true },
  };
  assert.equal(
    mod.shouldApplyPaneCommand(command, { chatId: "chat-a", lastAppliedSeq: 4 }),
    true,
  );
  assert.equal(
    mod.shouldApplyPaneCommand(command, { chatId: "chat-a", lastAppliedSeq: 5 }),
    false,
  );
  assert.equal(
    mod.shouldApplyPaneCommand(command, { chatId: "chat-b", lastAppliedSeq: 0 }),
    false,
  );
  assert.equal(
    mod.shouldApplyPaneCommand(null, { chatId: "chat-a", lastAppliedSeq: 0 }),
    false,
  );
  assert.equal(
    mod.shouldApplyPaneCommand(command, { chatId: "", lastAppliedSeq: 0 }),
    false,
  );
});

test("runtime signature is stable for equal state and moves for each swapped field", () => {
  const base = mod.buildPaneRuntimeSnapshot(runtimeInput());
  const same = mod.buildPaneRuntimeSnapshot(runtimeInput());
  assert.equal(mod.paneRuntimeSignature(base), mod.paneRuntimeSignature(same));

  const variants = [
    runtimeInput({ fastModeEnabled: false }),
    runtimeInput({ reasoningEffortByModel: { 0: "low" } }),
    runtimeInput({ resolvedReasoningEffortByModel: { 0: "low" } }),
    runtimeInput({ contextTokens: 9999 }),
    runtimeInput({ params: { temperature: 0.9 } }),
    runtimeInput({
      costMetrics: { ...runtimeInput().costMetrics, cost: 3.5 },
    }),
    runtimeInput({
      activeCapabilities: { tools: [], skills: [{ id: "skill-1" }] },
    }),
    runtimeInput({ isStreaming: true }),
    runtimeInput({ selectedModelIds: ["Claude Sonnet 5"] }),
  ];
  for (const variant of variants) {
    assert.notEqual(
      mod.paneRuntimeSignature(mod.buildPaneRuntimeSnapshot(variant)),
      mod.paneRuntimeSignature(base),
    );
  }
});

test("snapshot sanitizes malformed inputs", () => {
  const runtime = mod.buildPaneRuntimeSnapshot({
    isStreaming: "yes",
    selectedModelIds: ["ok", "", 7, null],
    pendingWork: undefined,
    title: 42,
    reasoningEffortByModel: { 0: "high", 1: "", 2: 9 },
    resolvedReasoningEffortByModel: "nope",
    reasoningEffortReady: "true",
    fastModeEnabled: "on",
    params: ["not-an-object"],
    contextTokens: "1200",
    costMetrics: null,
    activeCapabilities: { tools: "x", skills: null },
  });
  assert.equal(runtime.isStreaming, false);
  assert.deepEqual(runtime.selectedModelIds, ["ok"]);
  assert.equal(runtime.pendingWork, null);
  assert.equal(runtime.title, "");
  assert.deepEqual(runtime.reasoningEffortByModel, { 0: "high" });
  assert.deepEqual(runtime.resolvedReasoningEffortByModel, {});
  assert.equal(runtime.reasoningEffortReady, false);
  assert.equal(runtime.fastModeEnabled, false);
  assert.deepEqual(runtime.params, {});
  assert.equal(runtime.contextTokens, 0);
  assert.equal(runtime.costMetrics.cost, 0);
  assert.deepEqual(runtime.activeCapabilities, { tools: [], skills: [] });
});

test("primary draft payload keeps the primary's effort/fast-mode while a tile is focused", () => {
  const data = {
    prompt: "draft text",
    selectedToolIds: ["tool-1"],
    reasoningEffortByModel: { 0: "high" },
    fastModeEnabled: true,
  };
  const guarded = mod.buildPrimaryDraftPayload({
    data,
    crossPaneActive: true,
    primaryReasoningEffortByModel: { 0: "low" },
    primaryFastModeEnabled: false,
  });
  assert.equal(guarded.prompt, "draft text");
  assert.deepEqual(guarded.selectedToolIds, ["tool-1"]);
  assert.deepEqual(guarded.reasoningEffortByModel, { 0: "low" });
  assert.equal(guarded.fastModeEnabled, false);

  const passthrough = mod.buildPrimaryDraftPayload({
    data,
    crossPaneActive: false,
    primaryReasoningEffortByModel: { 0: "low" },
    primaryFastModeEnabled: false,
  });
  assert.equal(passthrough, data);
});

test("model mux guards: transient selections and signatures", () => {
  assert.equal(mod.isTransientModelSelection([""]), true);
  assert.equal(mod.isTransientModelSelection([]), true);
  assert.equal(mod.isTransientModelSelection(undefined), true);
  assert.equal(mod.isTransientModelSelection(["GPT-5.6 Sol"]), false);
  assert.equal(
    mod.modelIdsSignature(["", "GPT-5.6 Sol"]),
    mod.modelIdsSignature(["GPT-5.6 Sol"]),
  );
  assert.notEqual(
    mod.modelIdsSignature(["GPT-5.6 Sol"]),
    mod.modelIdsSignature(["Claude Sonnet 5"]),
  );
});
