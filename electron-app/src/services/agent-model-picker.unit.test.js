const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const picker = require("../renderer/components/agent-model-picker");

const ROOT = path.resolve(__dirname, "../../..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const MODELS = [
  { id: "Claude Opus 4.8", picker_provider: "anthropic", picker_tier: "heavy" },
  { id: "Claude Sonnet 5", picker_provider: "anthropic", picker_tier: "general" },
  { id: "GPT-5.5", picker_provider: "openai", picker_tier: "heavy" },
  { id: "GPT-5.6 Luna", picker_provider: "openai", picker_tier: "lightweight" },
  { id: "GPT-5.6 Sol Pro", picker_provider: "openai", picker_tier: "premium", disabled: true, disabled_reason: "High cost" },
  { id: "GPT-5.6 Sol", picker_provider: "openai", picker_tier: "heavy" },
  { id: "GPT-5.6 Terra", picker_provider: "openai", picker_tier: "general" },
  { id: "Gemini 3.1 Pro Preview", picker_provider: "google", picker_tier: "premium" },
  { id: "local/qwen", name: "Qwen local", is_local: true, disabled: true },
  { id: "hidden", picker_provider: "openai", picker_tier: "general", hidden: true },
  { id: "text-embedding-3-large" },
];

test("agent picker preserves provider order, guide tiers, source stability, and the GPT-5.5 tail", () => {
  assert.deepEqual(
    picker.sortModels(MODELS).map((model) => model.id),
    [
      "Claude Sonnet 5",
      "Claude Opus 4.8",
      "GPT-5.6 Terra",
      "GPT-5.6 Sol",
      "GPT-5.6 Sol Pro",
      "GPT-5.6 Luna",
      "GPT-5.5",
      "Gemini 3.1 Pro Preview",
      "local/qwen",
    ],
  );
  assert.deepEqual(picker.TIER_ORDER, ["general", "heavy", "premium", "lightweight"]);
});

test("agent picker search covers name, id, provider, description, and fuzzy subsequences", () => {
  const searchable = MODELS.map((model) => ({
    ...model,
    description: model.id === "Claude Opus 4.8" ? "Complex architecture work" : "",
  }));

  assert.deepEqual(
    picker.filterModels(searchable, "architecture").map((model) => model.id),
    ["Claude Opus 4.8"],
  );
  assert.ok(picker.filterModels(searchable, "anthropic sonnet").some((model) => model.id === "Claude Sonnet 5"));
  assert.ok(picker.filterModels(searchable, "gmni pro").some((model) => model.id === "Gemini 3.1 Pro Preview"));
  assert.equal(picker.filterModels(searchable, "definitely absent").length, 0);
});

test("agent picker groups only visible models and provides theme-aware local branding", () => {
  const groups = picker.groupModels(picker.sortModels(MODELS));
  assert.deepEqual(groups.map((group) => group.provider), ["anthropic", "openai", "google", "local"]);
  assert.equal(groups.flatMap((group) => group.items).some((model) => model.id === "hidden"), false);
  assert.equal(
    groups.flatMap((group) => group.items).some((model) => model.id === "text-embedding-3-large"),
    false,
  );
  assert.deepEqual(picker.modelLogoSources({ id: "GPT-5.6 Terra", picker_provider: "openai" }), {
    light: "../assets/terra.png",
    dark: null,
  });
  assert.deepEqual(picker.modelLogoSources({ id: "local/qwen", is_local: true }), {
    light: "../assets/local-model-light.svg",
    dark: "../assets/local-model-dark.svg",
  });
});

test("agent picker renderer contract includes validation, retry, keyboard, and cleanup behavior", () => {
  const source = read("electron-app/src/renderer/components/agent-model-picker.js");
  const agents = read("electron-app/src/renderer/components/agents.js");
  const shell = read("electron-app/src/renderer/views/index.html");

  assert.match(source, /type="hidden" name="base_model_id"/);
  assert.match(source, /aria-haspopup="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /ArrowUp/);
  assert.match(source, /Escape/);
  assert.match(source, /agent-model-picker-retry/);
  assert.match(source, /agent-model-picker-detach/);
  assert.match(source, /isUnavailableSelection/);
  assert.match(source, /setInvalid/);
  assert.match(agents, /function buildAgentForm\(agent = null, catalogs = state\.catalogs, \{ isEdit = Boolean\(agent\) \} = \{\}\)/);
  // Create/edit renders inline on the control plane; teardown must fire the
  // picker detach events so document-level listeners are released.
  assert.match(agents, /class="agent-editor-inline-body"/);
  assert.match(agents, /function teardownAgentEditor\(\)/);
  assert.match(agents, /agentModelPickerApi\.mount\(modelPickerContainer/);
  assert.ok(
    shell.indexOf("agent-model-picker.js") < shell.indexOf("agents.js"),
    "picker helper must load before the shared create/edit controller",
  );
});

test("agent editor is wide, sectioned, responsive, and explicitly themed", () => {
  const agents = read("electron-app/src/renderer/components/agents.js");
  const styles = read("electron-app/src/styles.css");

  assert.match(agents, /Identity and access/);
  assert.match(agents, /Model and behavior/);
  assert.match(agents, /Capabilities/);
  assert.match(styles, /\.agents-modal-agent-editor\s*\{[^}]*width:\s*min\(1120px,/s);
  assert.match(styles, /\.agent-editor-model-grid\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\[data-theme="light"\] \.agents-modal-agent-editor/);
  assert.match(styles, /\[data-theme="dark"\] \.agent-model-logo-light/);
  assert.match(styles, /@media \(max-width: 820px\)/);
});

test("Electron local-model assets remain byte-identical to the OWUI assets", () => {
  for (const asset of ["local-model-light.svg", "local-model-dark.svg"]) {
    assert.deepEqual(
      fs.readFileSync(path.join(ROOT, "electron-app/assets", asset)),
      fs.readFileSync(path.join(ROOT, "src/patches/frontend/static", asset)),
      asset,
    );
  }
});
