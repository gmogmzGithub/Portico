const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let chatFastModeState;

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
    path.join(os.tmpdir(), "chat-fast-mode-state-tests-"),
  );
  chatFastModeState = await bundleModule(
    "src/patches/frontend/src/lib/utils/chatFastModeState.ts",
    path.join(tempDir, "chatFastModeState.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const MODELS = [
  { id: "GPT-5.6 Sol", name: "GPT-5.6 Sol" },
  { id: "GPT-5.6 Luna", name: "GPT-5.6 Luna" },
  { id: "Atlas Sonnet 4.6", name: "Atlas Sonnet 4.6" },
  { id: "Gemini 3.5 Flash", name: "Gemini 3.5 Flash" },
  {
    id: "agent-sol",
    name: "Sol research agent",
    info: { base_model_id: "GPT-5.6 Sol" },
  },
  {
    id: "agent-atlas",
    // Deceptive GPT-looking name on a Atlas base: the base must win.
    name: "GPT-5.6 Sol",
    info: { base_model_id: "Atlas Sonnet 4.6" },
  },
  {
    id: "agent-bare-base",
    name: "Bare-base agent",
    base_model_id: "gpt-5.6-luna",
  },
];

const modelById = (id) => MODELS.find((model) => model.id === id);

test("the tier literal stays 'priority' until the llm-proxy aliases 'fast'", () => {
  assert.equal(chatFastModeState.FAST_MODE_SERVICE_TIER, "priority");
});

test("sanitizers accept only strict booleans", () => {
  assert.equal(chatFastModeState.sanitizeFastModeEnabled(true), true);
  for (const junk of [false, 1, 0, "true", "on", {}, [], null, undefined]) {
    assert.equal(chatFastModeState.sanitizeFastModeEnabled(junk), false);
  }

  assert.equal(
    chatFastModeState.normalizePersistedFastMode({ fast_mode: true }),
    true,
  );
  for (const state of [
    { fast_mode: "true" },
    { fast_mode: 1 },
    {},
    null,
    undefined,
  ]) {
    assert.equal(chatFastModeState.normalizePersistedFastMode(state), false);
  }
});

test("GPT detection resolves base models first and rejects other providers", () => {
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("GPT-5.6 Sol"), MODELS),
    true,
  );
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("GPT-5.6 Luna"), MODELS),
    true,
  );
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("Atlas Sonnet 4.6"), MODELS),
    false,
  );
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("Gemini 3.5 Flash"), MODELS),
    false,
  );

  // Agent on a GPT base qualifies regardless of its display name.
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("agent-sol"), MODELS),
    true,
  );
  // Agent with a GPT-looking name on a Atlas base must NOT qualify.
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("agent-atlas"), MODELS),
    false,
  );
  // Top-level base_model_id (no info envelope) also resolves.
  assert.equal(
    chatFastModeState.isGptFastModeModel(modelById("agent-bare-base"), MODELS),
    true,
  );

  assert.equal(chatFastModeState.isGptFastModeModel(null, MODELS), false);
  assert.equal(chatFastModeState.isGptFastModeModel(undefined, MODELS), false);
  assert.equal(
    chatFastModeState.isGptFastModeModel({ id: "mystery", name: "mystery" }, MODELS),
    false,
  );
});

test("hasGptFastModeModel any-matches selections and bare ids", () => {
  assert.equal(
    chatFastModeState.hasGptFastModeModel(
      ["Atlas Sonnet 4.6", "GPT-5.6 Luna"],
      MODELS,
    ),
    true,
  );
  assert.equal(
    chatFastModeState.hasGptFastModeModel(["Atlas Sonnet 4.6"], MODELS),
    false,
  );
  assert.equal(
    chatFastModeState.hasGptFastModeModel(["agent-sol"], MODELS),
    true,
  );
  // Bare id not present in the loaded model list still resolves via aliases.
  assert.equal(
    chatFastModeState.hasGptFastModeModel(["gpt-5.6-luna"], []),
    true,
  );
  assert.equal(chatFastModeState.hasGptFastModeModel([], MODELS), false);
  assert.equal(chatFastModeState.hasGptFastModeModel("GPT-5.6 Sol", MODELS), false);
  assert.equal(chatFastModeState.hasGptFastModeModel(null, MODELS), false);
});

test("deriveServiceTierParam yields 'priority' only for enabled GPT slots", () => {
  assert.equal(
    chatFastModeState.deriveServiceTierParam({
      fastModeEnabled: true,
      model: modelById("GPT-5.6 Sol"),
      models: MODELS,
    }),
    "priority",
  );
  assert.equal(
    chatFastModeState.deriveServiceTierParam({
      fastModeEnabled: true,
      model: modelById("agent-sol"),
      models: MODELS,
    }),
    "priority",
  );
  assert.equal(
    chatFastModeState.deriveServiceTierParam({
      fastModeEnabled: true,
      model: modelById("Atlas Sonnet 4.6"),
      models: MODELS,
    }),
    undefined,
  );
  assert.equal(
    chatFastModeState.deriveServiceTierParam({
      fastModeEnabled: false,
      model: modelById("GPT-5.6 Sol"),
      models: MODELS,
    }),
    undefined,
  );
  for (const nonBoolean of ["true", 1, {}, null, undefined]) {
    assert.equal(
      chatFastModeState.deriveServiceTierParam({
        fastModeEnabled: nonBoolean,
        model: modelById("GPT-5.6 Sol"),
        models: MODELS,
      }),
      undefined,
    );
  }
});
