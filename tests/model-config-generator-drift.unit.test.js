const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GENERATOR = path.join(ROOT, "src/scripts/generate-model-config.cjs");
const CATALOG = path.join(ROOT, "model_catalog.yaml");
const GENERATED = path.join(
  ROOT,
  "src/patches/frontend/src/lib/config/model-capabilities.ts",
);
const NODE_PATH = path.join(ROOT, "electron-app/node_modules");

function runGenerator(args, outputPath = GENERATED, inputPath = CATALOG) {
  return spawnSync(process.execPath, [GENERATOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH,
      MODEL_CONFIG_INPUT_PATH: inputPath,
      MODEL_CONFIG_OUTPUT_PATH: outputPath,
    },
  });
}

test("checked-in model capabilities match the generator", () => {
  const result = runGenerator(["--check"]);

  assert.equal(
    result.status,
    0,
    `generator drift check failed:\n${result.stdout}\n${result.stderr}`,
  );
  const generated = fs.readFileSync(GENERATED, "utf8");
  assert.match(
    generated,
    /Generated at build time by src\/scripts\/generate-model-config\.cjs/,
  );
  assert.match(
    generated,
    /Run: node src\/scripts\/generate-model-config\.cjs/,
  );
  assert.doesNotMatch(generated, /generate-model-config\.js/);
});

test("generator rejects selectable models without valid picker metadata", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-config-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "model_catalog.yaml");
  const outputPath = path.join(tempDir, "model-capabilities.ts");
  const catalog = fs.readFileSync(CATALOG, "utf8");

  fs.writeFileSync(
    inputPath,
    catalog.replace(
      /\n    picker:\n      provider: anthropic\n      tier: general/,
      "",
    ),
  );
  const missing = runGenerator([], outputPath, inputPath);
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /missing picker metadata/);

  fs.writeFileSync(inputPath, catalog.replace("provider: anthropic", "provider: unknown"));
  const invalid = runGenerator([], outputPath, inputPath);
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /invalid picker\.provider 'unknown'/);
});

test("generator check mode rejects stale output without rewriting it", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-drift-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputPath = path.join(tempDir, "model-capabilities.ts");
  fs.writeFileSync(outputPath, "stale\n");

  const stale = runGenerator(["--check"], outputPath);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Generated model config is out of date/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "stale\n");

  const generated = runGenerator([], outputPath);
  assert.equal(
    generated.status,
    0,
    `generator failed:\n${generated.stdout}\n${generated.stderr}`,
  );
  const refreshed = fs.readFileSync(outputPath, "utf8");
  assert.match(refreshed, /generate-model-config\.cjs/);

  const current = runGenerator(["--check"], outputPath);
  assert.equal(
    current.status,
    0,
    `fresh output failed drift check:\n${current.stdout}\n${current.stderr}`,
  );
});
