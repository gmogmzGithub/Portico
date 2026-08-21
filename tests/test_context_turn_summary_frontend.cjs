// Behavioral coverage for the composer context gauge: turn-summary
// normalization, occupancy derivation, ULTRA usage fallback, and the shared
// model-window resolution. Replaces the retired source-pin test block in
// owui-debug-monitor.unit.test.js ("cost reporting source wires turn
// summaries...").
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");
const FRONTEND_SRC = "src/patches/frontend/src/lib";

let tempDir;
let contextTurnSummary;
let usageTokens;
let modelContextWindow;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
    alias: {
      $lib: path.join(REPO_ROOT, FRONTEND_SRC),
    },
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "context-turn-summary-tests-"),
  );
  contextTurnSummary = await bundleModule(
    `${FRONTEND_SRC}/utils/context-turn-summary.mjs`,
    path.join(tempDir, "context-turn-summary.cjs"),
  );
  usageTokens = await bundleModule(
    `${FRONTEND_SRC}/utils/usage-tokens.mjs`,
    path.join(tempDir, "usage-tokens.cjs"),
  );
  modelContextWindow = await bundleModule(
    `${FRONTEND_SRC}/utils/model-context-window.ts`,
    path.join(tempDir, "model-context-window.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeChatTurnSummary prefers contextTokens and falls back to promptTokens", () => {
  const { normalizeChatTurnSummary, createEmptyChatTurnSummary } =
    contextTurnSummary;

  assert.deepEqual(
    normalizeChatTurnSummary({
      promptTokens: 913410,
      contextTokens: 61000,
      requestCount: 3,
    }),
    { promptTokens: 913410, contextTokens: 61000, requestCount: 3 },
  );

  // Older Electron hosts omit contextTokens entirely.
  assert.deepEqual(
    normalizeChatTurnSummary({ promptTokens: 250, requestCount: 2 }),
    { promptTokens: 250, contextTokens: 250, requestCount: 2 },
  );

  assert.deepEqual(normalizeChatTurnSummary(undefined), {
    promptTokens: 0,
    contextTokens: 0,
    requestCount: 0,
  });
  assert.deepEqual(createEmptyChatTurnSummary(), {
    promptTokens: 0,
    contextTokens: 0,
    requestCount: 0,
  });
});

test("deriveContextUsage orders context estimate over billed peak over history", () => {
  const { deriveContextUsage } = contextTurnSummary;

  // Pro-mode shape: billed 913k, real occupancy 61k.
  assert.deepEqual(
    deriveContextUsage({
      turnSummary: { promptTokens: 913410, contextTokens: 61000 },
      historyUsage: { prompt_tokens: 999999 },
    }),
    { prompt_tokens: 61000 },
  );

  assert.deepEqual(
    deriveContextUsage({
      turnSummary: { promptTokens: 250, contextTokens: 0 },
      historyUsage: { prompt_tokens: 999999 },
    }),
    { prompt_tokens: 250 },
  );

  const historyUsage = { prompt_tokens: 4200 };
  assert.equal(
    deriveContextUsage({
      turnSummary: { promptTokens: 0, contextTokens: 0 },
      historyUsage,
    }),
    historyUsage,
  );

  assert.equal(deriveContextUsage({ turnSummary: undefined }), null);
});

test("getDisplayTokenCountFromUsage prefers non-cumulative context_tokens (ULTRA usage)", () => {
  const { getDisplayTokenCountFromUsage } = usageTokens;

  // ULTRA final usage: prompt_tokens is summed across rounds for spend;
  // context_tokens carries the last round's real occupancy.
  assert.equal(
    getDisplayTokenCountFromUsage({
      prompt_tokens: 900000,
      completion_tokens: 500,
      context_tokens: 61000,
    }),
    61000,
  );

  assert.equal(
    getDisplayTokenCountFromUsage({ prompt_tokens: 250, completion_tokens: 10 }),
    250,
  );
  assert.equal(getDisplayTokenCountFromUsage({ total_tokens: 300 }), 300);
  assert.equal(getDisplayTokenCountFromUsage(undefined), 0);
});

test("getLatestContextUsageFromHistory surfaces the ULTRA context figure through the walk", () => {
  const { getLatestContextUsageFromHistory, getDisplayContextTokenCount } =
    usageTokens;

  const messages = {
    "user-1": { role: "user", parentId: null },
    "assistant-1": {
      role: "assistant",
      parentId: "user-1",
      usage: { prompt_tokens: 900000, context_tokens: 61000 },
    },
    "user-2": { role: "user", parentId: "assistant-1" },
  };
  const usage = getLatestContextUsageFromHistory(messages, "user-2");
  assert.equal(usage.context_tokens, 61000);
  assert.equal(
    getDisplayContextTokenCount({ usage, persistedMaxContextTokens: 1050000 }),
    61000,
  );

  // The persisted-window clamp still applies as a sanity guard.
  assert.equal(
    getDisplayContextTokenCount({
      usage: { prompt_tokens: 500000 },
      persistedMaxContextTokens: 200000,
    }),
    200000,
  );
});

test("resolveModelMaxContextTokens matches the capability table and agent base models", () => {
  const { resolveModelMaxContextTokens, DEFAULT_MODEL_CONTEXT_WINDOW } =
    modelContextWindow;

  const models = [
    { id: "sol-pro", name: "GPT-5.6 Sol Pro" },
    {
      id: "custom-agent",
      name: "My Custom Agent",
      info: { base_model_id: "sol-pro" },
    },
    {
      id: "meta-override",
      name: "Override Agent",
      info: { meta: { max_context_tokens: 42000 } },
    },
  ];

  assert.equal(resolveModelMaxContextTokens(models, ["sol-pro"]), 1050000);
  // Custom agents resolve through their base model instead of the 128k
  // default that used to cap their gauge.
  assert.equal(resolveModelMaxContextTokens(models, ["custom-agent"]), 1050000);
  assert.equal(resolveModelMaxContextTokens(models, ["meta-override"]), 42000);
  assert.equal(
    resolveModelMaxContextTokens(models, ["sol-pro", "custom-agent"]),
    DEFAULT_MODEL_CONTEXT_WINDOW,
  );
  assert.equal(
    resolveModelMaxContextTokens(models, ["missing"]),
    DEFAULT_MODEL_CONTEXT_WINDOW,
  );
  assert.equal(
    resolveModelMaxContextTokens(undefined, undefined),
    DEFAULT_MODEL_CONTEXT_WINDOW,
  );
});
