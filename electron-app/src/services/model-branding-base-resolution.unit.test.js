// Item 1 (Batch 8): talking to an agent should show the agent's BASE model's
// animated logo, not the generic Portico favicon. The fix resolves the base
// model record at the display call site via resolveBaseModelRecord(). These
// tests exercise the REAL modelBranding.ts (transpiled with esbuild) to lock:
//   - a non-agent model passes through unchanged,
//   - an agent resolves to its base model record from the catalog,
//   - an agent whose base isn't in the catalog falls back to a minimal { id }.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const SRC = path.join(
  __dirname, "..", "..", "..",
  "src", "patches", "frontend", "src", "lib", "utils", "modelBranding.ts",
);

function loadModule() {
  const tsSource = fs.readFileSync(SRC, "utf8");
  const { code } = esbuild.transformSync(tsSource, { loader: "ts", format: "cjs" });
  const module = { exports: {} };
  // modelBranding imports ./modelLogoCache at runtime; resolveBaseModelRecord
  // doesn't touch it, so stub the require to keep the module self-contained.
  const stubRequire = (id) =>
    id.includes("modelLogoCache")
      ? { buildModelLogoUrl: () => "", getModelLogoCacheVersion: () => 0 }
      : require(id);
  new Function("module", "exports", "require", code)(module, module.exports, stubRequire);
  return module.exports;
}

test("resolveBaseModelRecord passes a non-agent model through unchanged", () => {
  const { resolveBaseModelRecord: resolve } = loadModule();
  const plain = { id: "atlas-sonnet-5", name: "Atlas Sonnet 5" };
  const models = [plain, { id: "gpt-5.6", name: "GPT" }];
  assert.equal(resolve(plain, models), plain);
});

test("resolveBaseModelRecord resolves an agent to its base model record", () => {
  const { resolveBaseModelRecord: resolve } = loadModule();
  const base = { id: "gpt-5.6-sol", name: "Sol" };
  const agent = { id: "my-agent", name: "My Agent", info: { base_model_id: "gpt-5.6-sol" } };
  const models = [agent, base, { id: "other" }];
  assert.equal(resolve(agent, models), base);
});

test("resolveBaseModelRecord also reads a top-level base_model_id", () => {
  const { resolveBaseModelRecord: resolve } = loadModule();
  const base = { id: "atlas-opus-4-8", name: "Opus" };
  const agent = { id: "agent-2", base_model_id: "atlas-opus-4-8" };
  assert.deepEqual(resolve(agent, [agent, base]), base);
});

test("resolveBaseModelRecord falls back to a minimal { id } when the base is not in the catalog", () => {
  const { resolveBaseModelRecord: resolve } = loadModule();
  const agent = { id: "agent-3", info: { base_model_id: "gpt-5.6-terra" } };
  // base not present in the catalog → { id } so id-based branding still resolves.
  assert.deepEqual(resolve(agent, [agent]), { id: "gpt-5.6-terra" });
});

test("resolveBaseModelRecord tolerates null/empty inputs", () => {
  const { resolveBaseModelRecord: resolve } = loadModule();
  assert.equal(resolve(null, null), null);
  assert.equal(resolve(undefined, []), undefined);
  const plain = { id: "x" };
  assert.equal(resolve(plain, null), plain); // no base id, no catalog → unchanged
});
